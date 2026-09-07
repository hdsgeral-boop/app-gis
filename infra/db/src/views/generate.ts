import {
  buildIndex,
  typeOfField,
  type Field,
  type FormDefinition,
  type FormIndex,
  type InferredType,
} from '@cvforms/form-core';

import {
  IdentifierAllocator,
  quoteIdentifier,
  quoteLiteral,
  sanitizeIdentifier,
  viewName,
} from './identifiers.js';

/**
 * Gerador das vistas tipadas (ESPECIFICACAO.md §3, decisão C).
 *
 * A verdade canónica das respostas está em JSONB e o esquema físico nunca muda
 * ao publicar um formulário. Estas vistas são a projecção tipada por cima, e é
 * a elas que o QGIS, o ArcGIS e o Power BI se ligam como se fossem tabelas.
 *
 * Este ficheiro só PRODUZ SQL; não fala com base de dados nenhuma. É o que
 * permite testar o gerador — incluindo a injecção — sem Postgres a correr, e é
 * o que permite ao painel pré-visualizar o SQL antes de publicar.
 */

export const VIEWS_SCHEMA = 'cvf_views';

export interface GenerateViewsInput {
  definition: FormDefinition;
  /** `key` do projecto e do formulário: dão nome às vistas. */
  projectKey: string;
  formKey: string;
  /** UUID da linha em `form_versions`. Filtra a vista da versão. */
  formVersionId: string;
  /** UUID do formulário. Filtra a vista `_actual`. */
  formId: string;
}

export interface GeneratedColumn {
  name: string;
  /** Tipo SQL declarado da coluna, para documentação e testes. */
  sqlType: string;
  /** `id` do campo de onde veio, ou `null` nas colunas de sistema. */
  fieldId: string | null;
  expression: string;
}

export interface GeneratedView {
  name: string;
  /** `null` na vista raiz; caminho de `id` de repetíveis nas vistas-filhas. */
  repeatPath: string[] | null;
  repeatFieldId: string | null;
  /** `true` na vista `_actual`. */
  isActual: boolean;
  columns: GeneratedColumn[];
  createSql: string;
  commentSql: string[];
  dropSql: string;
}

export interface GeneratedIndex {
  name: string;
  fieldId: string;
  createSql: string;
  dropSql: string;
}

export interface GenerateViewsResult {
  schema: string;
  views: GeneratedView[];
  indexes: GeneratedIndex[];
}

/** Tipo SQL de cada tipo inferido pelo `form-core`. */
const SQL_TYPE: Record<InferredType, string> = {
  texto: 'text',
  numero: 'numeric',
  inteiro: 'integer',
  booleano: 'boolean',
  data: 'date',
  hora: 'time',
  instante: 'timestamptz',
  lista_de_texto: 'text[]',
  geometria: 'geometry',
  // Um cálculo cujo tipo não se consegue decidir vira texto: o texto lê-se
  // sempre, e um número mal adivinhado estraga somas em silêncio.
  desconhecido: 'text',
};

const CONVERSOR: Record<string, string> = {
  text: 'to_text',
  numeric: 'to_numeric',
  integer: 'to_integer',
  boolean: 'to_boolean',
  date: 'to_date',
  time: 'to_time',
  timestamptz: 'to_timestamptz',
  'text[]': 'to_text_array',
  uuid: 'to_uuid',
};

/** Colunas de sistema da vista raiz. São iguais para todos os formulários. */
const COLUNAS_DE_SISTEMA: ReadonlyArray<[string, string, string]> = [
  ['record_id', 'uuid', 'rec.id'],
  ['org_id', 'uuid', 'rec.org_id'],
  ['project_id', 'uuid', 'rec.project_id'],
  ['form_id', 'uuid', 'rec.form_id'],
  ['status', 'record_status', 'rec.status'],
  ['geom', 'geometry(Point,4326)', 'rec.geom'],
  ['created_at', 'timestamptz', 'rec.created_at'],
  ['updated_at', 'timestamptz', 'rec.updated_at'],
  ['created_by', 'uuid', 'rec.created_by'],
  ['client_created_at', 'timestamptz', 'rec.client_created_at'],
  ['revision_id', 'uuid', 'rev.id'],
  ['revision_no', 'integer', 'rev.revision_no'],
  ['server_received_at', 'timestamptz', 'rev.server_received_at'],
  ['author_id', 'uuid', 'rev.author_id'],
  ['device_id', 'text', 'rev.device_id'],
];

