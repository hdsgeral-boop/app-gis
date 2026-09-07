import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { formDefinitionSchema } from './form-definition.schema.js';
import type { FormDefinition } from '../types/index.js';

export { formDefinitionSchema };
export type { FormDefinitionSchema } from './form-definition.schema.js';

/** Versão do FORMATO de definição suportada por este pacote. */
export const SPEC_VERSION = 1 as const;

function buildValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(formDefinitionSchema as object);
}

let cached: ValidateFunction | undefined;

/** Validador compilado, partilhado. Compilar com Ajv é caro; faz-se uma só vez. */
export function formDefinitionValidator(): ValidateFunction {
  cached ??= buildValidator();
  return cached;
}

export interface SchemaIssue {
  /** Caminho JSON Pointer dentro da definição. */
  path: string;
  message: string;
  keyword: string;
}

export type SchemaCheckResult =
  { ok: true; definition: FormDefinition } | { ok: false; issues: SchemaIssue[] };

/**
 * Valida uma definição contra o JSON Schema.
 *
 * Isto é só a camada sintáctica: garante a forma, não a coerência. Ciclos em
 * `relevant`, `id` duplicados e referências a listas inexistentes são
 * verificados pelo validador semântico da F1.
 */
export function checkFormDefinitionSchema(input: unknown): SchemaCheckResult {
  const validate = formDefinitionValidator();
  if (validate(input)) {
    return { ok: true, definition: input as FormDefinition };
  }
  return { ok: false, issues: (validate.errors ?? []).map(toIssue) };
}

function toIssue(error: ErrorObject): SchemaIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'inválido',
    keyword: error.keyword,
  };
}
