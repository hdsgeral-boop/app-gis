import { buildIndex } from '../index-form.js';
import type { Expression, Field, FormDefinition, LocalizedText } from '../types/index.js';
import type { XlsFormIssue, XlsFormWorkbook, XlsRow } from './types.js';
import { astToXPath, type AstToXPathContext } from './xpath.js';

/**
 * Exportador para XLSForm (F1.16).
 *
 * A ida e volta preserva estrutura e rótulos. O que se perde é COMUNICADO —
 * nunca omitido em silêncio. O que se perde, e porquê:
 *
 *   - `reference` não tem equivalente nenhum no XLSForm e desaparece;
 *   - `distance_m` e `date_diff_days` não têm função correspondente;
 *   - os `id` não sobrevivem: o XLSForm só tem `name`. É por isso que
 *     reimportar um formulário exportado gera `id` novos, e é por isso que
 *     não se faz isso a um formulário que já tenha dados (FORM-SPEC §10).
 */

export interface XlsFormExportResult {
  workbook: XlsFormWorkbook;
  losses: XlsFormIssue[];
}

const TYPE_MAP: Partial<Record<Field['type'], string>> = {
  text: 'text',
  note: 'note',
  integer: 'integer',
  decimal: 'decimal',
  boolean: 'select_one yes_no',
  date: 'date',
  time: 'time',
  datetime: 'dateTime',
  geopoint: 'geopoint',
  geotrace: 'geotrace',
  geoshape: 'geoshape',
  photo: 'image',
  audio: 'audio',
  file: 'file',
  signature: 'image',
  barcode: 'barcode',
  calculate: 'calculate',
};

export function exportXlsForm(definition: FormDefinition): XlsFormExportResult {
  const index = buildIndex(definition);
  const losses: XlsFormIssue[] = [];
  const survey: XlsRow[] = [];
  const choices: XlsRow[] = [];

  const languages = collectLanguages(definition);
  const context: AstToXPathContext = {
    nameOf: (id) => index.byId.get(id)?.field.name,
  };

  const writeExpression = (
    row: XlsRow,
    column: string,
    expr: Expression | undefined,
    field: Field,
  ): void => {
    if (!expr) return;
    const result = astToXPath(expr, context);
    if (result.xpath) row[column] = result.xpath;
    for (const loss of result.losses) {
      losses.push({
        row: survey.length + 2,
        sheet: 'survey',
        column,
        value: field.name,
        reason: loss,
      });
    }
    if (!result.xpath) {
      losses.push({
        row: survey.length + 2,
        sheet: 'survey',
        column,
        value: field.name,
        reason: `a expressão de ${column} em "${field.name}" não tem equivalente em XLSForm e foi omitida`,
      });
    }
  };

  const walk = (fields: readonly Field[]): void => {
    for (const field of fields) {
      if (field.type === 'reference') {
        losses.push({
          row: survey.length + 2,
          sheet: 'survey',
          column: 'type',
          value: field.name,
          reason: 'o tipo reference não existe no XLSForm e o campo não foi exportado',
        });
        continue;
      }

      if (field.type === 'group' || field.type === 'repeat') {
        const open: XlsRow = {
          type: field.type === 'repeat' ? 'begin repeat' : 'begin group',
          name: field.name,
        };
        writeLabels(open, 'label', field.label, languages);
        writeLabels(open, 'hint', field.hint, languages);
        writeExpression(open, 'relevant', field.relevant, field);
        if (field.appearance) open['appearance'] = field.appearance;
        survey.push(open);
        walk(field.fields);
        survey.push({
          type: field.type === 'repeat' ? 'end repeat' : 'end group',
          name: field.name,
        });
        continue;
      }

      const row: XlsRow = { type: xlsType(field, losses, survey.length + 2), name: field.name };
      writeLabels(row, 'label', field.label, languages);
      writeLabels(row, 'hint', field.hint, languages);
      writeLabels(row, 'constraint_message', field.constraint_message, languages);
      if (field.required) row['required'] = 'yes';
      if (field.readonly && field.type !== 'calculate') row['read_only'] = 'yes';
      if (field.appearance) row['appearance'] = field.appearance;
      if (field.default !== undefined && field.default !== null)
        row['default'] = String(field.default);
      if (field.type === 'photo' && field.max_dimension_px) {
        row['parameters'] = `max-pixels=${field.max_dimension_px}`;
      }
      writeExpression(row, 'relevant', field.relevant, field);
      writeExpression(row, 'constraint', field.constraint, field);
      writeExpression(row, 'calculation', field.calculation, field);
      survey.push(row);
    }
  };

  walk(definition.fields);

  for (const [listName, list] of Object.entries(definition.choice_lists ?? {})) {
    for (const choice of list) {
      const row: XlsRow = { list_name: listName, name: choice.value };
      writeLabels(row, 'label', choice.label, languages);
      choices.push(row);
      if (choice.relevant) {
        losses.push({
          row: choices.length + 1,
          sheet: 'choices',
          column: 'label',
          value: choice.value,
          reason:
            'a relevância por opção corresponde a choice_filter no XLSForm e teria de ser reescrita à mão',
        });
      }
    }
  }

  // O `boolean` exporta-se como select_one sobre uma lista sim/não, que é a
  // convenção do XLSForm. A lista só se acrescenta se for usada.
  if (hasBoolean(definition)) {
    choices.push({ list_name: 'yes_no', name: 'true', label: 'Sim' });
    choices.push({ list_name: 'yes_no', name: 'false', label: 'Não' });
  }

  const settings: XlsRow = {
    form_title: definition.title.pt,
    form_id: definition.form_id,
    version: String(definition.version),
  };
  if (definition.settings?.default_language) {
    settings['default_language'] = definition.settings.default_language;
  }
  if (definition.settings?.record_label) {
    const result = astToXPath(definition.settings.record_label, context);
    if (result.xpath) settings['instance_name'] = result.xpath;
  }
  if (definition.settings?.max_accuracy_m !== undefined) {
    losses.push({
      row: 2,
      sheet: 'settings',
      reason: 'o limiar de precisão (max_accuracy_m) não existe no XLSForm e não foi exportado',
    });
  }

  return { workbook: { survey, choices, settings: [settings] }, losses };
}

