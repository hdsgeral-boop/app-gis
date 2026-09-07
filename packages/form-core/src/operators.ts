import { EXPRESSION_OPERATORS, type ExpressionOperator } from './types/index.js';

/**
 * Metadados dos 36 operadores da versão 1 do formato.
 *
 * Vive aqui uma só vez porque três consumidores precisam dele e não podem
 * divergir: o validador (aridade, regra 10 da §8), o avaliador, e o editor de
 * expressões do painel (que mostra a ajuda ao humano).
 */
export interface OperatorSpec {
  /** Número mínimo de argumentos. */
  min: number;
  /** Número máximo, ou `Infinity` para variádicos. */
  max: number;
  /** Não determinista: `today` e `now`. Ver FORM-SPEC §6.2. */
  volatile?: boolean;
  /**
   * Índices de argumentos que NÃO são expressões e têm de ser literais:
   * `sum` recebe o `id` do campo em texto simples, `in` recebe uma lista.
   */
  literalArgs?: number[];
}

export const OPERATORS: Record<ExpressionOperator, OperatorSpec> = {
  // comparação
  '==': { min: 2, max: 2 },
  '!=': { min: 2, max: 2 },
  '<': { min: 2, max: 2 },
  '<=': { min: 2, max: 2 },
  '>': { min: 2, max: 2 },
  '>=': { min: 2, max: 2 },
  between: { min: 3, max: 3 },
  // lógica
  and: { min: 2, max: Infinity },
  or: { min: 2, max: Infinity },
  not: { min: 1, max: 1 },
  // aritmética
  '+': { min: 2, max: Infinity },
  '-': { min: 2, max: Infinity },
  '*': { min: 2, max: Infinity },
  '/': { min: 2, max: Infinity },
  round: { min: 1, max: 2 },
  // texto
  matches: { min: 2, max: 2 },
  starts_with: { min: 2, max: 2 },
  ends_with: { min: 2, max: 2 },
  contains: { min: 2, max: 2 },
  length: { min: 1, max: 1 },
  concat: { min: 2, max: Infinity },
  upper: { min: 1, max: 1 },
  lower: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  // conjuntos e repetíveis
  in: { min: 2, max: 2 },
  selected: { min: 2, max: 2 },
  count: { min: 1, max: 1 },
  count_selected: { min: 1, max: 1 },
  sum: { min: 2, max: 2, literalArgs: [1] },
  // nulidade
  is_null: { min: 1, max: 1 },
  coalesce: { min: 2, max: Infinity },
  // datas
  today: { min: 0, max: 0, volatile: true },
  now: { min: 0, max: 0, volatile: true },
  date_diff_days: { min: 2, max: 2 },
  // geografia
  distance_m: { min: 2, max: 2 },
  // controlo
  if: { min: 3, max: 3 },
};

export function isOperator(value: string): value is ExpressionOperator {
  return (EXPRESSION_OPERATORS as readonly string[]).includes(value);
}

/** Descreve a aridade em português, para a mensagem de erro do validador. */
export function describeArity(op: ExpressionOperator): string {
  const spec = OPERATORS[op];
  if (spec.max === Infinity) return `pelo menos ${spec.min}`;
  if (spec.min === spec.max) return `exactamente ${spec.min}`;
  return `entre ${spec.min} e ${spec.max}`;
}
