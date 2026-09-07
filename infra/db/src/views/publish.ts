import { createHash } from 'node:crypto';

import {
  diffDefinitions,
  validateDefinition,
  type FormDefinition,
  type FormDiff,
  type ValidationIssue,
} from '@cvforms/form-core';
import type postgres from 'postgres';

import { generateViews, VIEWS_SCHEMA, type GenerateViewsResult } from './generate.js';
import { quoteIdentifier } from './identifiers.js';

/**
 * Pipeline de publicação de uma versão (ESPECIFICACAO.md §5).
 *
 * Ou corre tudo, ou não corre nada. É uma só transacção, e é deliberado: uma
 * publicação a meio deixaria vistas de uma versão que não está gravada, ou uma
 * versão gravada sem as vistas que o QGIS espera — e ninguém saberia qual das
 * duas até alguém abrir o QGIS.
 *
 * O que este ficheiro NÃO faz: apagar registos. Arquivar um formulário apaga as
 * vistas; os dados ficam todos, para sempre (restrição inegociável 4).
 */

export interface PublishInput {
  definition: FormDefinition;
  formId: string;
  projectKey: string;
  formKey: string;
  publishedBy?: string | null;
  /**
   * Versão anterior, para o diff. Ausente na primeira publicação.
   */
  previous?: FormDefinition;
  /**
   * O administrador confirmou as alterações incompatíveis. Sem isto, uma
   * alteração incompatível recusa a publicação (FORM-SPEC §9).
   */
  confirmIncompatible?: boolean;
  /** `form_id` acessíveis, para validar campos `reference`. */
  knownFormIds?: readonly string[];
}

export interface PublishResult {
  ok: boolean;
  /** `id` da linha criada em `form_versions`. */
  formVersionId?: string;
  hash?: string;
  diff?: FormDiff;
  views?: GenerateViewsResult;
  /** Problemas que impediram a publicação. */
  issues: ValidationIssue[];
}

/** SHA-256 da definição canonicalizada. É o que a app compara para saber se mudou. */
export function definitionHash(definition: FormDefinition): string {
  return `sha256:${createHash('sha256').update(canonicalJson(definition)).digest('hex')}`;
}

/**
 * JSON canónico: chaves ordenadas, sem espaços.
 *
 * Sem isto, reordenar duas propriedades no editor mudava o hash e todos os
 * telefones do país descarregavam outra vez a mesma definição — por uma rede
 * que se paga ao megabyte.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface FormManifest {
  form_id: string;
  version: number;
  /** Hash da definição. A app não volta a descarregar se for igual. */
  hash: string;
  published_at: string | null;
  /** Listas de escolha embutidas, com hash próprio. */
  choice_lists: Array<{ key: string; count: number; hash: string }>;
  /** Anexos de media que a app precisa de ter antes de ir para o mato. */
  media: Array<{ field_id: string; kind: string }>;
  /** Vistas geradas, para quem liga o QGIS saber onde ir. */
  views: Array<{ schema: string; name: string; repeat_field_id: string | null }>;
}

export function buildManifest(
  definition: FormDefinition,
  views: GenerateViewsResult,
  publishedAt: string | null,
): FormManifest {
  const choiceLists = Object.entries(definition.choice_lists ?? {}).map(([key, choices]) => ({
    key,
    count: choices.length,
    hash: `sha256:${createHash('sha256').update(canonicalJson(choices)).digest('hex')}`,
  }));

  const media: FormManifest['media'] = [];
  const visitar = (fields: FormDefinition['fields']): void => {
    for (const field of fields) {
      if (field.type === 'group' || field.type === 'repeat') {
        visitar(field.fields);
        continue;
      }
      if (['photo', 'audio', 'file', 'signature'].includes(field.type)) {
        media.push({ field_id: field.id, kind: field.type });
      }
    }
  };
  visitar(definition.fields);

  return {
    form_id: definition.form_id,
    version: definition.version,
    hash: definitionHash(definition),
    published_at: publishedAt,
    choice_lists: choiceLists,
    media,
    views: views.views.map((v) => ({
      schema: views.schema,
      name: v.name,
      repeat_field_id: v.repeatFieldId,
    })),
  };
}

/**
 * Publica uma versão. Tudo dentro de uma transacção.
 *
 * Passos, pela ordem da §5: validar, calcular o diff, gravar a versão, gerar as
 * vistas, registar os índices, registar o que se criou. O manifesto sai daqui
 * para quem o quiser servir.
 */
