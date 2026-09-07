import type { Choice, Expression, Field, FormDefinition, LocalizedText } from '../types/index.js';
import type { XlsFormIssue, XlsFormWorkbook, XlsRow } from './types.js';
import { xpathToAst, type XPathContext } from './xpath.js';

/**
 * Importador de XLSForm (F1.14 e F1.15).
 *
 * O objectivo é trazer no primeiro dia os formulários que já existem no Kobo,
 * no ODK e no Survey123. A conversão tem perdas — está escrito no FORM-SPEC
 * §10 — e a regra é: o que não converte é COMUNICADO com a linha e a expressão
 * exactas, nunca descartado em silêncio.
 *
 * A diferença mais importante em relação ao XLSForm é que aqui os dados
 * guardam-se por `id`, e o XLSForm não tem `id`. Os `id` são gerados na
 * importação, a partir do `name`. Reimportar um formulário exportado gera `id`
 * novos e por isso NÃO se faz a um formulário que já tenha dados (FORM-SPEC
 * §10).
 */

export interface XlsFormImportOptions {
  /** UUID a atribuir ao formulário. Só a API o sabe; nos testes é fixo. */
  formId?: string;
  /** Idioma a assumir quando uma coluna `label` não traz o idioma no nome. */
  defaultLanguage?: string;
}

export interface XlsFormImportResult {
  /** `false` se houver erros: nesse caso a definição não deve ser publicada. */
  ok: boolean;
  definition: FormDefinition;
  /** `form_id` do XLSForm, que é uma chave de texto e não o UUID do formulário. */
  formKey?: string;
  errors: XlsFormIssue[];
  losses: XlsFormIssue[];
}

const PLACEHOLDER_FORM_ID = '00000000-0000-7000-8000-000000000000';

/** Tipos de metadados do XLSForm: não são perguntas e não têm equivalente. */
const METADATA_TYPES = new Set([
  'start',
  'end',
  'today',
  'deviceid',
  'subscriberid',
  'simserial',
  'phonenumber',
  'username',
  'email',
  'audit',
  'start-geopoint',
]);

const TYPE_MAP: Record<string, string> = {
  text: 'text',
  string: 'text',
  note: 'note',
  integer: 'integer',
  int: 'integer',
  decimal: 'decimal',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  dateTime: 'datetime',
  geopoint: 'geopoint',
  geotrace: 'geotrace',
  geoshape: 'geoshape',
  image: 'photo',
  photo: 'photo',
  audio: 'audio',
  'background-audio': 'audio',
  file: 'file',
  video: 'file',
  barcode: 'barcode',
  calculate: 'calculate',
  acknowledge: 'boolean',
  hidden: 'text',
};

interface Draft {
  field: Field;
  row: number;
  raw: XlsRow;
  /** `id` do repetível que o contém, se algum. */
  repeatId?: string;
}

