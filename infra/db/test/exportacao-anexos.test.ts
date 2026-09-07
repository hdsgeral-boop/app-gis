/**
 * F10.3 — exportação de anexos.
 *
 * O que se prova aqui é o critério da fase: os ficheiros ficam **ligados aos
 * registos por caminho relativo**. Um manifesto em que dois anexos do mesmo
 * registo caíssem no mesmo caminho perderia um deles sem dar erro — e é por
 * isso que a numeração tem um teste só para ela.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7, type Field, type FormDefinition } from '@cvforms/form-core';

import {
  guiaoDeDescarga,
  lerAnexosParaExportacao,
  manifestoCsv,
  type AnexoExportado,
} from '../src/exports/index.js';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const projeto = randomUUID();
const form = randomUUID();
const versao = randomUUID();
const registo = uuidv7();
const registoApagado = uuidv7();

const DEFINICAO: FormDefinition = {
  spec_version: 1,
  form_id: form,
  version: 1,
  title: { pt: 'Vistoria' },
  fields: [
    { id: 'f_foto', name: 'fotografia', type: 'photo', label: { pt: 'Fotografia do PT' } } as Field,
    { id: 'f_ass', name: 'assinatura', type: 'signature', label: { pt: 'Assinatura' } } as Field,
  ],
} as FormDefinition;

async function criarAnexo(
  recordId: string,
  fieldId: string,
  mime: string | null,
  estado = 'concluido',
) {
  const id = uuidv7();
  await sql`
    INSERT INTO attachments (id, record_id, field_id, mime_type, hash, bytes, upload_state, storage_key)
    VALUES (${id}, ${recordId}, ${fieldId}, ${mime}, ${'a'.repeat(64)}, 1024,
            ${estado}::attachment_state, ${estado === 'concluido' ? `${org}/aa/aa/${id}` : null})
  `;
  return id;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });

  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'x' + org.slice(0, 8)}, 'Org')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projeto}, ${org}, ${'p' + projeto.slice(0, 6)}, 'P')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title)
            VALUES (${form}, ${org}, ${projeto}, ${'f' + form.slice(0, 6)}, ${sql.json({ pt: 'V' })})`;
  await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
            VALUES (${versao}, ${form}, 1, ${JSON.stringify(DEFINICAO)}::text::jsonb, 'sha256:x', now())`;

  for (const id of [registo, registoApagado]) {
    await sql`INSERT INTO records (id, org_id, project_id, form_id, form_version_id)
              VALUES (${id}, ${org}, ${projeto}, ${form}, ${versao})`;
  }
  await sql`UPDATE records SET deleted_at = now() WHERE id = ${registoApagado}`;

  // Duas fotografias no mesmo campo do mesmo registo: é o caso em que um
  // manifesto ingénuo escreveria as duas por cima uma da outra.
  await criarAnexo(registo, 'f_foto', 'image/jpeg');
  await criarAnexo(registo, 'f_foto', 'image/jpeg');
  await criarAnexo(registo, 'f_ass', 'image/png');
  // Um anexo ainda por subir e um de tipo desconhecido.
  await criarAnexo(registo, 'f_foto', 'image/jpeg', 'pendente');
  await criarAnexo(registo, 'f_ass', null);
  // De um registo apagado: não sai.
  await criarAnexo(registoApagado, 'f_foto', 'image/jpeg');
}, 120_000);

afterAll(async () => {
  if (!url) return;
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM attachments WHERE record_id IN (${registo}, ${registoApagado})`;
  await sql`DELETE FROM records WHERE form_id = ${form}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${form}`;
  await sql`DELETE FROM forms WHERE id = ${form}`;
  await sql`DELETE FROM projects WHERE id = ${projeto}`;
  await sql`DELETE FROM organizations WHERE id = ${org}`;
  await sql?.end();
}, 120_000);

suite('F10.3 — manifesto de anexos', () => {
  let anexos: AnexoExportado[] = [];

  beforeAll(async () => {
    if (!url) return;
    anexos = await lerAnexosParaExportacao(sql, form, DEFINICAO);
  });

  it('só saem os anexos já no armazenamento', async () => {
    // Um `pendente` no manifesto daria um 404 a meio de um download de três
    // horas, e quem o corre não perceberia porquê.
    expect(anexos).toHaveLength(4);
    expect(anexos.every((a) => a.storage_key)).toBe(true);
  });

  it('os anexos de um registo apagado não saem', () => {
    expect(anexos.some((a) => a.record_id === registoApagado)).toBe(false);
  });

  it('o caminho leva o rótulo do campo, e não o id interno', () => {
    // Quem abre a pasta é uma pessoa. `f_foto` não lhe diz nada.
    const caminhos = anexos.map((a) => a.caminho);
    expect(caminhos).toContain(`anexos/${registo}/fotografia_do_pt.jpg`);
    expect(caminhos.some((c) => c.includes('f_foto'))).toBe(false);
  });

  it('dois ficheiros do mesmo campo não caem no mesmo caminho', () => {
    const caminhos = anexos.map((a) => a.caminho);
    expect(new Set(caminhos).size).toBe(caminhos.length);
    expect(caminhos).toContain(`anexos/${registo}/fotografia_do_pt-2.jpg`);
  });

  it('um tipo desconhecido sai como .bin em vez de adivinhar', () => {
    const semTipo = anexos.find((a) => a.mime_type === null);
    expect(semTipo?.caminho.endsWith('.bin')).toBe(true);
  });

  it('o caminho liga ao registo pelo mesmo id que o CSV exporta', () => {
    // É isto que torna a exportação utilizável: abrir o CSV, ler o
    // `record_id`, e encontrar a pasta.
    for (const anexo of anexos) {
      expect(anexo.caminho.startsWith(`anexos/${anexo.record_id}/`)).toBe(true);
    }
  });
});

suite('F10.3 — o que se entrega a quem exporta', () => {
  it('o guião de descarga só inclui o que tem URL', async () => {
    const anexos = await lerAnexosParaExportacao(sql, form, DEFINICAO);
    const comUrl = anexos.map((a, i) =>
      i === 0 ? a : { ...a, url: `https://exemplo/${a.storage_key}` },
    );
    const guiao = guiaoDeDescarga(comUrl);

    expect(guiao).toContain('#!/bin/sh');
    // `-C -` retoma o que ficou a meio; numa ligação de campo isso acontece.
    expect(guiao).toContain('-C -');
    expect(guiao).toContain('--create-dirs');
    expect(guiao.split('curl').length - 1).toBe(3);
  });

  it('o manifesto CSV abre no Excel português e não leva URLs', async () => {
    const anexos = (await lerAnexosParaExportacao(sql, form, DEFINICAO)).map((a) => ({
      ...a,
      url: 'https://exemplo/assinado?X-Amz-Signature=segredo',
    }));
    const csv = manifestoCsv(anexos);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Identificador do registo;Campo;Caminho');
    expect(csv).toContain('\r\n');
    // Um URL assinado dentro de um ficheiro arquivado é um segredo que ninguém
    // sabe que tem.
    expect(csv).not.toContain('X-Amz-Signature');
  });
});
