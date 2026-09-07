import { describe, expect, it } from 'vitest';
import type { Field, FormDefinition, RecordData } from '../src/index.js';

import {
  acrescentarInstancia,
  criarEstado,
  definirValor,
  eRelevante,
  errosPorSeccao,
  errosVisiveis,
  escreverEmCaminho,
  estaValido,
  lerCaminho,
  moverInstancia,
  mostrarTodosOsErros,
  partirCaminho,
  removerInstancia,
  rotulosDasInstancias,
  valorEm,
} from '../src/form-state.js';

/**
 * F3.2 a F3.10 — o renderizador dinâmico, testado na sua parte que importa.
 *
 * O que se prova aqui é o comportamento: relevância que limpa valores, cálculos
 * que se propagam, repetíveis aninhados, e o desempenho por toque. As vistas em
 * React Native por cima disto são finas de propósito — se um erro aparecer, é
 * quase de certeza neste ficheiro que ele já devia ter sido apanhado.
 */

const AGORA = new Date('2026-09-05T14:30:00Z');

function definir(fields: Field[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    spec_version: 1,
    form_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40',
    version: 1,
    title: { pt: 'Formulário de teste' },
    fields,
    ...extra,
  } as FormDefinition;
}

const criar = (definicao: FormDefinition, dados: RecordData = {}) =>
  criarEstado(definicao, dados, { agora: AGORA });

describe('caminhos de instância', () => {
  it('parte e lê caminhos com repetíveis aninhados', () => {
    expect(partirCaminho('g_cont[1].g_leit[0].f_v')).toEqual([
      { id: 'g_cont', indice: 1 },
      { id: 'g_leit', indice: 0 },
      { id: 'f_v', indice: undefined },
    ]);
    const dados = { g_cont: [{}, { g_leit: [{ f_v: 42 }] }] };
    expect(lerCaminho(dados, 'g_cont[1].g_leit[0].f_v')).toBe(42);
  });

  it('escrever num caminho cria o que faltar pelo meio', () => {
    const dados: RecordData = {};
    escreverEmCaminho(dados, 'g_cont[2].f_ns', 'A-3');
    expect((dados['g_cont'] as RecordData[])[2]?.['f_ns']).toBe('A-3');
    expect((dados['g_cont'] as unknown[]).length).toBe(3);
  });
});

describe('F3.2 e F3.7 — secções', () => {
  const definicao = definir([
    { id: 'f_solto', name: 'solto', type: 'text' } as Field,
    {
      id: 'g_a',
      name: 'grupo_a',
      type: 'group',
      label: { pt: 'Identificação' },
      fields: [{ id: 'f_a', name: 'a', type: 'text' } as Field],
    } as Field,
    {
      id: 'g_b',
      name: 'grupo_b',
      type: 'group',
      label: { pt: 'Medições' },
      fields: [{ id: 'f_b', name: 'b', type: 'integer' } as Field],
    } as Field,
  ]);

  it('cada grupo de topo é uma secção, e o que fica solto vai para a primeira', () => {
    const estado = criar(definicao);
    expect(estado.seccoes.map((s) => s.titulo)).toEqual([
      'Formulário de teste',
      'Identificação',
      'Medições',
    ]);
    expect(estado.seccoes[0]?.campos.map((c) => c.id)).toEqual(['f_solto']);
  });

  it('conta os erros por secção, para o cabeçalho os poder mostrar', () => {
    const comObrigatorio = definir([
      {
        id: 'g_a',
        name: 'grupo_a',
        type: 'group',
        label: { pt: 'A' },
        fields: [{ id: 'f_a', name: 'a', type: 'text', required: true } as Field],
      } as Field,
      {
        id: 'g_b',
        name: 'grupo_b',
        type: 'group',
        label: { pt: 'B' },
        fields: [{ id: 'f_b', name: 'b', type: 'text' } as Field],
      } as Field,
    ]);
    expect(errosPorSeccao(criar(comObrigatorio))).toEqual([1, 0]);
  });
});

