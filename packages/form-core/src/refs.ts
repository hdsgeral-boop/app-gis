/**
 * Referências dentro de expressões (FORM-SPEC §6.1).
 *
 *   "$self"   — o valor do campo onde a expressão está declarada
 *   "$f_cod"  — o valor do campo com `id` f_cod
 *   "$..f_mun"— o mesmo, mas começando a procurar no âmbito pai
 *
 * Uma string que não comece por `$` é um literal. Não há forma de escrever um
 * literal que comece por `$` directamente — usa-se `{"op":"concat",...}`, como
 * diz a spec. É uma limitação deliberada: qualquer outro escape (`$$`, `\$`)
 * seria mais uma regra para o construtor do painel acertar.
 */

export type Reference =
  | { kind: 'self' }
  /** `$id` — procura no âmbito actual e sobe se não encontrar. */
  | { kind: 'field'; id: string }
  /** `$..id` — salta o âmbito actual e começa no pai. */
  | { kind: 'parent'; id: string };

const ID = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** Devolve a referência se a string for uma; `undefined` se for um literal. */
export function parseReference(value: string): Reference | undefined {
  if (!value.startsWith('$')) return undefined;
  if (value === '$self') return { kind: 'self' };
  if (value.startsWith('$..')) {
    const id = value.slice(3);
    return ID.test(id) ? { kind: 'parent', id } : undefined;
  }
  const id = value.slice(1);
  return ID.test(id) ? { kind: 'field', id } : undefined;
}

/** `true` quando a string tem forma de referência mas não é uma válida. */
export function isMalformedReference(value: string): boolean {
  return value.startsWith('$') && parseReference(value) === undefined;
}