function xlsType(field: Field, losses: XlsFormIssue[], row: number): string {
  if (field.type === 'select_one' || field.type === 'select_multiple') {
    const suffix = field.allow_other ? ' or_other' : '';
    return `${field.type} ${field.choices_ref}${suffix}`;
  }
  const mapped = TYPE_MAP[field.type];
  if (!mapped) {
    losses.push({
      row,
      sheet: 'survey',
      column: 'type',
      value: field.name,
      reason: `o tipo ${field.type} não tem correspondência exacta no XLSForm`,
    });
    return 'text';
  }
  if (field.type === 'signature') {
    losses.push({
      row,
      sheet: 'survey',
      column: 'type',
      value: field.name,
      reason: 'signature exporta como image: o XLSForm não distingue os dois',
    });
  }
  return mapped;
}

function collectLanguages(definition: FormDefinition): string[] {
  const found = new Set<string>(['pt']);
  const visit = (label: LocalizedText | undefined): void => {
    for (const key of Object.keys(label ?? {})) found.add(key);
  };
  const walk = (fields: readonly Field[]): void => {
    for (const field of fields) {
      visit(field.label);
      visit(field.hint);
      visit(field.constraint_message);
      if (field.type === 'group' || field.type === 'repeat') walk(field.fields);
    }
  };
  walk(definition.fields);
  for (const list of Object.values(definition.choice_lists ?? {})) {
    for (const choice of list) visit(choice.label);
  }
  return [...found];
}

function writeLabels(
  row: XlsRow,
  prefix: string,
  label: LocalizedText | undefined,
  languages: string[],
): void {
  if (!label) return;
  if (languages.length === 1) {
    // Um só idioma escreve-se na coluna simples, que é o que a maior parte das
    // ferramentas espera encontrar.
    const only = label[languages[0]!];
    if (only) row[prefix] = only;
    return;
  }
  for (const language of languages) {
    const value = label[language];
    if (value) row[`${prefix}::${language}`] = value;
  }
}

function hasBoolean(definition: FormDefinition): boolean {
  const walk = (fields: readonly Field[]): boolean =>
    fields.some((field) =>
      field.type === 'boolean'
        ? true
        : field.type === 'group' || field.type === 'repeat'
          ? walk(field.fields)
          : false,
    );
  return walk(definition.fields);
}