export async function publishVersion(
  sql: postgres.Sql,
  input: PublishInput,
): Promise<PublishResult> {
  // 1. Validar. Fora da transacção de propósito: não há nada para desfazer, e
  // uma definição inválida não deve sequer abrir uma transacção.
  const validation = validateDefinition(
    input.definition,
    input.knownFormIds ? { knownFormIds: input.knownFormIds } : {},
  );
  if (!validation.valid) {
    return { ok: false, issues: validation.issues.filter((i) => i.severity === 'erro') };
  }

  // 2. Diff e classificação.
  const diff = input.previous ? diffDefinitions(input.previous, input.definition) : undefined;
  if (diff && !diff.compatible && input.confirmIncompatible !== true) {
    return {
      ok: false,
      diff,
      issues: diff.entries
        .filter((e) => e.classification === 'incompativel')
        .map((e) => ({
          code: e.code,
          severity: 'erro' as const,
          path: e.path,
          message: `${e.message} Confirma explicitamente para publicar mesmo assim.`,
        })),
    };
  }

  const views = generateViews({
    definition: input.definition,
    projectKey: input.projectKey,
    formKey: input.formKey,
    formId: input.formId,
    formVersionId: '00000000-0000-0000-0000-000000000000', // substituído dentro da transacção
  });

  const hash = definitionHash(input.definition);

  const formVersionId = await sql.begin(async (tx) => {
    // 3. Gravar a versão. O rascunho deste formulário desaparece dentro da
    // mesma transacção: se a publicação falhar, o rascunho fica de pé e
    // ninguém perde o trabalho de desenho. O trigger só impede apagar versões
    // já publicadas.
    await tx`DELETE FROM form_versions WHERE form_id = ${input.formId} AND published_at IS NULL`;
    // Imutável a partir daqui, garantido por trigger.
    // `::text::jsonb`, e os dois casts são precisos.
    //
    // Não se usa o `sql.json()` do driver porque este ficheiro é uma
    // biblioteca que recebe o cliente de quem a chama: o `sql.json()` embrulha
    // o valor num objecto que o driver só reconhece por `instanceof`, e quando
    // a API e este pacote carregam cópias diferentes do módulo `postgres` o
    // `instanceof` falha e sai um ERR_INVALID_ARG_TYPE que não aponta para
    // nada.
    //
    // E não basta `::jsonb`: com esse cast o Postgres descreve o parâmetro
    // COMO jsonb, o driver serializa a string outra vez, e o que fica gravado
    // é uma string JSON dentro de um jsonb — `jsonb_typeof` devolve 'string'
    // em vez de 'object', e todas as vistas passam a devolver NULL. O
    // `::text::jsonb` força o parâmetro a texto e o Postgres faz a conversão.
    const [linha] = await tx<Array<{ id: string }>>`
      INSERT INTO form_versions (id, form_id, version, definition, hash, published_at, published_by)
      VALUES (gen_random_uuid(), ${input.formId}, ${input.definition.version},
              ${JSON.stringify(input.definition)}::text::jsonb, ${hash}, now(), ${input.publishedBy ?? null})
      RETURNING id
    `;
    const versionId = linha!.id;

    // As vistas precisam do UUID real da versão, que só existe agora.
    const finais = generateViews({
      definition: input.definition,
      projectKey: input.projectKey,
      formKey: input.formKey,
      formId: input.formId,
      formVersionId: versionId,
    });

    // 4. Vistas. A `_actual` da versão anterior é substituída; as vistas
    // versionadas antigas ficam intactas, e é isso que faz a v(n) continuar a
    // responder depois de sair a v(n+1).
    for (const view of finais.views) {
      await tx.unsafe(view.dropSql);
      await tx.unsafe(view.createSql);
      for (const comment of view.commentSql) await tx.unsafe(comment);
    }

    // 5. Índices dos campos pesquisáveis.
    for (const index of finais.indexes) await tx.unsafe(index.createSql);

    // 6. Registar o que foi criado, para o arquivo saber o que apagar sem
    // adivinhar por nome.
    await tx`DELETE FROM generated_views WHERE form_version_id = ${versionId}`;
    for (const view of finais.views) {
      await tx`
        INSERT INTO generated_views (id, form_id, form_version_id, schema_name, view_name, repeat_field_id, kind)
        VALUES (gen_random_uuid(), ${input.formId}, ${view.isActual ? null : versionId},
                ${finais.schema}, ${view.name}, ${view.repeatFieldId}, 'view')
        ON CONFLICT (schema_name, view_name) DO UPDATE
          SET form_version_id = EXCLUDED.form_version_id, repeat_field_id = EXCLUDED.repeat_field_id
      `;
    }

    // 7. A versão corrente do formulário passa a ser esta.
    await tx`UPDATE forms SET current_version = ${input.definition.version} WHERE id = ${input.formId}`;

    views.views = finais.views;
    views.indexes = finais.indexes;
    return versionId;
  });

  return {
    ok: true,
    formVersionId,
    hash,
    ...(diff ? { diff } : {}),
    views,
    issues: validation.issues,
  };
}

/**
 * Arquiva um formulário: apaga as vistas geradas e marca `archived_at`.
 *
 * Não apaga um único registo nem uma única revisão. Se alguém desarquivar, as
 * vistas voltam a nascer da definição — os dados nunca dependeram delas.
 */
export async function archiveForm(sql: postgres.Sql, formId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const vistas = await tx<Array<{ schema_name: string; view_name: string }>>`
      SELECT schema_name, view_name FROM generated_views WHERE form_id = ${formId}
    `;
    for (const vista of vistas) {
      await tx.unsafe(
        `DROP VIEW IF EXISTS ${quoteIdentifier(vista.schema_name)}.${quoteIdentifier(vista.view_name)};`,
      );
    }
    await tx`DELETE FROM generated_views WHERE form_id = ${formId}`;
    await tx`UPDATE forms SET archived_at = now() WHERE id = ${formId}`;
    return vistas.length;
  });
}

export { VIEWS_SCHEMA };
