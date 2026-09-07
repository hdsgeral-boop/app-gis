import { describe, expect, it } from 'vitest';

import { validateAnswers } from '../src/index.js';
import type { Field, FormDefinition, RecordData } from '../src/index.js';

import localConsumo from './fixtures/local-consumo.json';

/**
 * F1.11 e F1.12 — validação de respostas.
 *
 * As duas regras que este ficheiro existe para garantir:
 *   - um campo não relevante não é validado, mesmo sendo obrigatório;
 *   - uma resposta inválida devolve TODOS os erros, não só o primeiro.
 */

const definition = localConsumo as unknown as FormDefinition;

const PONTO = {
  lat: -8.8383,
  lon: 13.2344,
  accuracy_m: 0.8,
  fix_type: 'fixed',
  source: 'external_tcp',
};

function valida(data: RecordData, def: FormDefinition = definition, options = {}) {
  return validateAnswers(def, structuredClone(data), options);
}

function codigos(data: RecordData, def: FormDefinition = definition): string[] {
  return valida(data, def)
    .issues.filter((i) => i.severity === 'erro')
    .map((i) => i.code);
}

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

describe('resposta completa', () => {
  it('aceita uma resposta válida do formulário de referência', () => {
    const result = valida({
      f_cod: 'LC000123',
      f_tipo: 'industrial',
      f_pot: 250,
      f_geo: PONTO,
      g_cont: [{ f_ns: 'A-1' }],
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('relevância (F1.11)', () => {
  it('um campo não relevante não é validado, mesmo sendo obrigatório', () => {
    const def = base([
      { id: 'f_t', name: 't', type: 'text' } as Field,
      {
        id: 'f_p',
        name: 'p',
        type: 'decimal',
        required: true,
        relevant: { op: '==', args: ['$f_t', 'industrial'] },
      } as Field,
    ]);
    expect(codigos({ f_t: 'domestico' }, def)).toEqual([]);
    expect(codigos({ f_t: 'industrial' }, def)).toEqual(['obrigatorio']);
  });

  it('um campo não relevante com valor a mais não gera erro de tipo: o valor é limpo', () => {
    const def = base([
      { id: 'f_t', name: 't', type: 'text' } as Field,
      {
        id: 'f_n',
        name: 'n',
        type: 'integer',
        relevant: { op: '==', args: ['$f_t', 'sim'] },
      } as Field,
    ]);
    const result = valida({ f_t: 'não', f_n: 'isto não é um inteiro' }, def);
    expect(result.issues).toEqual([]);
    expect(result.data['f_n']).toBeNull();
  });
});

describe('todos os erros de uma vez (F1.12)', () => {
  it('uma resposta com vários problemas devolve-os todos', () => {
    const result = valida({
      f_cod: 'errado', // falha o constraint
      f_tipo: 'inexistente', // não é opção da lista
      f_pot: 5000, // fora do between, e relevante porque o tipo não é industrial? não: fica irrelevante
      f_geo: { lat: -8.8, lon: 13.2 }, // sem accuracy_m, fix_type nem source
      g_cont: [{}, { f_ns: 'ok' }], // a primeira instância sem número de série
    });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('restricao'); // f_cod
    expect(codes).toContain('escolha_invalida'); // f_tipo
    expect(codes).toContain('ponto_sem_metadados'); // f_geo
    expect(codes).toContain('obrigatorio'); // g_cont[0].f_ns
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
    expect(result.valid).toBe(false);
  });

  it('o erro traz o caminho da instância, e não só o id do campo', () => {
    const result = valida({
      f_cod: 'LC000123',
      f_tipo: 'domestico',
      f_geo: PONTO,
      g_cont: [{ f_ns: 'A-1' }, {}],
    });
    const issue = result.issues.find((i) => i.code === 'obrigatorio');
    expect(issue?.path).toBe('g_cont[1].f_ns');
    expect(issue?.fieldId).toBe('f_ns');
  });
});

describe('tipos e restrições', () => {
  const def = base(
    [
      { id: 'f_txt', name: 'txt', type: 'text', max_length: 5 } as Field,
      { id: 'f_int', name: 'int', type: 'integer', min: 0, max: 10 } as Field,
      { id: 'f_dec', name: 'dec', type: 'decimal' } as Field,
      { id: 'f_bool', name: 'bool', type: 'boolean' } as Field,
      { id: 'f_data', name: 'data', type: 'date' } as Field,
      { id: 'f_hora', name: 'hora', type: 'time' } as Field,
      { id: 'f_inst', name: 'inst', type: 'datetime' } as Field,
      {
        id: 'f_multi',
        name: 'multi',
        type: 'select_multiple',
        choices_ref: 'l1',
        min_selected: 1,
        max_selected: 2,
      } as Field,
    ],
    {
      choice_lists: {
        l1: [
          { value: 'a', label: { pt: 'A' } },
          { value: 'b', label: { pt: 'B' } },
          { value: 'c', label: { pt: 'C' } },
        ],
      },
    },
  );

  it('recusa texto acima do comprimento máximo', () => {
    expect(codigos({ f_txt: 'demasiado longo' }, def)).toContain('comprimento_excedido');
  });

  it('recusa um inteiro com casas decimais', () => {
    expect(codigos({ f_int: 3.5 }, def)).toContain('tipo_invalido');
  });

  it('recusa valores fora do intervalo, nos dois sentidos', () => {
    expect(codigos({ f_int: -1 }, def)).toContain('fora_do_intervalo');
    expect(codigos({ f_int: 11 }, def)).toContain('fora_do_intervalo');
    expect(codigos({ f_int: 0 }, def)).toEqual([]);
    expect(codigos({ f_int: 10 }, def)).toEqual([]);
  });

  it('recusa um booleano escrito como texto', () => {
    expect(codigos({ f_bool: 'sim' }, def)).toContain('tipo_invalido');
  });

  it('recusa datas e horas mal formadas', () => {
    expect(codigos({ f_data: '05/09/2026' }, def)).toContain('tipo_invalido');
    expect(codigos({ f_data: '2026-13-45' }, def)).toContain('tipo_invalido');
    expect(codigos({ f_hora: '25:00' }, def)).toContain('tipo_invalido');
    expect(codigos({ f_inst: 'ontem' }, def)).toContain('tipo_invalido');
    expect(
      codigos({ f_data: '2026-09-05', f_hora: '14:30', f_inst: '2026-09-05T14:30:00Z' }, def),
    ).toEqual([]);
  });

  it('valida a cardinalidade e a pertença das escolhas múltiplas', () => {
    expect(codigos({ f_multi: [] }, def)).toEqual([]); // lista vazia é ausência de resposta
    expect(codigos({ f_multi: ['a', 'b', 'c'] }, def)).toContain('muitas_escolhas');
    expect(codigos({ f_multi: ['z'] }, def)).toContain('escolha_invalida');
    expect(codigos({ f_multi: ['a', 'a'] }, def)).toContain('escolha_repetida');
    expect(codigos({ f_multi: ['a', 'b'] }, def)).toEqual([]);
  });

  it('allow_other aceita um valor fora da lista', () => {
    const comOutro = base(
      [{ id: 'f_s', name: 's', type: 'select_one', choices_ref: 'l1', allow_other: true } as Field],
      { choice_lists: { l1: [{ value: 'a', label: { pt: 'A' } }] } },
    );
    expect(codigos({ f_s: 'qualquer coisa' }, comOutro)).toEqual([]);
  });

  it('a mensagem da restrição é a que o autor escreveu', () => {
    const result = valida({ f_cod: 'errado', f_tipo: 'domestico', f_geo: PONTO });
    expect(result.issues.find((i) => i.code === 'restricao')?.message).toBe(
      'Formato esperado: LC000000',
    );
  });
});

describe('restrição inegociável 8 — metadados do ponto', () => {
  const def = base([{ id: 'f_geo', name: 'geo', type: 'geopoint' } as Field]);

  it('recusa um ponto sem accuracy_m, fix_type ou source', () => {
    expect(codigos({ f_geo: { lat: -8.8, lon: 13.2 } }, def)).toEqual([
      'ponto_sem_metadados',
      'ponto_sem_metadados',
      'ponto_sem_metadados',
    ]);
  });

  it('recusa um fix_type que não existe', () => {
    expect(codigos({ f_geo: { ...PONTO, fix_type: 'inventado' } }, def)).toContain(
      'ponto_sem_metadados',
    );
  });

  it('recusa coordenadas fora do intervalo', () => {
    expect(codigos({ f_geo: { ...PONTO, lat: 100 } }, def)).toContain('coordenada_invalida');
  });

  it('aceita um ponto completo', () => {
    expect(codigos({ f_geo: PONTO }, def)).toEqual([]);
  });
});

describe('limiar de precisão', () => {
  const def = base([{ id: 'f_geo', name: 'geo', type: 'geopoint' } as Field], {
    settings: { max_accuracy_m: 2 },
  });

  it('acima do limiar sem justificação é erro', () => {
    const result = valida({ f_geo: { ...PONTO, accuracy_m: 12 } }, def);
    expect(result.issues.map((i) => i.code)).toContain('precisao_acima_do_limiar');
    expect(result.valid).toBe(false);
  });

  it('acima do limiar com justificação escrita grava, e fica o aviso', () => {
    const result = valida({ f_geo: { ...PONTO, accuracy_m: 12 } }, def, {
      accuracyOverrideReason: 'Sem céu aberto: recolhido junto ao muro do PT.',
    });
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('precisao_acima_do_limiar_justificada');
  });

  it('o limiar do campo sobrepõe-se ao do formulário', () => {
    const comLimiarProprio = base(
      [{ id: 'f_geo', name: 'geo', type: 'geopoint', max_accuracy_m: 20 } as Field],
      { settings: { max_accuracy_m: 2 } },
    );
    expect(codigos({ f_geo: { ...PONTO, accuracy_m: 12 } }, comLimiarProprio)).toEqual([]);
  });
});

describe('repetíveis', () => {
  const def = base([
    {
      id: 'g_rep',
      name: 'rep',
      type: 'repeat',
      min: 1,
      max: 2,
      fields: [{ id: 'f_x', name: 'x', type: 'text', required: true } as Field],
    } as Field,
  ]);

  it('exige o mínimo de instâncias', () => {
    expect(codigos({ g_rep: [] }, def)).toContain('repeticoes_a_menos');
  });

  it('recusa acima do máximo', () => {
    expect(codigos({ g_rep: [{ f_x: 'a' }, { f_x: 'b' }, { f_x: 'c' }] }, def)).toContain(
      'repeticoes_a_mais',
    );
  });

  it('valida cada instância por si', () => {
    const result = valida({ g_rep: [{ f_x: 'a' }, {}] }, def);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('g_rep[1].f_x');
  });
});
