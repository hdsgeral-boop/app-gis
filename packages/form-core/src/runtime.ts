import { buildDependencyGraph, calculationOrder, type DependencyGraph } from './dependencies.js';
import {
  childContext,
  evaluate,
  evaluateBoolean,
  makeContext,
  type EvalContext,
} from './evaluate.js';
import { buildIndex, type FormIndex, type ScopeId } from './index-form.js';
import type { Field, FormDefinition, RecordData } from './types/index.js';

/**
 * Execução de um formulário sobre uma resposta: relevância, cálculos e
 * caminhos de instância. É isto que o renderizador do telefone consome, e é o
 * mesmo código que a API corre ao receber uma revisão — se fossem dois, iam
 * divergir e o telefone gravaria coisas que o servidor recusa.
 */

/**
 * Endereço de um campo numa resposta concreta:
 *   `f_cod`                       — campo à raiz
 *   `g_cont[0].f_ns`              — dentro da primeira instância do repetível
 *   `g_cont[1].g_leit[2].f_valor` — repetível aninhado
 */
export type InstancePath = string;

export interface ScopeInstance {
  /** Valores desta instância, por `id`. É o objecto real dos dados, mutável. */
  values: RecordData;
  ctx: EvalContext;
  /** Prefixo do caminho (`` na raiz, `g_cont[0].` dentro de um repetível). */
  prefix: string;
}

/** Percorre todas as instâncias de um âmbito, seguindo os repetíveis pais. */
export function* scopeInstances(
  index: FormIndex,
  data: RecordData,
  scope: ScopeId,
  now?: Date,
): Generator<ScopeInstance> {
  if (scope === undefined) {
    yield { values: data, ctx: makeContext(data, now ? { now } : {}), prefix: '' };
    return;
  }
  const parent = index.parentScope.get(scope);
  for (const outer of scopeInstances(index, data, parent, now)) {
    const raw = outer.values[scope];
    if (!Array.isArray(raw)) continue;
    for (let i = 0; i < raw.length; i++) {
      const instance = raw[i];
      if (typeof instance !== 'object' || instance === null || Array.isArray(instance)) continue;
      const values = instance as RecordData;
      yield {
        values,
        ctx: childContext(outer.ctx, values),
        prefix: `${outer.prefix}${scope}[${i}].`,
      };
    }
  }
}

/**
 * Aplica todos os `calculation`, por ordem topológica das dependências.
 *
 * Uma passagem chega, porque a ordem garante que cada cálculo já encontra os
 * cálculos de que depende feitos. Sem a ordenação seria preciso iterar até
 * estabilizar, e um formulário grande passaria a custar N passagens por toque.
 */
export function applyCalculations(
  index: FormIndex,
  data: RecordData,
  options: { now?: Date; graph?: DependencyGraph } = {},
): RecordData {
  const graph = options.graph ?? buildDependencyGraph(index);
  for (const id of calculationOrder(index, graph)) {
    const visit = index.byId.get(id);
    if (!visit?.field.calculation) continue;
    for (const instance of scopeInstances(index, data, visit.repeatScope, options.now)) {
      instance.values[id] = evaluate(visit.field.calculation, instance.ctx) ?? null;
    }
  }
  return data;
}

export interface RelevanceResult {
  /** Relevância por caminho de instância. */
  byPath: Map<InstancePath, boolean>;
}

/**
 * Relevância de cada campo, em cada instância. Um campo dentro de um grupo ou
 * repetível não relevante também não é relevante — a regra é estrutural e não
 * se escreve em cada campo.
 */
export function computeRelevance(
  index: FormIndex,
  data: RecordData,
  options: { now?: Date } = {},
): RelevanceResult {
  const byPath = new Map<InstancePath, boolean>();

  const walk = (
    fields: readonly Field[],
    instance: ScopeInstance,
    ancestorRelevant: boolean,
  ): void => {
    for (const field of fields) {
      const path = `${instance.prefix}${field.id}`;
      const own = field.relevant ? evaluateBoolean(field.relevant, instance.ctx) : true;
      const relevant = ancestorRelevant && own;
      byPath.set(path, relevant);

      if (field.type === 'group') {
        walk(field.fields, instance, relevant);
      } else if (field.type === 'repeat') {
        const raw = instance.values[field.id];
        if (Array.isArray(raw)) {
          raw.forEach((item, i) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
            const values = item as RecordData;
            walk(
              field.fields,
              {
                values,
                ctx: childContext(instance.ctx, values),
                prefix: `${instance.prefix}${field.id}[${i}].`,
              },
              relevant,
            );
          });
        }
      }
    }
  };

  for (const root of scopeInstances(index, data, undefined, options.now)) {
    walk(index.definition.fields, root, true);
  }
  return { byPath };
}

/**
 * Limpa o valor dos campos não relevantes. É deliberado e não é opcional: um
 * campo escondido que guarda o valor antigo produz registos com respostas a
 * perguntas que o técnico nunca viu.
 */
export function clearIrrelevant(
  index: FormIndex,
  data: RecordData,
  relevance: RelevanceResult,
): boolean {
  let changed = false;

  const walk = (fields: readonly Field[], instance: ScopeInstance): void => {
    for (const field of fields) {
      const path = `${instance.prefix}${field.id}`;
      const relevant = relevance.byPath.get(path) ?? true;
      if (field.type === 'group') {
        walk(field.fields, instance);
        continue;
      }
      if (!relevant) {
        if (instance.values[field.id] !== undefined && instance.values[field.id] !== null) {
          instance.values[field.id] = null;
          changed = true;
        }
        continue;
      }
      if (field.type === 'repeat') {
        const raw = instance.values[field.id];
        if (Array.isArray(raw)) {
          raw.forEach((item, i) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
            const values = item as RecordData;
            walk(field.fields, {
              values,
              ctx: childContext(instance.ctx, values),
              prefix: `${instance.prefix}${field.id}[${i}].`,
            });
          });
        }
      }
    }
  };

  for (const root of scopeInstances(index, data, undefined)) {
    walk(index.definition.fields, root);
  }
  return changed;
}

export interface FormState {
  data: RecordData;
  relevance: RelevanceResult;
  index: FormIndex;
  graph: DependencyGraph;
}

/**
 * Estado completo de uma resposta: cálculos aplicados, campos não relevantes
 * limpos, relevância final.
 *
 * O ciclo entre cálculos e relevância é resolvido por repetição limitada: um
 * cálculo pode mudar a relevância de um campo, e limpar esse campo pode mudar
 * um cálculo. Como o validador da definição recusa ciclos, isto estabiliza
 * sempre — na prática à segunda passagem. O limite existe para que uma
 * definição corrompida nunca bloqueie o telefone.
 */
export function computeFormState(
  definition: FormDefinition,
  data: RecordData,
  options: { now?: Date; index?: FormIndex; maxPasses?: number } = {},
): FormState {
  const index = options.index ?? buildIndex(definition);
  const graph = buildDependencyGraph(index);
  const maxPasses = options.maxPasses ?? 4;

  let relevance = computeRelevance(index, data, options);
  for (let pass = 0; pass < maxPasses; pass++) {
    const calcOpts: { now?: Date; graph: DependencyGraph } = options.now
      ? { now: options.now, graph }
      : { graph };
    applyCalculations(index, data, calcOpts);
    relevance = computeRelevance(index, data, options);
    const changed = clearIrrelevant(index, data, relevance);
    if (!changed) break;
    relevance = computeRelevance(index, data, options);
  }

  return { data, relevance, index, graph };
}
