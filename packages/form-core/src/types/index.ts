/**
 * Tipos da definição de formulário do Consul Colect.
 *
 * Este ficheiro e o JSON Schema em `src/schema/form-definition.schema.json` são
 * o CONTRATO entre apps/api, apps/admin e apps/mobile. Alterar aqui obriga a
 * alterar o schema e a bump de `spec_version`.
 *
 * Regra estrutural que atravessa tudo (ESPECIFICACAO.md §4):
 *   `id`   — imutável, gerado pelo sistema, é por ele que os dados são guardados.
 *   `name` — editável pelo humano, é ele que dá nome às colunas das vistas.
 * Renomear uma pergunta nunca pode perder dados.
 */

/** Rótulo multilingue. `pt` é sempre obrigatório. */
export interface LocalizedText {
  pt: string;
  [locale: string]: string;
}

export const FIELD_TYPES = [
  'text',
  'note',
  'integer',
  'decimal',
  'boolean',
  'select_one',
  'select_multiple',
  'date',
  'time',
  'datetime',
  'geopoint',
  'geotrace',
  'geoshape',
  'photo',
  'audio',
  'file',
  'signature',
  'barcode',
  'calculate',
  'group',
  'repeat',
  'reference',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Tipos que contêm outros campos. */
export const CONTAINER_FIELD_TYPES = ['group', 'repeat'] as const satisfies readonly FieldType[];

/** Tipos que produzem geometria. */
export const GEOMETRY_FIELD_TYPES = [
  'geopoint',
  'geotrace',
  'geoshape',
] as const satisfies readonly FieldType[];

/** Tipos que produzem anexos binários. */
export const ATTACHMENT_FIELD_TYPES = [
  'photo',
  'audio',
  'file',
  'signature',
] as const satisfies readonly FieldType[];

/**
 * Operadores da linguagem de expressões.
 *
 * A linguagem é uma AST pura e determinista. NÃO existe `eval`, `Function()`,
 * nem interpretação de strings em tempo de execução (restrição inegociável 7).
 * O avaliador vive uma só vez neste pacote e corre igual no servidor e no
 * telefone.
 */
export const EXPRESSION_OPERATORS = [
  // comparação
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'between',
  // lógica
  'and',
  'or',
  'not',
  // aritmética
  '+',
  '-',
  '*',
  '/',
  'round',
  // texto
  'matches',
  'starts_with',
  'ends_with',
  'contains',
  'length',
  'concat',
  'upper',
  'lower',
  'trim',
  // conjuntos / repetíveis
  'in',
  'selected',
  'count',
  'count_selected',
  'sum',
  // nulidade
  'is_null',
  'coalesce',
  // datas
  'today',
  'now',
  'date_diff_days',
  // geografia
  'distance_m',
  // controlo
  'if',
] as const;

export type ExpressionOperator = (typeof EXPRESSION_OPERATORS)[number];

/**
 * Um nó de expressão.
 *
 * Os argumentos podem ser literais (string, número, booleano, null), outras
 * expressões, ou referências:
 *   `"$self"`   — o valor do campo em que a expressão está declarada
 *   `"$<id>"`   — o valor do campo com esse `id` (nunca por `name`)
 *   `"$..<id>"` — o valor do campo com esse `id` no âmbito pai (dentro de repeat)
 */
export interface Expression {
  op: ExpressionOperator;
  args: ExpressionArg[];
}

export type ExpressionLiteral = string | number | boolean | null;
export type ExpressionArg = ExpressionLiteral | Expression | ExpressionArg[];

export interface Choice {
  value: string;
  label: LocalizedText;
  /** Só aparece quando esta expressão for verdadeira (cascatas de escolhas). */
  relevant?: Expression;
}

export interface FieldBase {
  /** Imutável, gerado pelo sistema. É a chave sob a qual os dados são guardados. */
  id: string;
  /** Editável pelo humano. Dá nome à coluna nas vistas PostGIS e ao XLSForm. */
  name: string;
  type: FieldType;
  label?: LocalizedText;
  hint?: LocalizedText;
  required?: boolean;
  readonly?: boolean;
  /** O campo só existe (e só é validado) quando esta expressão for verdadeira. */
  relevant?: Expression;
  /** Restrição sobre o próprio valor. `$self` refere-se a este campo. */
  constraint?: Expression;
  constraint_message?: LocalizedText;
  /** Valor calculado. Um campo com `calculation` é sempre `readonly`. */
  calculation?: Expression;
  /** Marca o campo para índice GIN e para a pesquisa da app. */
  searchable?: boolean;
  /** Aparece nas colunas das vistas PostGIS. Por omissão, verdadeiro. */
  projected?: boolean;
  default?: ExpressionLiteral;
  appearance?: string;
}

export interface TextField extends FieldBase {
  type: 'text';
  max_length?: number;
  multiline?: boolean;
}

export interface NoteField extends FieldBase {
  type: 'note';
}

export interface IntegerField extends FieldBase {
  type: 'integer';
  min?: number;
  max?: number;
}

export interface DecimalField extends FieldBase {
  type: 'decimal';
  min?: number;
  max?: number;
  decimals?: number;
}

export interface BooleanField extends FieldBase {
  type: 'boolean';
}

export interface SelectOneField extends FieldBase {
  type: 'select_one';
  choices_ref: string;
  allow_other?: boolean;
}

export interface SelectMultipleField extends FieldBase {
  type: 'select_multiple';
  choices_ref: string;
  min_selected?: number;
  max_selected?: number;
  allow_other?: boolean;
}

export interface DateField extends FieldBase {
  type: 'date';
}
export interface TimeField extends FieldBase {
  type: 'time';
}
export interface DateTimeField extends FieldBase {
  type: 'datetime';
}

export interface GeopointField extends FieldBase {
  type: 'geopoint';
  /** Limiar de precisão específico deste campo; sobrepõe-se ao do formulário. */
  max_accuracy_m?: number;
}

export interface GeotraceField extends FieldBase {
  type: 'geotrace';
  max_accuracy_m?: number;
}

export interface GeoshapeField extends FieldBase {
  type: 'geoshape';
  max_accuracy_m?: number;
}

export interface PhotoField extends FieldBase {
  type: 'photo';
  max_count?: number;
  /** Lado maior em pixéis depois de redimensionar no telefone. */
  max_dimension_px?: number;
}

export interface AudioField extends FieldBase {
  type: 'audio';
  max_duration_s?: number;
}

export interface FileField extends FieldBase {
  type: 'file';
  accept?: string[];
}

export interface SignatureField extends FieldBase {
  type: 'signature';
}

export interface BarcodeField extends FieldBase {
  type: 'barcode';
  formats?: string[];
}

export interface CalculateField extends FieldBase {
  type: 'calculate';
  calculation: Expression;
}

export interface GroupField extends FieldBase {
  type: 'group';
  fields: Field[];
  collapsed?: boolean;
}

export interface RepeatField extends FieldBase {
  type: 'repeat';
  fields: Field[];
  min?: number;
  max?: number;
  /** Rótulo de cada instância, para a lista. Avaliado no âmbito da instância. */
  instance_label?: Expression;
}

export interface ReferenceField extends FieldBase {
  type: 'reference';
  /** `form_id` do formulário apontado. Nunca a `key`, que é editável. */
  target_form_id: string;
  /** Campos do registo apontado a mostrar na app ao escolher. */
  display_fields?: string[];
  /** Filtra os registos candidatos. */
  filter?: Expression;
}

export type Field =
  | TextField
  | NoteField
  | IntegerField
  | DecimalField
  | BooleanField
  | SelectOneField
  | SelectMultipleField
  | DateField
  | TimeField
  | DateTimeField
  | GeopointField
  | GeotraceField
  | GeoshapeField
  | PhotoField
  | AudioField
  | FileField
  | SignatureField
  | BarcodeField
  | CalculateField
  | GroupField
  | RepeatField
  | ReferenceField;

export interface FormSettings {
  /** Precisão mínima aceite, em metros, para campos de geometria. */
  max_accuracy_m?: number;
  allow_edit_after_submit?: boolean;
  /** `id` do campo geopoint que alimenta `records.geom`. */
  geometry_field?: string;
  /** Idiomas disponíveis. `pt` é sempre o primeiro. */
  languages?: string[];
  default_language?: string;
  /** Expressão que produz o rótulo do registo nas listagens. */
  record_label?: Expression;
}

export interface FormDefinition {
  /** Versão do FORMATO, não do formulário. Ver docs/FORM-SPEC.md. */
  spec_version: 1;
  form_id: string;
  version: number;
  title: LocalizedText;
  published_at?: string;
  settings?: FormSettings;
  fields: Field[];
  choice_lists?: Record<string, Choice[]>;
}

/** Uma resposta, sempre indexada por `id` de campo — nunca por `name`. */
export type RecordData = Record<string, unknown>;

export interface GeopointValue {
  lat: number;
  lon: number;
  alt?: number | null;
  /** Obrigatório em todo o ponto guardado (restrição inegociável 8). */
  accuracy_m: number;
  fix_type: GnssFixType;
  source: GnssSource;
  collected_at?: string;
}

export const GNSS_FIX_TYPES = [
  'single',
  'dgps',
  'float',
  'fixed',
  'has_ppp',
  'manual',
  'unknown',
] as const;
export type GnssFixType = (typeof GNSS_FIX_TYPES)[number];

export const GNSS_SOURCES = ['internal', 'external_bt', 'external_tcp', 'manual'] as const;
export type GnssSource = (typeof GNSS_SOURCES)[number];

export const RECORD_STATUSES = [
  'rascunho',
  'submetido',
  'validado',
  'rejeitado',
  'needs_review',
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
