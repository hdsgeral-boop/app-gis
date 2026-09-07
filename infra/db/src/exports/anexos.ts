import { buildIndex, type FormDefinition, type LocalizedText } from '@cvforms/form-core';
import type postgres from 'postgres';

/**
 * Exportação de anexos (F10.3).
 *
 * O QUE ISTO NÃO FAZ, e porquê: não empacota um ZIP. Um formulário de campo
 * com um ano de trabalho tem dezenas de milhares de fotografias e vários
 * gigabytes; passá-los pela API para os embrulhar contradiz a decisão que
 * governa toda a F9 — o ficheiro não passa pela API (F9.3). Ter a API a
 * segurar uma ligação durante meia hora por cada exportação é a forma mais
 * rápida de a deitar abaixo, e é a mesma razão pela qual o upload é directo.
 *
 * O que sai é um **manifesto**: uma linha por anexo, com o caminho relativo
 * onde o ficheiro deve ficar e o URL assinado de onde o descarregar. Quem
 * exporta corre o guião e fica com uma árvore de pastas que o CSV e o GeoJSON
 * já referenciam pelo mesmo caminho relativo — que é o critério da F10.3.
 *
 * O caminho é `anexos/<record_id>/<nome do campo>[-n].<ext>`:
 *   - `record_id` porque é o que liga ao CSV, e é estável;
 *   - o **nome** do campo, e não o `id`, porque quem abre a pasta é uma pessoa;
 *   - o sufixo `-n` só quando o mesmo campo tem mais do que um ficheiro.
 */

export interface AnexoExportado {
  record_id: string;
  field_id: string;
  /** Nome legível do campo, como aparece no CSV. */
  campo: string;
  /** `anexos/<record_id>/<campo>.jpg` — relativo à raiz da exportação. */
  caminho: string;
  storage_key: string;
  mime_type: string | null;
  bytes: number | null;
  hash: string | null;
  /** Preenchido por quem tiver como assinar; o `@cvforms/db` não assina nada. */
  url?: string;
}

/**
 * Extensão a partir do MIME.
 *
 * Deliberadamente curta: só os tipos que a API aceita. Um mapa exaustivo seria
 * uma tabela de MIME types a manter para nada — o que não estiver aqui sai com
 * `.bin`, e um `.bin` é honesto.
 */
const EXTENSAO: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
};

/**
 * Só os anexos concluídos.
 *
 * Um anexo `pendente` é um ficheiro que ainda não existe no armazenamento; pô-lo
 * no manifesto daria um erro 404 a meio de um download de três horas, e quem o
 * corre não ia perceber porquê.
 */
export async function lerAnexosParaExportacao(
  sql: postgres.Sql,
  formId: string,
  definition: FormDefinition,
  idioma = 'pt',
): Promise<AnexoExportado[]> {
  const linhas = await sql<
    Array<{
      record_id: string;
      field_id: string;
      storage_key: string;
      mime_type: string | null;
      bytes: number | null;
      hash: string | null;
    }>
  >`
    SELECT a.record_id, a.field_id, a.storage_key, a.mime_type, a.bytes, a.hash
    FROM attachments a
    JOIN records r ON r.id = a.record_id
    WHERE r.form_id = ${formId}
      AND r.deleted_at IS NULL
      AND a.upload_state = 'concluido'
      AND a.storage_key IS NOT NULL
    ORDER BY a.record_id, a.field_id, a.created_at, a.id
  `;

  const nomes = nomesPorCampo(definition, idioma);
  // Conta quantos ficheiros já saíram deste (registo, campo) para só numerar
  // quando é mesmo preciso: `fotografia.jpg` lê-se melhor do que
  // `fotografia-1.jpg` quando só há uma.
  const vistos = new Map<string, number>();

  return linhas.map((l) => {
    const campo = nomes.get(l.field_id) ?? l.field_id;
    const chave = `${l.record_id}/${l.field_id}`;
    const n = vistos.get(chave) ?? 0;
    vistos.set(chave, n + 1);

    const extensao = EXTENSAO[l.mime_type ?? ''] ?? '.bin';
    const sufixo = n === 0 ? '' : `-${n + 1}`;
    return {
      record_id: l.record_id,
      field_id: l.field_id,
      campo,
      caminho: `anexos/${l.record_id}/${limparNome(campo)}${sufixo}${extensao}`,
      storage_key: l.storage_key,
      mime_type: l.mime_type,
      bytes: l.bytes,
      hash: l.hash,
    };
  });
}

/**
 * Guião que descarrega tudo, para quem tem de ir buscar milhares de ficheiros.
 *
 * `curl` e não `wget`: vem com o macOS e com o Windows 10 desde 2018, e o
 * `wget` não vem com nenhum dos dois. `--create-dirs` faz a árvore sozinho, e
 * `-C -` retoma um download interrompido — que numa ligação de Luanda acontece.
 */
export function guiaoDeDescarga(anexos: AnexoExportado[]): string {
  const linhas = [
    '#!/bin/sh',
    '# Descarrega os anexos desta exportação para a pasta onde este guião estiver.',
    '#',
    '# Os URLs são assinados e EXPIRAM — se der 403, gera a exportação outra vez.',
    '# Podes correr isto mais do que uma vez: o -C - retoma o que ficou a meio e',
    '# não volta a descarregar o que já está completo.',
    'set -e',
    '',
  ];
  for (const anexo of anexos) {
    if (!anexo.url) continue;
    linhas.push(`curl -fsSL --create-dirs -C - -o '${anexo.caminho}' '${anexo.url}'`);
  }
  linhas.push('', `echo 'anexos descarregados: ${anexos.filter((a) => a.url).length}'`);
  return linhas.join('\n') + '\n';
}

/** Manifesto em CSV, com as mesmas escolhas do resto das exportações. */
export function manifestoCsv(anexos: AnexoExportado[]): string {
  const escapar = (v: unknown) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /["\n\r]|[;,\t]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const linhas = [
    ['Identificador do registo', 'Campo', 'Caminho', 'Tipo', 'Bytes', 'SHA-256'].join(';'),
    ...anexos.map((a) =>
      [a.record_id, a.campo, a.caminho, a.mime_type, a.bytes, a.hash].map(escapar).join(';'),
    ),
  ];
  return `﻿${linhas.join('\r\n')}\r\n`;
}

function nomesPorCampo(definition: FormDefinition, idioma: string): Map<string, string> {
  const index = buildIndex(definition);
  const mapa = new Map<string, string>();
  for (const { field } of index.order) {
    mapa.set(field.id, texto(field.label, idioma) ?? field.name);
  }
  return mapa;
}

function texto(rotulo: LocalizedText | undefined, idioma: string): string | undefined {
  if (!rotulo) return undefined;
  return rotulo[idioma] ?? rotulo.pt;
}

/**
 * Um nome de campo que sirva de nome de ficheiro em qualquer sistema.
 *
 * O Windows recusa `\\ / : * ? " < > |`, e um nome com acentos numa pen
 * formatada em FAT32 — que é o que se usa para levar dados para uma reunião —
 * pode sair trocado. Acentos fora, resto para minúsculas, e nunca vazio.
 */
function limparNome(nome: string): string {
  const semAcentos = nome.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const limpo = semAcentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return limpo || 'anexo';
}
