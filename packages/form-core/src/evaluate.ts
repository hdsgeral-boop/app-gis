import { distanceMeters } from './geo.js';
import { OPERATORS, isOperator } from './operators.js';
import { parseReference } from './refs.js';
import type { Expression, ExpressionArg, ExpressionOperator, RecordData } from './types/index.js';

/**
 * Avaliador da linguagem de expressões (FORM-SPEC §6).
 *
 * AST pura: nada de `eval`, nada de strings interpretadas (restrição
 * inegociável 7). Corre igual no servidor e no telefone — é o mesmo ficheiro.
 *
 * Semântica de nulos, que é onde estas linguagens costumam falhar:
 *   - qualquer comparação com `null` dá `null`, não `false`;
 *   - `and`/`or` são de três valores, como em SQL, e fazem curto-circuito;
 *   - num contexto de decisão (relevância, restrição), `null` conta como falso.
 * A tabela de verdade completa está em `test/avaliador.test.ts`.
 */

/** Âmbito de avaliação. Encadeia-se para dentro de cada instância de repetível. */
export interface EvalContext {
  /** Valores do âmbito actual, por `id` de campo. */
  values: RecordData;
  /** Âmbito imediatamente acima. Ausente na raiz. */
  parent?: EvalContext;
  /** Valor de `$self`. Só existe dentro de um `constraint`. */
  self?: unknown;
  /**
   * Instante «agora» para `today` e `now`. Injectável de propósito: sem isto
   * não há teste reproduzível de nada que dependa da data.
   */
  now?: Date;
}

export function makeContext(values: RecordData, extra: Partial<EvalContext> = {}): EvalContext {
  return { values, ...extra };
}

