import { childContext, evaluate, isNullish } from './evaluate.js';
import { buildIndex, type FormIndex } from './index-form.js';
import {
  computeFormState,
  scopeInstances,
  type InstancePath,
  type ScopeInstance,
} from './runtime.js';
import { GNSS_FIX_TYPES, GNSS_SOURCES } from './types/index.js';
import type { Choice, Field, FormDefinition, LocalizedText, RecordData } from './types/index.js';

/**
 * Validação de uma resposta contra a definição (F1.11 e F1.12).
 *
 * Duas regras que valem por todo o ficheiro:
 *   1. Um campo não relevante NÃO é validado, mesmo sendo obrigatório. Exigir
 *      resposta a uma pergunta escondida é prender o técnico num ecrã sem
 *      saída.
 *   2. Devolve SEMPRE todos os erros, nunca só o primeiro. Corrigir um
 *      formulário de 80 perguntas um erro de cada vez, sem rede, é inaceitável.
 */

export interface AnswerIssue {
  code: string;
  severity: 'erro' | 'aviso';
  /** Caminho da instância: `g_cont[1].f_ns`. */
  path: InstancePath;
  fieldId: string;
  message: string;
}

export interface ValidateAnswersOptions {
  now?: Date;
  index?: FormIndex;
  language?: string;
  /**
   * Já foi escrita justificação para pontos acima do limiar de precisão. A
   * decisão de gravar mesmo assim é do técnico (ver ESPECIFICACAO §11); o
   * papel do validador é garantir que ela existe.
   */
  accuracyOverrideReason?: string | null;
}

export interface AnswerValidationResult {
  valid: boolean;
  issues: AnswerIssue[];
  /** Resposta com cálculos aplicados e campos não relevantes limpos. */
  data: RecordData;
}

function text(label: LocalizedText | undefined, language: string, fallback: string): string {
  if (!label) return fallback;
  return label[language] ?? label.pt ?? fallback;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function validateAnswers(
  definition: FormDefinition,
  answers: RecordData,
  options: ValidateAnswersOptions = {},
): AnswerValidationResult {
  const index = options.index ?? buildIndex(definition);
  const language = options.language ?? definition.settings?.default_language ?? 'pt';
  const state = computeFormState(definition, answers, {
    index,
    ...(options.now ? { now: options.now } : {}),
  });
  const issues: AnswerIssue[] = [];

  const add = (
    code: string,
    path: string,
    fieldId: string,
    message: string,
    severity: 'erro' | 'aviso' = 'erro',
  ): void => {
    issues.push({ code, severity, path, fieldId, message });
  };

  const walk = (fields: readonly Field[], instance: ScopeInstance): void => {
    for (const field of fields) {
      const path = `${instance.prefix}${field.id}`;
      const relevant = state.relevance.byPath.get(path) ?? true;

      if (field.type === 'group') {
        if (relevant) walk(field.fields, instance);
        continue;
      }
      if (!relevant) continue; // regra 1
      if (field.type === 'note') continue;

      const value = instance.values[field.id] ?? null;
      const rotulo = text(field.label, language, field.name);

      if (field.type === 'repeat') {
        const raw = Array.isArray(value) ? value : [];
        if (field.min !== undefined && raw.length < field.min) {
          add(
            'repeticoes_a_menos',
            path,
            field.id,
            `"${rotulo}" precisa de pelo menos ${field.min} ${field.min === 1 ? 'instância' : 'instâncias'} e tem ${raw.length}.`,
          );
        }
        if (field.max !== undefined && raw.length > field.max) {
          add(
            'repeticoes_a_mais',
            path,
            field.id,
            `"${rotulo}" aceita no máximo ${field.max} instâncias e tem ${raw.length}.`,
          );
        }
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i];
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            add(
              'instancia_invalida',
              `${path}[${i}]`,
              field.id,
              `A instância ${i + 1} de "${rotulo}" não é um objecto de respostas.`,
            );
            continue;
          }
          const values = item as RecordData;
          walk(field.fields, {
            values,
            ctx: childContext(instance.ctx, values),
            prefix: `${instance.prefix}${field.id}[${i}].`,
          });
        }
        continue;
      }

      if (isNullish(value)) {
        if (field.required === true) {
          add('obrigatorio', path, field.id, `"${rotulo}" é obrigatório.`);
        }
        continue; // sem valor não há tipo, restrição nem intervalo para verificar
      }

      checkType(field, value, path, rotulo, add, definition);
      checkConstraint(field, value, instance, path, rotulo, language, add);
    }
  };

  for (const root of scopeInstances(index, state.data, undefined)) {
    walk(definition.fields, root);
  }

  checkAccuracy(definition, index, state.data, options, language, add);

  return { valid: !issues.some((i) => i.severity === 'erro'), issues, data: state.data };
}