export function generateViews(input: GenerateViewsInput): GenerateViewsResult {
  const index = buildIndex(input.definition);
  const views: GeneratedView[] = [];

  for (const versao of ['versao', 'actual'] as const) {
    views.push(rootView(input, index, versao === 'actual'));
    for (const caminho of repeatPaths(index)) {
      views.push(childView(input, index, caminho, versao === 'actual'));
    }
  }

  return { schema: VIEWS_SCHEMA, views, indexes: searchIndexes(index) };
}

/** Caminhos de repetíveis, do mais raso para o mais fundo. */
function repeatPaths(index: FormIndex): string[][] {
  const caminhos: string[][] = [];
  for (const id of index.repeats.keys()) {
    const caminho: string[] = [];
    let atual: string | undefined = id;
    while (atual !== undefined) {
      caminho.unshift(atual);
      atual = index.parentScope.get(atual);
    }
    caminhos.push(caminho);
  }
  return caminhos.sort((a, b) => a.length - b.length || a.join('/').localeCompare(b.join('/')));
}

function rootView(input: GenerateViewsInput, index: FormIndex, isActual: boolean): GeneratedView {
  const nome = viewName({
    project: input.projectKey,
    form: input.formKey,
    version: isActual ? 'actual' : input.definition.version,
  });

  const allocator = new IdentifierAllocator(COLUNAS_DE_SISTEMA.map(([n]) => n));
  const colunas: GeneratedColumn[] = COLUNAS_DE_SISTEMA.map(([name, sqlType, expression]) => ({
    name,
    sqlType,
    fieldId: null,
    expression,
  }));

  if (isActual) {
    // A `_actual` mostra TODOS os registos do formulário, projectados com as
    // colunas da versão corrente — não só os da versão corrente. Um técnico de
    // SIG quer uma camada por formulário, não uma por versão publicada, e um
    // registo antigo aparece com NULL nos campos que ainda não existiam. A
    // coluna `form_version` diz sempre com que versão foi recolhido.
    allocator.allocate('form_version');
    colunas.push({
      name: 'form_version',
      sqlType: 'integer',
      fieldId: null,
      expression: 'fv.version',
    });
  }

  colunas.push(...fieldColumns(index, index.definition.fields, 'rev.data', allocator));

  const de = isActual
    ? [
        'public.records rec',
        'JOIN public.record_revisions rev ON rev.id = rec.current_revision_id',
        'JOIN public.form_versions fv ON fv.id = rec.form_version_id',
      ]
    : [
        'public.records rec',
        'JOIN public.record_revisions rev ON rev.id = rec.current_revision_id',
      ];

  const onde = isActual
    ? `rec.form_id = ${quoteLiteral(input.formId)}::uuid AND rec.deleted_at IS NULL`
    : `rec.form_version_id = ${quoteLiteral(input.formVersionId)}::uuid AND rec.deleted_at IS NULL`;

  return montarVista(nome, null, null, isActual, colunas, de, onde, index);
}