/** Âmbito de uma instância de repetível, com o âmbito de fora como pai. */
export function childContext(parent: EvalContext, values: RecordData): EvalContext {
  return { values, parent, now: parent.now };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coerções
// ─────────────────────────────────────────────────────────────────────────────

export function isNullish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Booleano de três valores. `null` significa «indefinido» e propaga-se; só
 * quem toma a decisão final (relevância, restrição) é que o colapsa em falso.
 */
function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (isNullish(value)) return null;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '0' && value.toLowerCase() !== 'false';
  return true;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_TEXT = /^\s*[-+]?\d+(\.\d+)?\s*$/;

/** Milissegundos desde a época, ou `null` se não for data reconhecível. */
function toEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  // Uma data sem hora é interpretada em UTC. `Date.parse('2026-09-05')` já o
  // faz, mas deixá-lo explícito evita depender desse detalhe do runtime.
  const iso = DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isDateLike(value: unknown): boolean {
  return typeof value === 'string' && !NUMERIC_TEXT.test(value) && toEpoch(value) !== null;
}

interface GeoLike {
  lat: number;
  lon: number;
}

function toGeo(value: unknown): GeoLike | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const lat = toNumber(v['lat']);
  const lon = toNumber(v['lon']);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

/** Valores de um `select_multiple`, aceitando também a forma ODK «a b c». */
function toSelection(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return value === '' ? [] : value.split(/\s+/);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolução de referências
// ─────────────────────────────────────────────────────────────────────────────

function lookup(ctx: EvalContext | undefined, id: string): unknown {
  // Sobe a cadeia de âmbitos. Como os `id` são únicos em toda a definição, não
  // há ambiguidade possível: ou o campo está neste âmbito, ou está acima.
  for (let scope = ctx; scope; scope = scope.parent) {
    if (Object.prototype.hasOwnProperty.call(scope.values, id)) return scope.values[id] ?? null;
  }
  return null;
}

function resolveString(value: string, ctx: EvalContext): unknown {
  const ref = parseReference(value);
  if (!ref) return value; // literal
  if (ref.kind === 'self') return ctx.self ?? null;
  if (ref.kind === 'parent') return lookup(ctx.parent, ref.id);
  return lookup(ctx, ref.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Avaliação
// ─────────────────────────────────────────────────────────────────────────────

export function isExpression(value: unknown): value is Expression {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { op?: unknown }).op === 'string' &&
    Array.isArray((value as { args?: unknown }).args)
  );
}

const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    // Padrão inválido não rebenta a recolha em campo: dá `null`, e o validador
    // da definição já o apanhou muito antes, ao publicar.
    compiled = null;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

export function evaluate(node: ExpressionArg, ctx: EvalContext): unknown {
  if (typeof node === 'string') return resolveString(node, ctx);
  if (Array.isArray(node)) return node.map((item) => evaluate(item, ctx));
  if (isExpression(node)) return applyOperator(node, ctx);
  return node ?? null;
}

/** Avalia e colapsa em booleano. É o que decide relevância e restrições. */
export function evaluateBoolean(node: ExpressionArg, ctx: EvalContext): boolean {
  return toBool(evaluate(node, ctx)) === true;
}

function nowOf(ctx: EvalContext): Date {
  return ctx.now ?? new Date();
}

function compare(a: unknown, b: unknown): number | null {
  if (isNullish(a) || isNullish(b)) return null;
  if (isDateLike(a) || isDateLike(b)) {
    const ea = toEpoch(a);
    const eb = toEpoch(b);
    if (ea === null || eb === null) return null;
    return ea === eb ? 0 : ea < eb ? -1 : 1;
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = toText(a);
  const sb = toText(b);
  if (sa !== null && sb !== null) return sa === sb ? 0 : sa < sb ? -1 : 1;
  return null;
}

function equals(a: unknown, b: unknown): boolean | null {
  if (isNullish(a) || isNullish(b)) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    const sa = toSelection(a);
    const sb = toSelection(b);
    if (sa === null || sb === null) return null;
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const ba = toBool(a);
    const bb = toBool(b);
    return ba === null || bb === null ? null : ba === bb;
  }
  const cmp = compare(a, b);
  return cmp === null ? null : cmp === 0;
}

function arithmetic(op: '+' | '-' | '*' | '/', values: unknown[]): number | null {
  const nums: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (n === null) return null; // nulo contamina toda a conta
    nums.push(n);
  }
  const first = nums[0];
  if (first === undefined) return null;
  let acc = first;
  for (const n of nums.slice(1)) {
    if (op === '+') acc += n;
    else if (op === '-') acc -= n;
    else if (op === '*') acc *= n;
    else {
      if (n === 0) return null; // divisão por zero é nulo, nunca Infinity
      acc /= n;
    }
  }
  return acc;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  // A correcção por epsilon resolve o clássico 1.005 → 1.00: sem ela, o valor
  // que o técnico vê no ecrã e o que fica gravado divergem na segunda casa.
  const corrected =
    scaled >= 0
      ? scaled + Number.EPSILON * Math.abs(scaled)
      : scaled - Number.EPSILON * Math.abs(scaled);
  return Math.round(corrected) / factor;
}

/** Instâncias de um repetível, tal como estão nos dados. */
function toInstances(value: unknown): RecordData[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (v): v is RecordData => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

function applyOperator(expr: Expression, ctx: EvalContext): unknown {
  const op = expr.op;
  if (!isOperator(op)) return null;
  const spec = OPERATORS[op as ExpressionOperator];
  if (expr.args.length < spec.min || expr.args.length > spec.max) return null;

  // Curto-circuito: `and` e `or` não avaliam o que não precisam. Importa para
  // além do desempenho — é o que permite `and(not(is_null($x)), $x > 3)`.
  if (op === 'and') {
    let sawNull = false;
    for (const arg of expr.args) {
      const b = toBool(evaluate(arg, ctx));
      if (b === false) return false;
      if (b === null) sawNull = true;
    }
    return sawNull ? null : true;
  }
  if (op === 'or') {
    let sawNull = false;
    for (const arg of expr.args) {
      const b = toBool(evaluate(arg, ctx));
      if (b === true) return true;
      if (b === null) sawNull = true;
    }
    return sawNull ? null : false;
  }
  if (op === 'if') {
    const cond = toBool(evaluate(expr.args[0] as ExpressionArg, ctx));
    return evaluate((cond === true ? expr.args[1] : expr.args[2]) as ExpressionArg, ctx);
  }
  if (op === 'coalesce') {
    for (const arg of expr.args) {
      const v = evaluate(arg, ctx);
      if (!isNullish(v)) return v;
    }
    return null;
  }
  if (op === 'count' || op === 'count_selected' || op === 'sum') {
    return aggregate(op, expr, ctx);
  }

  const args = expr.args.map((arg) => evaluate(arg, ctx));
  const [a, b, c] = args;

  switch (op) {
    case '==':
      return equals(a, b);
    case '!=': {
      const eq = equals(a, b);
      return eq === null ? null : !eq;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const cmp = compare(a, b);
      if (cmp === null) return null;
      return op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp >= 0;
    }
    case 'between': {
      const low = compare(a, b);
      const high = compare(a, c);
      if (low === null || high === null) return null;
      return low >= 0 && high <= 0;
    }
    case 'not': {
      const v = toBool(a);
      return v === null ? null : !v;
    }
    case '+':
    case '-':
    case '*':
    case '/':
      return arithmetic(op, args);
    case 'round': {
      const n = toNumber(a);
      if (n === null) return null;
      const decimals = args.length > 1 ? (toNumber(b) ?? 0) : 0;
      return roundTo(n, Math.trunc(decimals));
    }
    case 'matches': {
      const text = toText(a);
      const pattern = toText(b);
      if (text === null || pattern === null) return null;
      const re = compileRegex(pattern);
      return re === null ? null : re.test(text);
    }
    case 'starts_with':
    case 'ends_with':
    case 'contains': {
      const text = toText(a);
      const needle = toText(b);
      if (text === null || needle === null) return null;
      return op === 'starts_with'
        ? text.startsWith(needle)
        : op === 'ends_with'
          ? text.endsWith(needle)
          : text.includes(needle);
    }
    case 'length': {
      if (Array.isArray(a)) return a.length;
      const text = toText(a);
      return text === null ? null : text.length;
    }
    case 'concat':
      return args.map((v) => (isNullish(v) ? '' : (toText(v) ?? ''))).join('');
    case 'upper':
    case 'lower':
    case 'trim': {
      const text = toText(a);
      if (text === null) return null;
      return op === 'upper'
        ? text.toUpperCase()
        : op === 'lower'
          ? text.toLowerCase()
          : text.trim();
    }
    case 'in': {
      if (isNullish(a)) return null;
      const list = Array.isArray(b) ? b : toSelection(b);
      if (list === null) return null;
      return list.some((item) => equals(a, item) === true);
    }
    case 'selected': {
      const selection = toSelection(a);
      const needle = toText(b);
      if (selection === null || needle === null) return null;
      return selection.includes(needle);
    }
    case 'is_null':
      return isNullish(a);
    case 'today':
      return nowOf(ctx).toISOString().slice(0, 10);
    case 'now':
      return nowOf(ctx).toISOString();
    case 'date_diff_days': {
      const ea = toEpoch(a);
      const eb = toEpoch(b);
      if (ea === null || eb === null) return null;
      return Math.trunc((ea - eb) / 86_400_000);
    }
    case 'distance_m': {
      const p1 = toGeo(a);
      const p2 = toGeo(b);
      if (!p1 || !p2) return null;
      return distanceMeters(p1, p2);
    }
    default:
      return null;
  }
}

/**
 * `count`, `count_selected` e `sum` — os únicos operadores que olham para
 * dentro de um repetível a partir de fora dele.
 */
function aggregate(
  op: 'count' | 'count_selected' | 'sum',
  expr: Expression,
  ctx: EvalContext,
): unknown {
  const target = evaluate(expr.args[0] as ExpressionArg, ctx);

  if (op === 'count_selected') {
    const selection = toSelection(target);
    return selection === null ? 0 : selection.length;
  }

  const instances = toInstances(target);
  if (op === 'count') return instances === null ? 0 : instances.length;

  // sum(repetível, "id_do_campo"): o segundo argumento é literal, nunca uma
  // referência — o campo somado vive dentro de cada instância.
  const fieldId = expr.args[1];
  if (typeof fieldId !== 'string' || instances === null) return 0;
  let total = 0;
  for (const instance of instances) {
    const n = toNumber(instance[fieldId]);
    if (n !== null) total += n;
  }
  return total;
}