describe('F3.4 — relevância reactiva', () => {
  const definicao = definir([
    { id: 'f_tipo', name: 'tipo', type: 'text' } as Field,
    {
      id: 'f_pot',
      name: 'potencia',
      type: 'decimal',
      required: true,
      relevant: { op: '==', args: ['$f_tipo', 'industrial'] },
    } as Field,
  ]);

  it('esconder um campo limpa o valor e revalida, na mesma passagem', () => {
    let estado = criar(definicao);
    estado = definirValor(estado, 'f_tipo', 'industrial');
    estado = definirValor(estado, 'f_pot', 250);
    expect(eRelevante(estado, 'f_pot')).toBe(true);
    expect(valorEm(estado, 'f_pot')).toBe(250);

    estado = definirValor(estado, 'f_tipo', 'domestico');
    expect(eRelevante(estado, 'f_pot')).toBe(false);
    expect(valorEm(estado, 'f_pot')).toBeNull();
    // Um campo escondido não é validado, mesmo sendo obrigatório.
    expect(estaValido(estado)).toBe(true);
  });

  it('o campo obrigatório escondido não impede submeter', () => {
    let estado = criar(definicao);
    estado = definirValor(estado, 'f_tipo', 'domestico');
    estado = mostrarTodosOsErros(estado);
    expect(estaValido(estado)).toBe(true);

    estado = definirValor(estado, 'f_tipo', 'industrial');
    expect(estaValido(estado)).toBe(false);
    expect(errosVisiveis(estado, 'f_pot').map((e) => e.code)).toEqual(['obrigatorio']);
  });
});

describe('F3.5 — restrições e mensagens', () => {
  it('mostra a mensagem que o autor escreveu', () => {
    const definicao = definir([
      {
        id: 'f_cod',
        name: 'codigo',
        type: 'text',
        constraint: { op: 'matches', args: ['$self', '^LC[0-9]{6}$'] },
        constraint_message: { pt: 'Formato esperado: LC000000' },
      } as Field,
    ]);
    const estado = definirValor(criar(definicao), 'f_cod', 'errado');
    expect(errosVisiveis(estado, 'f_cod')[0]?.message).toBe('Formato esperado: LC000000');
  });

  it('sem constraint_message, a mensagem por omissão nomeia o campo', () => {
    const definicao = definir([
      {
        id: 'f_cod',
        name: 'codigo',
        type: 'text',
        label: { pt: 'Código do local' },
        constraint: { op: 'matches', args: ['$self', '^LC'] },
      } as Field,
    ]);
    const estado = definirValor(criar(definicao), 'f_cod', 'errado');
    expect(errosVisiveis(estado, 'f_cod')[0]?.message).toContain('Código do local');
  });

  it('um erro só aparece depois de tocar no campo, ou ao tentar submeter', () => {
    const definicao = definir([
      { id: 'f_a', name: 'a', type: 'text', required: true } as Field,
      { id: 'f_b', name: 'b', type: 'text', required: true } as Field,
    ]);
    let estado = criar(definicao);
    // Nada tocado: nenhum erro à vista, apesar de o formulário estar inválido.
    expect(errosVisiveis(estado, 'f_a')).toEqual([]);
    expect(estaValido(estado)).toBe(false);

    estado = definirValor(estado, 'f_a', '');
    expect(errosVisiveis(estado, 'f_a')).toHaveLength(1);
    expect(errosVisiveis(estado, 'f_b')).toEqual([]);

    estado = mostrarTodosOsErros(estado);
    expect(errosVisiveis(estado, 'f_b')).toHaveLength(1);
  });
});

describe('F3.6 — campos calculados', () => {
  const definicao = definir([
    { id: 'f_q', name: 'quantidade', type: 'integer' } as Field,
    { id: 'f_p', name: 'preco', type: 'decimal' } as Field,
    {
      id: 'f_sub',
      name: 'subtotal',
      type: 'calculate',
      calculation: { op: '*', args: ['$f_q', '$f_p'] },
    } as Field,
    {
      id: 'f_iva',
      name: 'com_iva',
      type: 'calculate',
      calculation: { op: 'round', args: [{ op: '*', args: ['$f_sub', 1.14] }, 2] },
    } as Field,
  ]);

  it('recalcula em cadeia ao mudar uma dependência, numa passagem', () => {
    let estado = criar(definicao);
    estado = definirValor(estado, 'f_q', 4);
    estado = definirValor(estado, 'f_p', 250);
    expect(valorEm(estado, 'f_sub')).toBe(1000);
    expect(valorEm(estado, 'f_iva')).toBe(1140);
  });

  it('o valor calculado acompanha a alteração seguinte', () => {
    let estado = criar(definicao, { f_q: 4, f_p: 250 });
    estado = definirValor(estado, 'f_q', 5);
    expect(valorEm(estado, 'f_sub')).toBe(1250);
    expect(valorEm(estado, 'f_iva')).toBe(1425);
  });
});