type Add = (
  code: string,
  path: string,
  fieldId: string,
  message: string,
  severity?: 'erro' | 'aviso',
) => void;

function checkType(
  field: Field,
  value: unknown,
  path: string,
  rotulo: string,
  add: Add,
  definition: FormDefinition,
): void {
  const tipoInvalido = (esperado: string): void =>
    add('tipo_invalido', path, field.id, `"${rotulo}" espera ${esperado}.`);

  switch (field.type) {
    case 'text':
    case 'barcode': {
      if (typeof value !== 'string') return tipoInvalido('texto');
      if (
        field.type === 'text' &&
        field.max_length !== undefined &&
        value.length > field.max_length
      ) {
        add(
          'comprimento_excedido',
          path,
          field.id,
          `"${rotulo}" aceita no máximo ${field.max_length} caracteres e tem ${value.length}.`,
        );
      }
      return;
    }
    case 'integer':
    case 'decimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return tipoInvalido('um número');
      if (field.type === 'integer' && !Number.isInteger(value)) {
        return tipoInvalido('um número inteiro');
      }
      if (field.min !== undefined && value < field.min) {
        add(
          'fora_do_intervalo',
          path,
          field.id,
          `"${rotulo}" não pode ser menor do que ${field.min}.`,
        );
      }
      if (field.max !== undefined && value > field.max) {
        add(
          'fora_do_intervalo',
          path,
          field.id,
          `"${rotulo}" não pode ser maior do que ${field.max}.`,
        );
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return tipoInvalido('sim ou não');
      return;
    case 'date':
      if (
        typeof value !== 'string' ||
        !DATE_RE.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      ) {
        return tipoInvalido('uma data no formato AAAA-MM-DD');
      }
      return;
    case 'time':
      if (typeof value !== 'string' || !TIME_RE.test(value)) return tipoInvalido('uma hora HH:MM');
      return;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        return tipoInvalido('um instante ISO 8601 em UTC');
      }
      return;
    case 'select_one': {
      if (typeof value !== 'string') return tipoInvalido('uma opção');
      const choices = definition.choice_lists?.[field.choices_ref] ?? [];
      if (field.allow_other !== true && !choices.some((c: Choice) => c.value === value)) {
        add('escolha_invalida', path, field.id, `"${value}" não é uma opção de "${rotulo}".`);
      }
      return;
    }
    case 'select_multiple': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return tipoInvalido('uma lista de opções');
      }
      const choices = definition.choice_lists?.[field.choices_ref] ?? [];
      if (field.allow_other !== true) {
        for (const v of value) {
          if (!choices.some((c: Choice) => c.value === v)) {
            add('escolha_invalida', path, field.id, `"${v}" não é uma opção de "${rotulo}".`);
          }
        }
      }
      if (new Set(value).size !== value.length) {
        add('escolha_repetida', path, field.id, `"${rotulo}" tem opções repetidas.`);
      }
      if (field.min_selected !== undefined && value.length < field.min_selected) {
        add(
          'poucas_escolhas',
          path,
          field.id,
          `"${rotulo}" precisa de pelo menos ${field.min_selected} ${field.min_selected === 1 ? 'opção' : 'opções'}.`,
        );
      }
      if (field.max_selected !== undefined && value.length > field.max_selected) {
        add(
          'muitas_escolhas',
          path,
          field.id,
          `"${rotulo}" aceita no máximo ${field.max_selected} ${field.max_selected === 1 ? 'opção' : 'opções'}.`,
        );
      }
      return;
    }
    case 'geopoint':
      checkGeopoint(value, field.id, path, rotulo, add);
      return;
    case 'geotrace':
    case 'geoshape': {
      const vertices = (value as { vertices?: unknown })?.vertices;
      if (!Array.isArray(vertices) || vertices.length === 0) {
        return tipoInvalido('uma lista de vértices');
      }
      if (field.type === 'geoshape' && vertices.length < 3) {
        add('geometria_invalida', path, field.id, `"${rotulo}" precisa de pelo menos 3 vértices.`);
      }
      vertices.forEach((v, i) => checkGeopoint(v, field.id, `${path}.vertices[${i}]`, rotulo, add));
      return;
    }
    case 'photo':
    case 'file': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return tipoInvalido('uma lista de anexos');
      }
      if (
        field.type === 'photo' &&
        field.max_count !== undefined &&
        value.length > field.max_count
      ) {
        add(
          'anexos_a_mais',
          path,
          field.id,
          `"${rotulo}" aceita no máximo ${field.max_count} ficheiros.`,
        );
      }
      return;
    }
    case 'audio':
    case 'signature':
      if (typeof value !== 'string') return tipoInvalido('a referência de um anexo');
      return;
    case 'reference':
      if (typeof value !== 'string') return tipoInvalido('o identificador de um registo');
      return;
    case 'calculate':
      return; // o valor vem do avaliador, não do técnico
    default:
      return;
  }
}

