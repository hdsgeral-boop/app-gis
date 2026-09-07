import { isExpression } from './evaluate.js';
import type { FormIndex } from './index-form.js';
import { parseReference } from './refs.js';
import type { ExpressionArg, Field, FieldType } from './types/index.js';

/**
 * Tipo que uma expressão produz.
 *
 * Existe por uma razão concreta: um campo `calculate` tem de virar uma coluna
 * tipada na vista PostGIS, e ninguém escreve o tipo à mão na definição. Sem
 * isto, ou todos os cálculos viravam `text` — e o Power BI somava strings — ou
 * seria preciso pedir o tipo ao autor do formulário, que é exactamente o
 * trabalho que a plataforma existe para poupar.
 *
 * Quando não se consegue decidir, o resultado é `desconhecido`, e quem gera a
 * vista trata isso como texto. Adivinhar mal um tipo numérico é pior do que
 * assumir texto: o texto lê-se sempre.
 */
export type InferredType =
  | 'texto'
  | 'numero'
  | 'inteiro'
  | 'booleano'
  | 'data'
  | 'hora'
  | 'instante'
  | 'lista_de_texto'
  | 'geometria'
  | 'desconhecido';

const POR_TIPO_DE_CAMPO: Record<FieldType, InferredType> = {
  text: 'texto',
  note: 'desconhecido',
  integer: 'inteiro',
  decimal: 'numero',
  boolean: 'booleano',
  select_one: 'texto',
  select_multiple: 'lista_de_texto',
  date: 'data',
  time: 'hora',
  datetime: 'instante',
  geopoint: 'geometria',
  geotrace: 'geometria',
  geoshape: 'geometria',
  photo: 'lista_de_texto',
  audio: 'texto',
  file: 'lista_de_texto',
  signature: 'texto',
  barcode: 'texto',
  calculate: 'desconhecido', // resolvido pela expressão, abaixo
  group: 'desconhecido',
  repeat: 'desconhecido',
  reference: 'texto',
};

const BOOLEANOS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'between',
  'and',
  'or',
  'not',
  'matches',
  'starts_with',
  'ends_with',
  'contains',
  'in',
  'selected',
  'is_null',
]);

const NUMEROS = new Set(['+', '-', '*', '/', 'round', 'sum', 'distance_m']);
const INTEIROS = new Set(['length', 'count', 'count_selected', 'date_diff_days']);
const TEXTOS = new Set(['concat', 'upper', 'lower', 'trim']);

/** Tipo do valor de um campo, ignorando a expressão de `calculation`. */
export function fieldValueType(field: Field): InferredType {
  return POR_TIPO_DE_CAMPO[field.type];
}

export function inferExpressionType(
  node: ExpressionArg,
  index: FormIndex,
  /**
   * Guarda contra uma definição cíclica. O validador recusa ciclos ao
   * publicar, mas o gerador de vistas também corre sobre rascunhos.
   */
  profundidade = 0,
): InferredType {
  if (profundidade > 32) return 'desconhecido';
  if (node === null) return 'desconhecido';
  if (typeof node === 'boolean') return 'booleano';
  if (typeof node === 'number') return Number.isInteger(node) ? 'inteiro' : 'numero';
  if (Array.isArray(node)) return 'lista_de_texto';

  if (typeof node === 'string') {
    const ref = parseReference(node);
    if (!ref) return 'texto'; // literal
    if (ref.kind === 'self') return 'desconhecido';
    const target = index.byId.get(ref.id);
    if (!target) return 'desconhecido';
    return typeOfField(target.field, index, profundidade + 1);
  }

  if (!isExpression(node)) return 'desconhecido';
  const op = node.op as string;

  if (BOOLEANOS.has(op)) return 'booleano';
  if (INTEIROS.has(op)) return 'inteiro';
  if (TEXTOS.has(op)) return 'texto';
  if (op === 'today') return 'data';
  if (op === 'now') return 'instante';

  if (NUMEROS.has(op)) {
    // A soma de inteiros continua inteira; basta um decimal para deixar de ser.
    if (op === '+' || op === '-' || op === '*') {
      const tipos = node.args.map((arg) => inferExpressionType(arg, index, profundidade + 1));
      return tipos.every((t) => t === 'inteiro') ? 'inteiro' : 'numero';
    }
    return 'numero';
  }

  if (op === 'if' || op === 'coalesce') {
    // Os ramos têm de concordar; se não concordarem, é texto, que lê tudo.
    const ramos = (op === 'if' ? node.args.slice(1) : node.args)
      .map((arg) => inferExpressionType(arg, index, profundidade + 1))
      .filter((t) => t !== 'desconhecido');
    const primeiro = ramos[0];
    if (primeiro === undefined) return 'desconhecido';
    return ramos.every((t) => t === primeiro) ? primeiro : 'texto';
  }

  return 'desconhecido';
}

/** Tipo de um campo, já resolvendo a expressão se for `calculate`. */
export function typeOfField(field: Field, index: FormIndex, profundidade = 0): InferredType {
  if (field.calculation && profundidade <= 32) {
    const inferido = inferExpressionType(field.calculation, index, profundidade + 1);
    if (inferido !== 'desconhecido') return inferido;
  }
  return fieldValueType(field);
}