export function importXlsForm(
  workbook: XlsFormWorkbook,
  options: XlsFormImportOptions = {},
): XlsFormImportResult {
  const errors: XlsFormIssue[] = [];
  const losses: XlsFormIssue[] = [];
  const defaultLanguage = options.defaultLanguage ?? 'pt';

  const choiceLists = readChoices(workbook, defaultLanguage, losses);
  const settings = readSettings(workbook);

  // ── Passagem 1: árvore, tipos, rótulos ────────────────────────────────────
  const usedIds = new Set<string>();
  const drafts: Draft[] = [];
  const byName = new Map<string, Draft>();
  const roots: Field[] = [];
  const stack: Array<{ field: Field; type: 'group' | 'repeat' }> = [];

  const currentRepeat = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i]!;
      if (entry.type === 'repeat') return entry.field.id;
    }
    return undefined;
  };

  const pushField = (field: Field): void => {
    const parent = stack[stack.length - 1];
    if (parent && (parent.field.type === 'group' || parent.field.type === 'repeat')) {
      parent.field.fields.push(field);
    } else {
      roots.push(field);
    }
  };

  workbook.survey.forEach((raw, i) => {
    const row = i + 2; // o cabeçalho é a linha 1
    const rawType = (raw['type'] ?? '').trim();
    if (rawType === '') return;

    const [head, ...rest] = rawType.split(/\s+/);
    const kind = head!;
    const name = (raw['name'] ?? '').trim();

    // `end group` e `end_group` são as duas grafias que se encontram no mundo.
    // Atenção ao `end` sozinho: esse é o metadado do XLSForm que grava o
    // instante em que o preenchimento terminou, e não fecha grupo nenhum.
    const fechaContentor =
      kind === 'end_group' ||
      kind === 'end_repeat' ||
      (kind === 'end' && (rest[0] === 'group' || rest[0] === 'repeat'));

    if (fechaContentor) {
      if (stack.length === 0) {
        errors.push({
          row,
          sheet: 'survey',
          column: 'type',
          value: rawType,
          reason: 'fim de grupo sem início',
        });
        return;
      }
      stack.pop();
      return;
    }

    if (kind === 'begin' || kind === 'begin_group' || kind === 'begin_repeat') {
      const isRepeat =
        kind === 'begin_repeat' || (kind === 'begin' && (rest[0] ?? '') === 'repeat');
      const id = makeId(isRepeat ? 'g' : 'g', name, usedIds);
      const field = {
        id,
        name: sanitizeName(name, id),
        type: isRepeat ? 'repeat' : 'group',
        fields: [],
      } as unknown as Field;
      applyLabels(field, raw, defaultLanguage);
      const draft: Draft = { field, row, raw };
      const repeatId = currentRepeat();
      if (repeatId) draft.repeatId = repeatId;
      drafts.push(draft);
      if (name) byName.set(name, draft);
      pushField(field);
      stack.push({ field, type: isRepeat ? 'repeat' : 'group' });
      return;
    }

    if (METADATA_TYPES.has(kind)) {
      losses.push({
        row,
        sheet: 'survey',
        column: 'type',
        value: rawType,
        reason: `"${kind}" é metadado do XLSForm; o Consul Colect guarda o equivalente na revisão e não como pergunta`,
      });
      return;
    }

    if (kind === 'select_one' || kind === 'select_multiple' || kind === 'select_one_from_file') {
      if (kind === 'select_one_from_file') {
        errors.push({
          row,
          sheet: 'survey',
          column: 'type',
          value: rawType,
          reason:
            'listas em ficheiro externo entram pelo manifesto do formulário, não pela definição',
        });
        return;
      }
      const listName = rest[0];
      if (!listName) {
        errors.push({
          row,
          sheet: 'survey',
          column: 'type',
          value: rawType,
          reason: 'falta o nome da lista',
        });
        return;
      }
      if (!choiceLists[listName]) {
        errors.push({
          row,
          sheet: 'survey',
          column: 'type',
          value: rawType,
          reason: `a lista "${listName}" não existe na folha choices`,
        });
        return;
      }
      const id = makeId('f', name, usedIds);
      const field = {
        id,
        name: sanitizeName(name, id),
        type: kind,
        choices_ref: listName,
      } as unknown as Field;
      if (rest.includes('or_other')) {
        (field as { allow_other?: boolean }).allow_other = true;
      }
      finishField(field, raw, row, defaultLanguage, losses);
      const draft: Draft = { field, row, raw };
      const repeatId = currentRepeat();
      if (repeatId) draft.repeatId = repeatId;
      drafts.push(draft);
      if (name) byName.set(name, draft);
      pushField(field);
      return;
    }

    const mapped = TYPE_MAP[kind];
    if (!mapped) {
      errors.push({
        row,
        sheet: 'survey',
        column: 'type',
        value: rawType,
        reason: `o tipo "${kind}" não tem equivalente na versão 1 do formato`,
      });
      return;
    }

    const id = makeId('f', name, usedIds);
    const field = { id, name: sanitizeName(name, id), type: mapped } as unknown as Field;
    if (kind === 'hidden') (field as { readonly?: boolean }).readonly = true;
    finishField(field, raw, row, defaultLanguage, losses);
    const draft: Draft = { field, row, raw };
    const repeatId = currentRepeat();
    if (repeatId) draft.repeatId = repeatId;
    drafts.push(draft);
    if (name) byName.set(name, draft);
    pushField(field);
  });

  if (stack.length > 0) {
    errors.push({
      row: workbook.survey.length + 1,
      sheet: 'survey',
      reason: `${stack.length} grupo(s) ou repetível(is) ficaram por fechar`,
    });
  }

  // ── Passagem 2: expressões ────────────────────────────────────────────────
  const context: XPathContext = {
    resolve(name) {
      const draft = byName.get(name);
      if (!draft) return undefined;
      return draft.repeatId
        ? { id: draft.field.id, repeatId: draft.repeatId }
        : { id: draft.field.id };
    },
    repeatOf(id) {
      return drafts.find((d) => d.field.id === id)?.repeatId;
    },
    isRepeat(id) {
      return drafts.find((d) => d.field.id === id)?.field.type === 'repeat';
    },
  };

  for (const draft of drafts) {
    convertExpression(draft, 'relevant', 'relevant', context, errors);
    convertExpression(draft, 'constraint', 'constraint', context, errors);
    convertExpression(draft, 'calculation', 'calculation', context, errors);
    if (draft.field.calculation && draft.field.type !== 'calculate') {
      // O XLSForm deixa pôr `calculation` em qualquer tipo; o formato exige que
      // o campo seja calculate ou readonly (§8 regra 12).
      (draft.field as { readonly?: boolean }).readonly = true;
    }
  }

  const definition: FormDefinition = {
    spec_version: 1,
    form_id: options.formId ?? PLACEHOLDER_FORM_ID,
    version: 1,
    title: settings.title ?? { pt: settings.formKey ?? 'Formulário importado' },
    fields: roots,
    ...(Object.keys(choiceLists).length ? { choice_lists: choiceLists } : {}),
  };

  const formSettings: FormDefinition['settings'] = {};
  if (settings.defaultLanguage) formSettings.default_language = settings.defaultLanguage;

  // Se houver exactamente um geopoint no âmbito raiz, é ele que alimenta a
  // geometria do registo. Sem isto, um formulário importado não aparece no mapa
  // e ninguém percebe porquê.
  const geopoints = roots.filter((f) => f.type === 'geopoint');
  if (geopoints.length === 1) {
    formSettings.geometry_field = geopoints[0]!.id;
  } else if (geopoints.length > 1) {
    losses.push({
      row: 0,
      sheet: 'settings',
      reason: `o formulário tem ${geopoints.length} geopoint à raiz: escolhe à mão qual alimenta o mapa em settings.geometry_field`,
    });
  }

  if (settings.instanceName) {
    const converted = xpathToAst(settings.instanceName, context);
    if (converted.ok) formSettings.record_label = converted.ast;
    else
      losses.push({
        row: 0,
        sheet: 'settings',
        column: 'instance_name',
        value: settings.instanceName,
        reason: converted.error.reason,
      });
  }
  if (Object.keys(formSettings).length) definition.settings = formSettings;

  if (settings.version) {
    losses.push({
      row: 0,
      sheet: 'settings',
      column: 'version',
      value: settings.version,
      reason: 'a versão do XLSForm é texto livre; aqui as versões são inteiros e esta passa a 1',
    });
  }

  return {
    ok: errors.length === 0,
    definition,
    ...(settings.formKey ? { formKey: settings.formKey } : {}),
    errors,
    losses,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function convertExpression(
  draft: Draft,
  column: string,
  slot: 'relevant' | 'constraint' | 'calculation',
  context: XPathContext,
  errors: XlsFormIssue[],
): void {
  const raw = (draft.raw[column] ?? '').trim();
  if (raw === '') return;
  const result = xpathToAst(raw, context);
  if (result.ok) {
    (draft.field as unknown as Record<string, unknown>)[slot] = result.ast;
    return;
  }
  errors.push({
    row: draft.row,
    sheet: 'survey',
    column,
    value: raw,
    reason: `${result.error.reason} (posição ${result.error.position})`,
  });
}

function finishField(
  field: Field,
  raw: XlsRow,
  row: number,
  defaultLanguage: string,
  losses: XlsFormIssue[],
): void {
  applyLabels(field, raw, defaultLanguage);

  if (isYes(raw['required'])) (field as { required?: boolean }).required = true;
  if (isYes(raw['read_only']) || isYes(raw['readonly'])) {
    (field as { readonly?: boolean }).readonly = true;
  }
  const appearance = (raw['appearance'] ?? '').trim();
  if (appearance) (field as { appearance?: string }).appearance = appearance;

  const defaultValue = (raw['default'] ?? '').trim();
  if (defaultValue) {
    if (defaultValue.includes('${') || defaultValue.includes('(')) {
      losses.push({
        row,
        sheet: 'survey',
        column: 'default',
        value: defaultValue,
        reason: 'um valor por omissão calculado não é suportado; usa um calculate',
      });
    } else {
      (field as { default?: string | number | boolean }).default = coerceLiteral(defaultValue);
    }
  }

  // `parameters` traz coisas como `max-pixels=1600`, que é exactamente o
  // redimensionamento no telefone de que a rede de campo precisa.
  const parameters = (raw['parameters'] ?? '').trim();
  if (parameters) {
    const maxPixels = /max-pixels\s*=\s*(\d+)/.exec(parameters);
    if (maxPixels && field.type === 'photo') {
      (field as { max_dimension_px?: number }).max_dimension_px = Number(maxPixels[1]);
    } else {
      losses.push({
        row,
        sheet: 'survey',
        column: 'parameters',
        value: parameters,
        reason: 'parâmetros do XLSForm sem equivalente no formato',
      });
    }
  }

  for (const column of ['choice_filter', 'repeat_count', 'required_message', 'trigger']) {
    const value = (raw[column] ?? '').trim();
    if (!value) continue;
    losses.push({
      row,
      sheet: 'survey',
      column,
      value,
      reason:
        column === 'choice_filter'
          ? 'as cascatas exprimem-se com relevant em cada opção da lista, e têm de ser reescritas à mão'
          : `a coluna ${column} não tem equivalente na versão 1 do formato`,
    });
  }
}

function applyLabels(field: Field, raw: XlsRow, defaultLanguage: string): void {
  const label = readLocalized(raw, 'label', defaultLanguage);
  if (label) field.label = label;
  const hint = readLocalized(raw, 'hint', defaultLanguage);
  if (hint) field.hint = hint;
  const message = readLocalized(raw, 'constraint_message', defaultLanguage);
  if (message) field.constraint_message = message;
}

/**
 * Lê `label`, `label::pt`, `label::Português (pt)` — as três grafias que
 * aparecem em formulários reais — numa só estrutura multilingue.
 */
function readLocalized(
  raw: XlsRow,
  prefix: string,
  defaultLanguage: string,
): LocalizedText | undefined {
  const out: Record<string, string> = {};
  for (const [column, value] of Object.entries(raw)) {
    if (!value || !value.trim()) continue;
    if (column === prefix) {
      out[defaultLanguage] = value.trim();
      continue;
    }
    if (!column.startsWith(`${prefix}::`)) continue;
    out[languageCode(column.slice(prefix.length + 2), defaultLanguage)] = value.trim();
  }
  if (Object.keys(out).length === 0) return undefined;
  // `pt` é obrigatório no formato: se não vier, usa-se o primeiro que houver.
  if (!out['pt']) {
    const first = Object.values(out)[0];
    if (first !== undefined) out['pt'] = first;
  }
  return out as LocalizedText;
}

function languageCode(raw: string, fallback: string): string {
  const parenthesised = /\(([A-Za-z-]{2,10})\)\s*$/.exec(raw.trim());
  if (parenthesised) return parenthesised[1]!.toLowerCase();
  const bare = raw.trim().toLowerCase();
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(bare)) return bare;
  const conhecidos: Record<string, string> = {
    portuguese: 'pt',
    português: 'pt',
    english: 'en',
    french: 'fr',
    français: 'fr',
    spanish: 'es',
    español: 'es',
  };
  return conhecidos[bare] ?? fallback;
}