function childView(
  input: GenerateViewsInput,
  index: FormIndex,
  caminho: string[],
  isActual: boolean,
): GeneratedView {
  const repeatId = caminho[caminho.length - 1]!;
  const nomes = caminho.map((id) => index.byId.get(id)?.field.name ?? id);
  const nome = viewName({
    project: input.projectKey,
    form: input.formKey,
    repeatPath: nomes,
    version: isActual ? 'actual' : input.definition.version,
  });

  const allocator = new IdentifierAllocator(['record_id', 'idx']);
  const colunas: GeneratedColumn[] = [
    { name: 'record_id', sqlType: 'uuid', fieldId: null, expression: 'rec.id' },
  ];

  // Uma coluna de índice por nível: `contadores_idx`, `leituras_idx`, ... e o
  // nível mais fundo chama-se sempre `idx`. É isso que torna o JOIN entre a
  // vista-mãe e a vista-filha óbvio para quem escreve SQL à mão.
  const froms = [
    'public.records rec',
    'JOIN public.record_revisions rev ON rev.id = rec.current_revision_id',
  ];
  if (isActual) froms.push('JOIN public.form_versions fv ON fv.id = rec.form_version_id');

  let fonte = 'rev.data';
  caminho.forEach((id, nivel) => {
    const alias = `i${nivel + 1}`;
    froms.push(
      `CROSS JOIN LATERAL jsonb_array_elements(${arrayGuard(`${fonte} -> ${quoteLiteral(id)}`)}) ` +
        `WITH ORDINALITY AS ${alias}(item, ord)`,
    );
    const ehUltimo = nivel === caminho.length - 1;
    const nomeColuna = ehUltimo
      ? 'idx'
      : allocator.allocate(`${nomes[nivel] ?? id}_idx`, `nivel_${nivel + 1}_idx`);
    colunas.push({
      name: nomeColuna,
      sqlType: 'integer',
      fieldId: null,
      // `WITH ORDINALITY` começa em 1; os índices dos dados começam em 0, e é
      // por 0 que a app e as mensagens de erro falam.
      expression: `(${alias}.ord - 1)::integer`,
    });
    fonte = `${alias}.item`;
  });

  if (isActual) {
    allocator.allocate('form_version');
    colunas.push({
      name: 'form_version',
      sqlType: 'integer',
      fieldId: null,
      expression: 'fv.version',
    });
  }

  const repeat = index.byId.get(repeatId)?.field;
  const campos = repeat && repeat.type === 'repeat' ? repeat.fields : [];
  colunas.push(...fieldColumns(index, campos, fonte, allocator));

  const onde = isActual
    ? `rec.form_id = ${quoteLiteral(input.formId)}::uuid AND rec.deleted_at IS NULL`
    : `rec.form_version_id = ${quoteLiteral(input.formVersionId)}::uuid AND rec.deleted_at IS NULL`;

  return montarVista(nome, caminho, repeatId, isActual, colunas, froms, onde, index);
}

/**
 * `jsonb_array_elements` rebenta se o valor não for um array. Um registo
 * gravado por uma versão antiga da app pode ter lá outra coisa, e isso não
 * pode partir a vista inteira para toda a gente.
 */