describe('F3.8 — repetíveis, incluindo aninhados', () => {
  const definicao = definir([
    {
      id: 'g_cont',
      name: 'contadores',
      type: 'repeat',
      label: { pt: 'Contador' },
      instance_label: { op: 'coalesce', args: ['$f_ns', 'sem número'] },
      fields: [
        { id: 'f_ns', name: 'numero_serie', type: 'text', required: true } as Field,
        {
          id: 'g_leit',
          name: 'leituras',
          type: 'repeat',
          fields: [{ id: 'f_v', name: 'valor', type: 'decimal' } as Field],
        } as Field,
        {
          id: 'f_soma',
          name: 'soma',
          type: 'calculate',
          calculation: { op: 'sum', args: ['$g_leit', 'f_v'] },
        } as Field,
      ],
    } as Field,
    {
      id: 'f_n',
      name: 'quantos',
      type: 'calculate',
      calculation: { op: 'count', args: ['$g_cont'] },
    } as Field,
  ]);

  it('acrescenta, preenche e conta', () => {
    let estado = criar(definicao);
    expect(valorEm(estado, 'f_n')).toBe(0);

    estado = acrescentarInstancia(estado, 'g_cont');
    estado = definirValor(estado, 'g_cont[0].f_ns', 'A-1');
    estado = acrescentarInstancia(estado, 'g_cont');
    estado = definirValor(estado, 'g_cont[1].f_ns', 'A-2');

    expect(valorEm(estado, 'f_n')).toBe(2);
    expect(valorEm(estado, 'g_cont[1].f_ns')).toBe('A-2');
  });

  it('cada instância calcula por si', () => {
    let estado = criar(definicao);
    estado = acrescentarInstancia(estado, 'g_cont');
    estado = acrescentarInstancia(estado, 'g_cont[0].g_leit');
    estado = definirValor(estado, 'g_cont[0].g_leit[0].f_v', 10.5);
    estado = acrescentarInstancia(estado, 'g_cont[0].g_leit');
    estado = definirValor(estado, 'g_cont[0].g_leit[1].f_v', 4.5);

    estado = acrescentarInstancia(estado, 'g_cont');
    estado = acrescentarInstancia(estado, 'g_cont[1].g_leit');
    estado = definirValor(estado, 'g_cont[1].g_leit[0].f_v', 7);

    expect(valorEm(estado, 'g_cont[0].f_soma')).toBe(15);
    expect(valorEm(estado, 'g_cont[1].f_soma')).toBe(7);
  });

  it('remove a instância certa e não desalinha as outras', () => {
    let estado = criar(definicao);
    for (const ns of ['A-1', 'A-2', 'A-3']) {
      estado = acrescentarInstancia(estado, 'g_cont');
      const i = (estado.dados['g_cont'] as unknown[]).length - 1;
      estado = definirValor(estado, `g_cont[${i}].f_ns`, ns);
    }
    estado = removerInstancia(estado, 'g_cont', 1);
    expect((estado.dados['g_cont'] as RecordData[]).map((c) => c['f_ns'])).toEqual(['A-1', 'A-3']);
    expect(valorEm(estado, 'f_n')).toBe(2);
  });

  it('reordena', () => {
    let estado = criar(definicao, {
      g_cont: [{ f_ns: 'A-1' }, { f_ns: 'A-2' }, { f_ns: 'A-3' }],
    });
    estado = moverInstancia(estado, 'g_cont', 2, 0);
    expect((estado.dados['g_cont'] as RecordData[]).map((c) => c['f_ns'])).toEqual([
      'A-3',
      'A-1',
      'A-2',
    ]);
  });

  it('o instance_label é o que a lista mostra, com recurso ao número quando está vazio', () => {
    const estado = criar(definicao, { g_cont: [{ f_ns: 'A-1' }, {}] });
    expect(rotulosDasInstancias(estado, 'g_cont')).toEqual(['A-1', 'sem número']);
  });

  it('a relevância e os erros são por instância', () => {
    const comRelevancia = definir([
      {
        id: 'g_c',
        name: 'c',
        type: 'repeat',
        fields: [
          { id: 'f_avariado', name: 'avariado', type: 'boolean' } as Field,
          {
            id: 'f_motivo',
            name: 'motivo',
            type: 'text',
            required: true,
            relevant: { op: '==', args: ['$f_avariado', true] },
          } as Field,
        ],
      } as Field,
    ]);
    let estado = criar(comRelevancia, { g_c: [{ f_avariado: true }, { f_avariado: false }] });
    estado = mostrarTodosOsErros(estado);
    expect(eRelevante(estado, 'g_c[0].f_motivo')).toBe(true);
    expect(eRelevante(estado, 'g_c[1].f_motivo')).toBe(false);
    expect(errosVisiveis(estado, 'g_c[0].f_motivo')).toHaveLength(1);
    expect(errosVisiveis(estado, 'g_c[1].f_motivo')).toHaveLength(0);
  });

  it('um repetível com min abre já com as instâncias mínimas', () => {
    const comMinimo = definir([
      {
        id: 'g_c',
        name: 'c',
        type: 'repeat',
        min: 2,
        fields: [{ id: 'f_x', name: 'x', type: 'text' } as Field],
      } as Field,
    ]);
    expect((criar(comMinimo).dados['g_c'] as unknown[]).length).toBe(2);
  });
});

