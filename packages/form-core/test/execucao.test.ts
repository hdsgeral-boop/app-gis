import { describe, expect, it } from 'vitest';

import {
  applyCalculations,
  buildDependencyGraph,
  buildIndex,
  calculationOrder,
  computeFormState,
} from '../src/index.js';
import type { Field, FormDefinition, RecordData } from '../src/index.js';

/**
 * F1.10 — ordem de cálculo e relevância reactiva.
 *
 * O que se está a proteger: um `calculate` que depende de outro tem de
 * estabilizar numa passagem. Sem ordenação topológica seria preciso iterar até
 * convergir, e num formulário de 80 campos isso custa N passagens por cada
 * toque no ecrã de um telemóvel de gama baixa.
 */

function base(fields: Field[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    spec_version: 1,
    form_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40',
    version: 1,
    title: { pt: 'Teste' },
    fields,
    ...extra,
  } as FormDefinition;
}

const calc = (id: string, calculation: unknown): Field =>
  ({ id, name: id, type: 'calculate', calculation }) as Field;

describe('ordem de cálculo', () => {
  // c depende de b, que depende de a. Declarados pela ordem inversa de
  // propósito: a ordem do formulário não pode decidir a ordem do cálculo.
  const definition = base([
    { id: 'f_a', name: 'a', type: 'decimal' } as Field,
    calc('f_c', { op: '*', args: ['$f_b', 2] }),
    calc('f_b', { op: '+', args: ['$f_a', 1] }),
  ]);

  it('ordena as dependências topologicamente', () => {
    const index = buildIndex(definition);
    const graph = buildDependencyGraph(index);
    expect(calculationOrder(index, graph)).toEqual(['f_b', 'f_c']);
  });

  it('uma passagem chega para um cálculo que depende de outro cálculo', () => {
    const index = buildIndex(definition);
    const data: RecordData = { f_a: 4 };
    applyCalculations(index, data);
    expect(data['f_b']).toBe(5);
    expect(data['f_c']).toBe(10);
  });

  it('recalcula dentro de cada instância de um repetível, isoladamente', () => {
    const definition = base([
      {
        id: 'g_cont',
        name: 'contadores',
        type: 'repeat',
        fields: [
          { id: 'f_ini', name: 'inicial', type: 'decimal' } as Field,
          { id: 'f_fim', name: 'final', type: 'decimal' } as Field,
          calc('f_consumo', { op: '-', args: ['$f_fim', '$f_ini'] }),
        ],
      } as Field,
      calc('f_total', { op: 'sum', args: ['$g_cont', 'f_consumo'] }),
    ]);
    const index = buildIndex(definition);
    const data: RecordData = {
      g_cont: [
        { f_ini: 10, f_fim: 30 },
        { f_ini: 5, f_fim: 12 },
      ],
    };
    applyCalculations(index, data);
    const instancias = data['g_cont'] as RecordData[];
    expect(instancias[0]?.['f_consumo']).toBe(20);
    expect(instancias[1]?.['f_consumo']).toBe(7);
    // O total à raiz já vê os consumos calculados: a ordenação topológica
    // atravessa os âmbitos.
    expect(data['f_total']).toBe(27);
  });
});

describe('relevância', () => {
  const definition = base([
    { id: 'f_tipo', name: 'tipo', type: 'text' } as Field,
    {
      id: 'f_pot',
      name: 'potencia',
      type: 'decimal',
      required: true,
      relevant: { op: '==', args: ['$f_tipo', 'industrial'] },
    } as Field,
    {
      id: 'g_det',
      name: 'detalhe',
      type: 'group',
      relevant: { op: '==', args: ['$f_tipo', 'industrial'] },
      fields: [{ id: 'f_obs', name: 'observacoes', type: 'text' } as Field],
    } as Field,
  ]);

  it('esconder um campo limpa o valor na mesma passagem', () => {
    const state = computeFormState(definition, { f_tipo: 'domestico', f_pot: 250 });
    expect(state.relevance.byPath.get('f_pot')).toBe(false);
    expect(state.data['f_pot']).toBeNull();
  });

  it('um campo dentro de um grupo não relevante também não é relevante', () => {
    const state = computeFormState(definition, { f_tipo: 'domestico', f_obs: 'nota' });
    expect(state.relevance.byPath.get('f_obs')).toBe(false);
    expect(state.data['f_obs']).toBeNull();
  });

  it('quando a condição passa a verdadeira, o campo volta a ser relevante', () => {
    const state = computeFormState(definition, { f_tipo: 'industrial', f_pot: 250 });
    expect(state.relevance.byPath.get('f_pot')).toBe(true);
    expect(state.data['f_pot']).toBe(250);
  });

  it('a relevância é por instância de repetível, não por campo', () => {
    const definition = base([
      {
        id: 'g_cont',
        name: 'contadores',
        type: 'repeat',
        fields: [
          { id: 'f_avariado', name: 'avariado', type: 'boolean' } as Field,
          {
            id: 'f_motivo',
            name: 'motivo',
            type: 'text',
            relevant: { op: '==', args: ['$f_avariado', true] },
          } as Field,
        ],
      } as Field,
    ]);
    const state = computeFormState(definition, {
      g_cont: [
        { f_avariado: true, f_motivo: 'queimado' },
        { f_avariado: false, f_motivo: 'lixo que ficou de antes' },
      ],
    });
    expect(state.relevance.byPath.get('g_cont[0].f_motivo')).toBe(true);
    expect(state.relevance.byPath.get('g_cont[1].f_motivo')).toBe(false);
    const instancias = state.data['g_cont'] as RecordData[];
    expect(instancias[0]?.['f_motivo']).toBe('queimado');
    expect(instancias[1]?.['f_motivo']).toBeNull();
  });

  it('um cálculo que muda a relevância de outro campo estabiliza', () => {
    const definition = base([
      { id: 'f_q', name: 'quantidade', type: 'integer' } as Field,
      calc('f_dobro', { op: '*', args: ['$f_q', 2] }),
      {
        id: 'f_extra',
        name: 'extra',
        type: 'text',
        relevant: { op: '>', args: ['$f_dobro', 10] },
      } as Field,
    ]);
    const comValor = computeFormState(definition, { f_q: 6, f_extra: 'visível' });
    expect(comValor.data['f_dobro']).toBe(12);
    expect(comValor.data['f_extra']).toBe('visível');

    const semValor = computeFormState(definition, { f_q: 2, f_extra: 'já não' });
    expect(semValor.data['f_dobro']).toBe(4);
    expect(semValor.data['f_extra']).toBeNull();
  });
});