function readChoices(
  workbook: XlsFormWorkbook,
  defaultLanguage: string,
  losses: XlsFormIssue[],
): Record<string, Choice[]> {
  const lists: Record<string, Choice[]> = {};
  const avisados = new Set<string>();

  workbook.choices.forEach((raw, i) => {
    const row = i + 2;
    const listName = (raw['list_name'] ?? raw['list name'] ?? '').trim();
    const value = (raw['name'] ?? '').trim();
    if (!listName || !value) return;

    const label = readLocalized(raw, 'label', defaultLanguage) ?? { pt: value };
    (lists[listName] ??= []).push({ value, label });

    // Colunas extra na folha choices servem quase sempre para `choice_filter`.
    for (const column of Object.keys(raw)) {
      if (['list_name', 'list name', 'name'].includes(column)) continue;
      if (column === 'label' || column.startsWith('label::')) continue;
      if (!raw[column]?.trim()) continue;
      if (avisados.has(column)) continue;
      avisados.add(column);
      losses.push({
        row,
        sheet: 'choices',
        column,
        reason:
          'coluna extra na folha choices, normalmente usada por choice_filter, sem equivalente directo',
      });
    }
  });

  return lists;
}

interface ReadSettings {
  title?: LocalizedText;
  formKey?: string;
  version?: string;
  defaultLanguage?: string;
  instanceName?: string;
}

