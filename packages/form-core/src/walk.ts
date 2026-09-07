import type { Field, FormDefinition } from './types/index.js';

/** Um campo com o caminho de contentores que o envolve, do topo para baixo. */
export interface FieldVisit {
  field: Field;
  /** `id` dos grupos/repetíveis que o contêm, do topo para baixo. */
  ancestors: string[];
  /** `id` do repetível mais próximo, ou `undefined` se estiver no âmbito raiz. */
  repeatScope: string | undefined;
}

function childrenOf(field: Field): Field[] | undefined {
  return field.type === 'group' || field.type === 'repeat' ? field.fields : undefined;
}

/**
 * Percorre todos os campos em profundidade, incluindo os que estão dentro de
 * grupos e de repetíveis. É a base de tudo o que precisa de ver a árvore
 * inteira: validação, diff, geração de vistas, renderização.
 */
export function* walkFields(
  fields: readonly Field[],
  ancestors: string[] = [],
  repeatScope: string | undefined = undefined,
): Generator<FieldVisit> {
  for (const field of fields) {
    yield { field, ancestors, repeatScope };
    const children = childrenOf(field);
    if (children) {
      yield* walkFields(
        children,
        [...ancestors, field.id],
        field.type === 'repeat' ? field.id : repeatScope,
      );
    }
  }
}

/** Todos os campos da definição, achatados. */
export function collectFields(definition: FormDefinition): FieldVisit[] {
  return [...walkFields(definition.fields)];
}

/** Procura um campo pelo `id`, em qualquer nível. */
export function findField(definition: FormDefinition, id: string): FieldVisit | undefined {
  for (const visit of walkFields(definition.fields)) {
    if (visit.field.id === id) return visit;
  }
  return undefined;
}

/** Caminho de `id` até um campo, do topo para baixo, incluindo o próprio. */
export function fieldPathById(definition: FormDefinition, id: string): string[] | undefined {
  const visit = findField(definition, id);
  return visit ? [...visit.ancestors, visit.field.id] : undefined;
}