function arrayGuard(expr: string): string {
  return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

function montarVista(
  nome: string,
  repeatPath: string[] | null,
  repeatFieldId: string | null,
  isActual: boolean,
  colunas: GeneratedColumn[],
  froms: string[],
  onde: string,
  index: FormIndex,
): GeneratedView {
  const select = colunas.map((c) => `  ${c.expression} AS ${quoteIdentifier(c.name)}`).join(',\n');

  const createSql =
    `CREATE VIEW ${VIEWS_SCHEMA}.${quoteIdentifier(nome)} AS\nSELECT\n${select}\n` +
    `FROM ${froms.join('\n  ')}\nWHERE ${onde};`;

  // O `id` do campo fica como comentário da coluna (ESPECIFICACAO §13.2): é o
  // que permite a quem lê a vista voltar ao campo mesmo depois de o `name` ter
  // sido mudado.
  const commentSql = colunas
    .filter((c) => c.fieldId !== null)
    .map((c) => {
      const campo = index.byId.get(c.fieldId!)?.field;
      const rotulo = campo?.label?.pt ?? campo?.name ?? c.fieldId!;
      return (
        `COMMENT ON COLUMN ${VIEWS_SCHEMA}.${quoteIdentifier(nome)}.${quoteIdentifier(c.name)} IS ` +
        `${quoteLiteral(`${c.fieldId} — ${rotulo}`)};`
      );
    });

  return {
    name: nome,
    repeatPath,
    repeatFieldId,
    isActual,
    columns: colunas,
    createSql,
    commentSql,
    dropSql: `DROP VIEW IF EXISTS ${VIEWS_SCHEMA}.${quoteIdentifier(nome)};`,
  };
}

/**
 * Colunas dos campos de um âmbito. Atravessa os `group` — que não criam nível
 * nos dados — e ignora os `repeat`, que dão origem a vistas próprias.
 */
function fieldColumns(
  index: FormIndex,
  fields: readonly Field[],
  fonte: string,
  allocator: IdentifierAllocator,
): GeneratedColumn[] {
  const out: GeneratedColumn[] = [];

  for (const field of fields) {
    if (field.type === 'group') {
      out.push(...fieldColumns(index, field.fields, fonte, allocator));
      continue;
    }
    if (field.type === 'repeat' || field.type === 'note') continue;
    if (field.projected === false) continue;

    const valor = `${fonte} -> ${quoteLiteral(field.id)}`;
    const nome = allocator.allocate(field.name, field.id);

    if (field.type === 'geopoint' || field.type === 'geotrace' || field.type === 'geoshape') {
      const fn =
        field.type === 'geopoint'
          ? 'to_point'
          : field.type === 'geotrace'
            ? 'to_linestring'
            : 'to_polygon';
      const tipo =
        field.type === 'geopoint'
          ? 'geometry(Point,4326)'
          : field.type === 'geotrace'
            ? 'geometry(LineString,4326)'
            : 'geometry(Polygon,4326)';
      out.push({
        name: nome,
        sqlType: tipo,
        fieldId: field.id,
        expression: `${VIEWS_SCHEMA}.${fn}(${valor})`,
      });
      // Restrição inegociável 8: a precisão e a origem viajam sempre com o
      // ponto, também na projecção — sem isto não há relatório de qualidade.
      for (const [sufixo, sqlType, fn2] of [
        ['accuracy_m', 'numeric', 'to_numeric'],
        ['fix_type', 'text', 'to_text'],
        ['source', 'text', 'to_text'],
      ] as const) {
        out.push({
          name: allocator.allocate(`${nome}_${sufixo}`, `${field.id}_${sufixo}`),
          sqlType,
          fieldId: field.id,
          expression: `${VIEWS_SCHEMA}.${fn2}(${valor} -> ${quoteLiteral(sufixo)})`,
        });
      }
      continue;
    }

    if (field.type === 'select_multiple') {
      out.push({
        name: nome,
        sqlType: 'text[]',
        fieldId: field.id,
        expression: `${VIEWS_SCHEMA}.to_text_array(${valor})`,
      });
      // A coluna `_txt` existe para compatibilidade com o ODK e o Kobo, onde
      // uma escolha múltipla é uma string de valores separados por espaço
      // (ESPECIFICACAO §13.5).
      out.push({
        name: allocator.allocate(`${nome}_txt`, `${field.id}_txt`),
        sqlType: 'text',
        fieldId: field.id,
        expression: `array_to_string(${VIEWS_SCHEMA}.to_text_array(${valor}), ' ')`,
      });
      continue;
    }

    if (field.type === 'reference') {
      out.push({
        name: nome,
        sqlType: 'uuid',
        fieldId: field.id,
        expression: `${VIEWS_SCHEMA}.to_uuid(${valor})`,
      });
      continue;
    }

    const sqlType = SQL_TYPE[typeOfField(field, index)] ?? 'text';
    const conversor = CONVERSOR[sqlType] ?? 'to_text';
    out.push({
      name: nome,
      sqlType,
      fieldId: field.id,
      expression: `${VIEWS_SCHEMA}.${conversor}(${valor})`,
    });
  }

  return out;
}

/**
 * Índices para os campos marcados como `searchable` (F2.10).
 *
 * São índices de expressão sobre `record_revisions.data`, partilhados por todos
 * os formulários que usem o mesmo `id` de campo — não há um índice por
 * formulário publicado, o que manteria a restrição inegociável 5 de pé mesmo
 * com centenas de formulários.
 */
function searchIndexes(index: FormIndex): GeneratedIndex[] {
  const out: GeneratedIndex[] = [];
  const vistos = new Set<string>();

  for (const { field } of index.order) {
    if (field.searchable !== true) continue;
    if (field.type === 'group' || field.type === 'repeat' || field.type === 'note') continue;
    if (vistos.has(field.id)) continue;
    vistos.add(field.id);

    const nome = sanitizeIdentifier(`cvf_busca_${field.id}`, `cvf_busca_${vistos.size}`);
    const expressao = `(data ->> ${quoteLiteral(field.id)})`;
    out.push({
      name: nome,
      fieldId: field.id,
      // btree e não GIN: a pesquisa da app e do painel é igualdade e prefixo
      // sobre um campo, e o GIN com jsonb_path_ops só acelera `@>` — esse já
      // existe, global, desde a migração 0001.
      createSql:
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(nome)} ` +
        `ON public.record_revisions USING btree (${expressao});`,
      dropSql: `DROP INDEX IF EXISTS public.${quoteIdentifier(nome)};`,
    });
  }

  return out;
}