/** Restrição inegociável 8: todo o ponto guardado leva precisão e origem. */
function checkGeopoint(
  value: unknown,
  fieldId: string,
  path: string,
  rotulo: string,
  add: Add,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add('tipo_invalido', path, fieldId, `"${rotulo}" espera um ponto com latitude e longitude.`);
    return;
  }
  const p = value as Record<string, unknown>;
  const lat = p['lat'];
  const lon = p['lon'];
  if (typeof lat !== 'number' || lat < -90 || lat > 90) {
    add('coordenada_invalida', path, fieldId, `Latitude inválida em "${rotulo}".`);
  }
  if (typeof lon !== 'number' || lon < -180 || lon > 180) {
    add('coordenada_invalida', path, fieldId, `Longitude inválida em "${rotulo}".`);
  }
  if (typeof p['accuracy_m'] !== 'number' || p['accuracy_m'] < 0) {
    add(
      'ponto_sem_metadados',
      path,
      fieldId,
      `"${rotulo}" tem de guardar accuracy_m: sem precisão, o ponto não é auditável.`,
    );
  }
  if (
    typeof p['fix_type'] !== 'string' ||
    !(GNSS_FIX_TYPES as readonly string[]).includes(p['fix_type'])
  ) {
    add('ponto_sem_metadados', path, fieldId, `"${rotulo}" tem de guardar um fix_type válido.`);
  }
  if (
    typeof p['source'] !== 'string' ||
    !(GNSS_SOURCES as readonly string[]).includes(p['source'])
  ) {
    add(
      'ponto_sem_metadados',
      path,
      fieldId,
      `"${rotulo}" tem de guardar a origem do ponto (source).`,
    );
  }
}

function checkConstraint(
  field: Field,
  value: unknown,
  instance: ScopeInstance,
  path: string,
  rotulo: string,
  language: string,
  add: Add,
): void {
  if (!field.constraint) return;
  const ctx = { ...instance.ctx, self: value };
  const result = evaluate(field.constraint, ctx);
  if (result === true) return;
  // `null` conta como falso: uma restrição que não se consegue avaliar não
  // pode dar o registo por bom.
  add(
    'restricao',
    path,
    field.id,
    text(field.constraint_message, language, `"${rotulo}" não cumpre a restrição definida.`),
  );
}

/**
 * Limiar de precisão (ESPECIFICACAO §11). Acima dele grava-se na mesma — nunca
 * se recusa trabalho de campo — mas exige-se justificação escrita, que fica na
 * revisão e aparece no relatório de qualidade.
 */
function checkAccuracy(
  definition: FormDefinition,
  index: FormIndex,
  data: RecordData,
  options: ValidateAnswersOptions,
  language: string,
  add: Add,
): void {
  const formThreshold = definition.settings?.max_accuracy_m;
  const justificado = !!options.accuracyOverrideReason?.trim();

  for (const { field, repeatScope } of index.order) {
    if (field.type !== 'geopoint' && field.type !== 'geotrace' && field.type !== 'geoshape')
      continue;
    const threshold = field.max_accuracy_m ?? formThreshold;
    if (threshold === undefined) continue;

    for (const instance of scopeInstances(index, data, repeatScope)) {
      const value = instance.values[field.id];
      const accuracy = readAccuracy(value);
      if (accuracy === null || accuracy <= threshold) continue;
      const rotulo = text(field.label, language, field.name);
      add(
        justificado ? 'precisao_acima_do_limiar_justificada' : 'precisao_acima_do_limiar',
        `${instance.prefix}${field.id}`,
        field.id,
        `"${rotulo}" foi recolhido com ${accuracy} m de precisão, acima do limiar de ${threshold} m.` +
          (justificado
            ? ' Guardado com justificação escrita.'
            : ' É preciso justificar por escrito para guardar.'),
        justificado ? 'aviso' : 'erro',
      );
    }
  }
}

function readAccuracy(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const direct = (value as Record<string, unknown>)['accuracy_m'];
  if (typeof direct === 'number') return direct;
  const vertices = (value as { vertices?: unknown }).vertices;
  if (Array.isArray(vertices)) {
    const values = vertices
      .map((v) =>
        typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['accuracy_m'] : null,
      )
      .filter((v): v is number => typeof v === 'number');
    return values.length ? Math.max(...values) : null;
  }
  return null;
}