function readSettings(workbook: XlsFormWorkbook): ReadSettings {
  const row = workbook.settings?.[0];
  if (!row) return {};
  const out: ReadSettings = {};
  const title = (row['form_title'] ?? '').trim();
  if (title) out.title = { pt: title };
  const key = (row['form_id'] ?? '').trim();
  if (key) out.formKey = key;
  const version = (row['version'] ?? '').trim();
  if (version) out.version = version;
  const language = (row['default_language'] ?? '').trim();
  if (language) out.defaultLanguage = languageCode(language, 'pt');
  const instanceName = (row['instance_name'] ?? '').trim();
  if (instanceName) out.instanceName = instanceName;
  return out;
}

function isYes(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'sim';
}

function coerceLiteral(value: string): string | number | boolean {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** `name` do XLSForm saneado para o padrão do formato; nunca fica vazio. */
function sanitizeName(name: string, fallback: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira os acentos, deixando a letra base
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^([^a-zA-Z_])/, '_$1')
    .slice(0, 63);
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Gera um `id` a partir do `name`. Curto, opaco e único — nunca é lido por um
 * humano em contexto de dados, mas ver `f_codigo` num diff ajuda quem depura.
 */
function makeId(prefix: 'f' | 'g', name: string, used: Set<string>): string {
  const slug = sanitizeName(name, 'campo').toLowerCase().replace(/^_+/, '').slice(0, 40);
  const base = `${prefix}_${slug || 'campo'}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
