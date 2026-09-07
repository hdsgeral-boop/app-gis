import { isExpression } from './evaluate.js';
import type { FormIndex } from './index-form.js';
import { parseReference, type Reference } from './refs.js';
import type { Expression, ExpressionArg, Field } from './types/index.js';

/**
 * Grafo de dependências entre campos (F1.4 e F1.10).
 *
 * Serve três coisas diferentes com a mesma travessia:
 *   - detectar ciclos, que o validador recusa ao publicar;
 *   - ordenar os cálculos, para um `calculate` que depende de outro estabilizar
 *     numa só passagem em vez de convergir por iteração;
 *   - saber, no telefone, que campos reavaliar quando um valor muda.
 */

/** Onde, dentro de um campo, a expressão estava declarada. */
export type ExpressionSlot = 'relevant' | 'constraint' | 'calculation' | 'instance_label';

export interface FoundReference {
  ref: Reference;
  slot: ExpressionSlot;
  /** Caminho legível até à expressão, para mensagens de erro. */
  path: string;
}

/** Percorre uma expressão e devolve todas as referências que lá aparecem. */
export function collectReferences(
  node: ExpressionArg,
  slot: ExpressionSlot,
  path: string,
  out: FoundReference[] = [],
): FoundReference[] {
  if (typeof node === 'string') {
    const ref = parseReference(node);
    if (ref) out.push({ ref, slot, path });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectReferences(item, slot, `${path}[${i}]`, out));
    return out;
  }
  if (isExpression(node)) {
    node.args.forEach((arg, i) => collectReferences(arg, slot, `${path}.args[${i}]`, out));
  }
  return out;
}

/** As expressões declaradas num campo, com o nome do sítio onde estão. */
export function expressionsOf(field: Field): Array<{ slot: ExpressionSlot; expr: Expression }> {
  const out: Array<{ slot: ExpressionSlot; expr: Expression }> = [];
  if (field.relevant) out.push({ slot: 'relevant', expr: field.relevant });
  if (field.constraint) out.push({ slot: 'constraint', expr: field.constraint });
  if (field.calculation) out.push({ slot: 'calculation', expr: field.calculation });
  if (field.type === 'repeat' && field.instance_label) {
    out.push({ slot: 'instance_label', expr: field.instance_label });
  }
  return out;
}

export interface DependencyGraph {
  /** De que campos depende cada campo (`relevant` + `calculation`). */
  dependsOn: Map<string, Set<string>>;
  /** Quem tem de ser reavaliado quando este campo muda. Inclui `constraint`. */
  dependents: Map<string, Set<string>>;
  /** Só as arestas de `calculation`, para a ordenação topológica. */
  calculationDependsOn: Map<string, Set<string>>;
}

export function buildDependencyGraph(index: FormIndex): DependencyGraph {
  const dependsOn = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const calculationDependsOn = new Map<string, Set<string>>();

  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };

  for (const { field } of index.order) {
    dependsOn.set(field.id, dependsOn.get(field.id) ?? new Set());
    for (const { slot, expr } of expressionsOf(field)) {
      for (const found of collectReferences(expr, slot, `${field.id}.${slot}`)) {
        if (found.ref.kind === 'self') continue; // `$self` não é dependência de outro campo
        const targetId = found.ref.id;
        if (targetId === field.id && slot === 'constraint') continue; // ler-se a si próprio numa restrição é legítimo
        add(dependents, targetId, field.id);
        if (slot === 'relevant' || slot === 'calculation') add(dependsOn, field.id, targetId);
        if (slot === 'calculation') add(calculationDependsOn, field.id, targetId);
      }
      // `sum(repetível, "campo")` depende também do campo somado, cujo `id` vem
      // como literal e por isso não aparece na recolha de referências.
      for (const literal of summedFieldIds(expr)) {
        add(dependents, literal, field.id);
        if (slot === 'calculation') add(calculationDependsOn, field.id, literal);
        if (slot === 'relevant' || slot === 'calculation') add(dependsOn, field.id, literal);
      }
    }
  }

  return { dependsOn, dependents, calculationDependsOn };
}

/** `id` de campos que aparecem como literal no segundo argumento de um `sum`. */
function summedFieldIds(node: ExpressionArg, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item) => summedFieldIds(item, out));
    return out;
  }
  if (isExpression(node)) {
    if (node.op === 'sum' && typeof node.args[1] === 'string') out.push(node.args[1]);
    node.args.forEach((arg) => summedFieldIds(arg, out));
  }
  return out;
}

export interface Cycle {
  /** `id` dos campos do ciclo, pela ordem, com o primeiro repetido no fim. */
  path: string[];
}

/**
 * Ciclos em `relevant` e `calculation`. Um formulário com um ciclo nunca
 * estabiliza: o campo A esconde-se porque B tem valor, e B só tem valor porque
 * A está visível. Recusa-se ao publicar, não em campo.
 */
export function findCycles(graph: DependencyGraph): Cycle[] {
  const cycles: Cycle[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found = new Set<string>();

  const visit = (id: string): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      const path = [...stack.slice(start), id];
      // Normaliza para não reportar o mesmo ciclo uma vez por ponto de entrada.
      const key = [...path.slice(0, -1)].sort().join('>');
      if (!found.has(key)) {
        found.add(key);
        cycles.push({ path });
      }
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    stack.push(id);
    onStack.add(id);
    for (const dep of graph.dependsOn.get(id) ?? []) visit(dep);
    stack.pop();
    onStack.delete(id);
  };

  for (const id of graph.dependsOn.keys()) visit(id);
  return cycles;
}

/**
 * Ordem em que os campos calculados têm de ser avaliados para que uma única
 * passagem baste. Campos sem dependências entre si mantêm a ordem do
 * formulário, para o resultado ser reproduzível.
 */
export function calculationOrder(index: FormIndex, graph: DependencyGraph): string[] {
  const calculated = index.order
    .filter(({ field }) => !!field.calculation)
    .map(({ field }) => field.id);
  const inOrder = new Set(calculated);

  const result: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') return; // ciclo: o validador recusa-o antes de chegarmos aqui
    state.set(id, 'visiting');
    for (const dep of graph.calculationDependsOn.get(id) ?? []) {
      if (inOrder.has(dep)) visit(dep);
    }
    state.set(id, 'done');
    result.push(id);
  };

  for (const id of calculated) visit(id);
  return result;
}