describe('valores por omissão', () => {
  it('aplicam-se onde não há resposta, e não pisam o que já existe', () => {
    const definicao = definir([
      { id: 'f_a', name: 'a', type: 'text', default: 'inicial' } as Field,
      { id: 'f_b', name: 'b', type: 'integer', default: 0 } as Field,
    ]);
    const estado = criar(definicao, { f_b: 7 });
    expect(valorEm(estado, 'f_a')).toBe('inicial');
    expect(valorEm(estado, 'f_b')).toBe(7);
  });
});

describe('F3.10 — desempenho num formulário grande', () => {
  /** 80 perguntas, com relevância e cálculos encadeados, como um real. */
  function formularioGrande(): FormDefinition {
    const campos: Field[] = [{ id: 'f_tipo', name: 'tipo', type: 'text' } as Field];
    for (let i = 0; i < 40; i++) {
      campos.push({
        id: `f_t${i}`,
        name: `texto_${i}`,
        type: 'text',
        required: i % 4 === 0,
        relevant: { op: '!=', args: ['$f_tipo', 'nenhum'] },
        constraint: { op: '<', args: [{ op: 'length', args: ['$self'] }, 120] },
      } as Field);
    }
    for (let i = 0; i < 20; i++) {
      campos.push({ id: `f_n${i}`, name: `numero_${i}`, type: 'decimal' } as Field);
    }
    for (let i = 0; i < 19; i++) {
      campos.push({
        id: `f_c${i}`,
        name: `calculado_${i}`,
        type: 'calculate',
        calculation: { op: '+', args: [`$f_n${i}`, `$f_n${i + 1}`] },
      } as Field);
    }
    return definir(campos);
  }

  it('cada toque custa menos de 100 ms', () => {
    const definicao = formularioGrande();
    let estado = criar(definicao);
    expect(estado.indice.byId.size).toBe(80);

    // Aquece: a primeira passagem paga a construção do índice e do grafo.
    estado = definirValor(estado, 'f_t0', 'x');

    const inicio = performance.now();
    const toques = 20;
    for (let i = 0; i < toques; i++) {
      estado = definirValor(estado, `f_n${i % 20}`, i);
    }
    const porToque = (performance.now() - inicio) / toques;

    // O critério da F3.10 é 100 ms por toque num Android de gama baixa. Este
    // teste corre num portátil, e mede tipicamente 2 a 5 ms. O limite fica em
    // 50 ms: apanha uma regressão de uma ordem de grandeza — que é o que
    // interessa — sem falhar quando a máquina que corre o CI está carregada.
    expect(porToque).toBeLessThan(50);
  });
});
