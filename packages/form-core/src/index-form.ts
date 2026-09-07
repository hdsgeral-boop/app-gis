import type { Field, FormDefinition, RepeatField } from './types/index.js';
import { walkFields, type FieldVisit } from './walk.js';

/**
 * Índice de uma definição: resolve qualquer `id` e qualquer âmbito numa
 * passagem, para o validador, o avaliador, o gerador de vistas e o
 * renderizador não voltarem a percorrer a árvore a cada pergunta (F1.1).
 *
 * «Âmbito» aqui é sempre o âmbito de DADOS, ou seja o repetível mais próximo —
 * `undefined` para a raiz. Um `group` não cria âmbito: os seus campos ficam no
 * mesmo nível dos dados e na mesma vista (FORM-SPEC §5.2).
 */
export const ROOT_SCOPE = undefined;
export type ScopeId = string | undefined;

export interface FormIndex {
  definition: FormDefinition;
  /** Todos os campos, por `id`. */
  byId: Map<string, FieldVisit>;
  /** `id` dos campos de cada âmbito, pela ordem em que aparecem. */
  fieldsByScope: Map<ScopeId, string[]>;
  /** Repetíveis existentes, por `id`. */
  repeats: Map<string, RepeatField>;
  /** Âmbito pai de cada âmbito de repetível. */
  parentScope: Map<string, ScopeId>;
  /** Ordem de visita da árvore inteira, achatada. */
  order: FieldVisit[];
}

export function buildIndex(definition: FormDefinition): FormIndex {
  const byId = new Map<string, FieldVisit>();
  const fieldsByScope = new Map<ScopeId, string[]>([[ROOT_SCOPE, []]]);
  const repeats = new Map<string, RepeatField>();
  const parentScope = new Map<string, ScopeId>();
  const order: FieldVisit[] = [];

  for (const visit of walkFields(definition.fields)) {
    order.push(visit);
    // Um `id` duplicado é erro do validador, não deste índice. Aqui fica o
    // primeiro, para que as mensagens de erro apontem para o original.
    if (!byId.has(visit.field.id)) byId.set(visit.field.id, visit);

    const scope = visit.repeatScope;
    const list = fieldsByScope.get(scope);
    if (list) list.push(visit.field.id);
    else fieldsByScope.set(scope, [visit.field.id]);

    if (visit.field.type === 'repeat') {
      repeats.set(visit.field.id, visit.field);
      parentScope.set(visit.field.id, visit.repeatScope);
      if (!fieldsByScope.has(visit.field.id)) fieldsByScope.set(visit.field.id, []);
    }
  }

  return { definition, byId, fieldsByScope, repeats, parentScope, order };
}

/** Âmbito de dados onde o campo vive. */
export function scopeOf(index: FormIndex, id: string): ScopeId {
  return index.byId.get(id)?.repeatScope;
}

/** Cadeia de âmbitos, do actual até à raiz. */
export function scopeChain(index: FormIndex, scope: ScopeId): ScopeId[] {
  const chain: ScopeId[] = [scope];
  let current = scope;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (visited.has(current)) break; // defesa contra árvore corrompida
    visited.add(current);
    current = index.parentScope.get(current);
    chain.push(current);
  }
  return chain;
}

/**
 * Um campo é visível de um âmbito se viver nesse âmbito ou num âmbito acima.
 * O contrário — ler de fora um campo que está dentro de um repetível — não faz
 * sentido: há N instâncias e a expressão não diz qual. Para isso existem o
 * `count` e o `sum`.
 */
export function isVisibleFrom(index: FormIndex, id: string, from: ScopeId): boolean {
  const target = index.byId.get(id);
  if (!target) return false;
  return scopeChain(index, from).includes(target.repeatScope);
}

/** Campos com valor (exclui `note`, `group` e `repeat`) de um âmbito. */
export function valueFieldsOfScope(index: FormIndex, scope: ScopeId): Field[] {
  return (index.fieldsByScope.get(scope) ?? [])
    .map((id) => index.byId.get(id)?.field)
    .filter((f): f is Field => !!f && f.type !== 'note' && f.type !== 'group');
}
