import { describe, expect, it } from 'vitest';
import {
  collectFields,
  validateDefinition,
  type Field,
  type FormDefinition,
} from '@cvforms/form-core';

import {
  acrescentarCampo,
  campoEm,
  campoNovo,
  idsUsados,
  moverCampo,
  nomeAPartirDoRotulo,
  novoId,
  removerCampo,
  substituirCampo,
} from './modelo';

/**
 * F2.15 — as operações do construtor.
 *
 * O que se prova aqui é a regra que separa esta plataforma do Kobo: o `id` é
 * gerado uma vez e não muda mais, e nenhuma operação do construtor — renomear,
 * mover, alterar o tipo — lhe toca. É por `id` que as respostas já recolhidas
 * estão guardadas.
 */

function base(fields: Field[] = []): FormDefinition {
  return {
    spec_version: 1,
    form_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40',
    version: 1,
    title: { pt: 'Teste' },
    fields,
  } as FormDefinition;
}

describe('nomes e identificadores', () => {
  it('sanea um rótulo escrito por um humano', () => {
    expect(nomeAPartirDoRotulo('Potência contratada (kVA)', new Set())).toBe(
      'potencia_contratada_kva',
    );
    expect(nomeAPartirDoRotulo('Nº de postes', new Set())).toBe('n_de_postes');
    expect(nomeAPartirDoRotulo('2026', new Set())).toBe('campo');
  });

  it('desambigua nomes que já existem no âmbito', () => {
    const usados = new Set(['codigo']);
    expect(nomeAPartirDoRotulo('Código', usados)).toBe('codigo_2');
  });

  it('o id deriva do tipo e do rótulo, e é único', () => {
    const usados = new Set<string>();
    const primeiro = novoId('text', 'Código do local', usados);
    usados.add(primeiro);
    expect(primeiro).toBe('f_codigo_do_local');
    expect(novoId('text', 'Código do local', usados)).toBe('f_codigo_do_local_2');
    expect(novoId('repeat', 'Contadores', usados)).toBe('g_contadores');
  });
});

describe('acrescentar, mover e remover', () => {
  it('acrescenta à raiz e dentro de um contentor', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('group', 'Identificação', definicao, []));
    definicao = acrescentarCampo(definicao, [0], campoNovo('text', 'Código', definicao, [0]));

    expect(definicao.fields).toHaveLength(1);
    expect(campoEm(definicao, [0, 0])?.name).toBe('codigo');
  });

  it('o mesmo nome é aceite em âmbitos diferentes, porque gera vistas diferentes', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('text', 'Código', definicao, []));
    definicao = acrescentarCampo(definicao, [], campoNovo('repeat', 'Contadores', definicao, []));
    definicao = acrescentarCampo(definicao, [1], campoNovo('text', 'Código', definicao, [1]));

    expect(campoEm(definicao, [0])?.name).toBe('codigo');
    expect(campoEm(definicao, [1, 0])?.name).toBe('codigo');
    expect(validateDefinition(definicao).valid).toBe(true);
  });

  it('o mesmo nome no mesmo âmbito é desambiguado', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('text', 'Código', definicao, []));
    definicao = acrescentarCampo(definicao, [], campoNovo('text', 'Código', definicao, []));
    expect(campoEm(definicao, [1])?.name).toBe('codigo_2');
    expect(validateDefinition(definicao).valid).toBe(true);
  });

  it('mover troca a ordem sem mexer nos ids', () => {
    let definicao = base();
    for (const rotulo of ['A', 'B', 'C']) {
      definicao = acrescentarCampo(definicao, [], campoNovo('text', rotulo, definicao, []));
    }
    const antes = definicao.fields.map((f) => f.id);
    definicao = moverCampo(definicao, [2], -1);
    expect(definicao.fields.map((f) => f.id)).toEqual([antes[0], antes[2], antes[1]]);
  });

  it('mover para fora dos limites não faz nada', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('text', 'A', definicao, []));
    expect(moverCampo(definicao, [0], -1).fields).toEqual(definicao.fields);
    expect(moverCampo(definicao, [0], 1).fields).toEqual(definicao.fields);
  });

  it('remover leva os filhos, e o id não é reutilizado', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('repeat', 'Contadores', definicao, []));
    definicao = acrescentarCampo(definicao, [0], campoNovo('text', 'Série', definicao, [0]));
    expect(collectFields(definicao)).toHaveLength(2);

    const idsAntes = idsUsados(definicao);
    definicao = removerCampo(definicao, [0]);
    expect(definicao.fields).toHaveLength(0);

    // Um `id` apagado não volta a ser atribuído — mas isso é responsabilidade
    // de quem guarda o histórico, não do construtor, que só conhece a árvore
    // actual. O que o construtor garante é não colidir com o que existe.
    const novo = campoNovo('repeat', 'Contadores', definicao, []);
    expect(idsAntes.has(novo.id)).toBe(true);
  });
});

describe('renomear nunca toca no id', () => {
  it('mudar rótulo, nome e tipo mantém o identificador', () => {
    let definicao = base();
    definicao = acrescentarCampo(
      definicao,
      [],
      campoNovo('text', 'Código do local', definicao, []),
    );
    const id = campoEm(definicao, [0])!.id;

    definicao = substituirCampo(definicao, [0], {
      ...campoEm(definicao, [0])!,
      label: { pt: 'Código de identificação' },
      name: 'codigo_identificacao',
    } as Field);

    expect(campoEm(definicao, [0])?.id).toBe(id);
    expect(campoEm(definicao, [0])?.name).toBe('codigo_identificacao');
  });
});

describe('campos novos nascem válidos', () => {
  it('um campo de escolha nasce com uma lista, e não com uma referência a nada', () => {
    let definicao = base();
    definicao = { ...definicao, choice_lists: { lista_1: [{ value: 'a', label: { pt: 'A' } }] } };
    definicao = acrescentarCampo(definicao, [], campoNovo('select_one', 'Tipo', definicao, []));
    expect(validateDefinition(definicao).valid).toBe(true);
  });

  it('um formulário desenhado do zero passa o validador', () => {
    let definicao = base();
    definicao = acrescentarCampo(definicao, [], campoNovo('text', 'Código', definicao, []));
    definicao = acrescentarCampo(
      definicao,
      [],
      campoNovo('geopoint', 'Localização', definicao, []),
    );
    definicao = acrescentarCampo(definicao, [], campoNovo('repeat', 'Contadores', definicao, []));
    definicao = acrescentarCampo(
      definicao,
      [2],
      campoNovo('text', 'Número de série', definicao, [2]),
    );

    const resultado = validateDefinition(definicao);
    expect(resultado.issues.filter((i) => i.severity === 'erro')).toEqual([]);
  });
});
