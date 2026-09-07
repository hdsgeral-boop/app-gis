import { describe, expect, it } from 'vitest';

import { buildIndex, scopeChain, validateDefinition } from '../src/index.js';
import type { Field, FormDefinition } from '../src/index.js';

import localConsumo from './fixtures/local-consumo.json';

/**
 * F1.1 a F1.5 — índice da árvore e validador semântico.
 *
 * As 12 regras da §8 do FORM-SPEC, cada uma com o seu caso. Um formulário que
 * falhe aqui nunca chega a um telefone: é recusado ao publicar.
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

const texto = (id: string, name = id, extra: Partial<Field> = {}): Field =>
  ({ id, name, type: 'text', label: { pt: id }, ...extra }) as Field;

/** Códigos de erro emitidos, para as asserções lerem-se como a §8. */
function erros(definition: FormDefinition, knownFormIds?: string[]): string[] {
  const options = knownFormIds ? { knownFormIds } : {};
  return validateDefinition(definition, options)
    .issues.filter((i) => i.severity === 'erro')
    .map((i) => i.code);
}

describe('F1.1 — índice e âmbitos', () => {
  const definition = localConsumo as unknown as FormDefinition;
  const index = buildIndex(definition);

  it('indexa todos os campos, incluindo os de dentro dos repetíveis', () => {
    expect([...index.byId.keys()]).toEqual(
      expect.arrayContaining(['f_cod', 'f_tipo', 'f_pot', 'f_geo', 'g_cont', 'f_ns', 'f_foto']),
    );
  });

  it('resolve o âmbito de qualquer id', () => {
    expect(index.byId.get('f_cod')?.repeatScope).toBeUndefined();
    expect(index.byId.get('f_ns')?.repeatScope).toBe('g_cont');
  });

  it('um grupo não cria âmbito de dados; um repetível cria', () => {
    const def = base([
      {
        id: 'g_id',
        name: 'identificacao',
        type: 'group',
        fields: [texto('f_a')],
      } as Field,
      {
        id: 'g_rep',
        name: 'repeticao',
        type: 'repeat',
        fields: [texto('f_b')],
      } as Field,
    ]);
    const idx = buildIndex(def);
    expect(idx.byId.get('f_a')?.repeatScope).toBeUndefined();
    expect(idx.byId.get('f_b')?.repeatScope).toBe('g_rep');
  });

  it('resolve a cadeia de âmbitos de um repetível aninhado', () => {
    const def = base([
      {
        id: 'g1',
        name: 'g1',
        type: 'repeat',
        fields: [
          {
            id: 'g2',
            name: 'g2',
            type: 'repeat',
            fields: [texto('f_x')],
          } as Field,
        ],
      } as Field,
    ]);
    const idx = buildIndex(def);
    expect(idx.byId.get('f_x')?.repeatScope).toBe('g2');
    expect(scopeChain(idx, 'g2')).toEqual(['g2', 'g1', undefined]);
  });
});

describe('a fixture de referência continua válida', () => {
  it('local-consumo.json passa o validador semântico', () => {
    const result = validateDefinition(localConsumo as unknown as FormDefinition);
    expect(result.issues.filter((i) => i.severity === 'erro')).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('§8 regra 1 — id duplicados', () => {
  it('recusa dois campos com o mesmo id, em níveis diferentes', () => {
    const def = base([
      texto('f_a'),
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [texto('f_a', 'outro_nome')],
      } as Field,
    ]);
    const result = validateDefinition(def);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === 'id_duplicado');
    expect(issue?.path).toBe('g_rep/f_a');
    expect(issue?.message).toContain('f_a');
  });
});

describe('§8 regra 2 — name duplicados no mesmo âmbito', () => {
  it('recusa dois name iguais à raiz', () => {
    expect(erros(base([texto('f_a', 'codigo'), texto('f_b', 'codigo')]))).toContain(
      'name_duplicado',
    );
  });

  it('aceita o mesmo name em âmbitos diferentes, porque geram vistas diferentes', () => {
    const def = base([
      texto('f_a', 'codigo'),
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [texto('f_b', 'codigo')],
      } as Field,
    ]);
    expect(erros(def)).not.toContain('name_duplicado');
  });

  it('um grupo não abre âmbito novo: o name repetido lá dentro colide', () => {
    const def = base([
      texto('f_a', 'codigo'),
      {
        id: 'g_id',
        name: 'grupo',
        type: 'group',
        fields: [texto('f_b', 'codigo')],
      } as Field,
    ]);
    expect(erros(def)).toContain('name_duplicado');
  });
});

describe('§8 regra 3 — ciclos', () => {
  it('recusa A → B → A', () => {
    const def = base([
      texto('f_a', 'a', { relevant: { op: '==', args: ['$f_b', 'x'] } }),
      texto('f_b', 'b', { relevant: { op: '==', args: ['$f_a', 'x'] } }),
    ]);
    const result = validateDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.issues.find((i) => i.code === 'ciclo')?.message).toMatch(/f_a|f_b/);
  });

  it('recusa A → A', () => {
    const def = base([
      {
        id: 'f_c',
        name: 'c',
        type: 'calculate',
        calculation: { op: '+', args: ['$f_c', 1] },
      } as Field,
    ]);
    expect(erros(def)).toContain('ciclo');
  });

  it('aceita um grafo profundo mas acíclico', () => {
    const fields: Field[] = [texto('f_0', 'campo_0')];
    for (let i = 1; i < 30; i++) {
      fields.push({
        id: `f_${i}`,
        name: `campo_${i}`,
        type: 'calculate',
        calculation: { op: 'concat', args: [`$f_${i - 1}`, 'x'] },
      } as Field);
    }
    expect(erros(base(fields))).not.toContain('ciclo');
  });

  it('reporta o mesmo ciclo uma vez só, e não uma por ponto de entrada', () => {
    const def = base([
      texto('f_a', 'a', { relevant: { op: '==', args: ['$f_b', 'x'] } }),
      texto('f_b', 'b', { relevant: { op: '==', args: ['$f_a', 'x'] } }),
    ]);
    const ciclos = validateDefinition(def).issues.filter((i) => i.code === 'ciclo');
    expect(ciclos).toHaveLength(1);
  });
});

describe('§8 regra 4 — referências a campos inexistentes', () => {
  it('recusa referência a um id que não existe', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: '==', args: ['$f_nao_existe', 1] } })]);
    const result = validateDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('referencia_desconhecida');
    expect(result.issues[0]?.path).toBe('f_a.relevant.args[0]');
  });

  it('recusa referência mal formada', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: '==', args: ['$1nao-vale', 1] } })]);
    expect(erros(def)).toContain('referencia_malformada');
  });

  it('recusa ler de fora um campo que vive dentro de um repetível', () => {
    const def = base([
      texto('f_a', 'a', { relevant: { op: '==', args: ['$f_dentro', 1] } }),
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [texto('f_dentro', 'dentro')],
      } as Field,
    ]);
    expect(erros(def)).toContain('referencia_fora_de_ambito');
  });

  it('aceita ler de dentro de um repetível um campo da raiz', () => {
    const def = base([
      texto('f_mun', 'municipio'),
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [texto('f_x', 'x', { relevant: { op: '==', args: ['$f_mun', 'Cacuaco'] } })],
      } as Field,
    ]);
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 5 — choices_ref inexistente', () => {
  it('recusa uma lista que não existe', () => {
    const def = base([
      { id: 'f_s', name: 's', type: 'select_one', choices_ref: 'nao_existe' } as Field,
    ]);
    expect(erros(def)).toContain('lista_desconhecida');
  });

  it('aceita quando a lista existe', () => {
    const def = base([{ id: 'f_s', name: 's', type: 'select_one', choices_ref: 'l1' } as Field], {
      choice_lists: { l1: [{ value: 'a', label: { pt: 'A' } }] },
    });
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 6 — target_form_id inexistente', () => {
  const def = base([
    {
      id: 'f_ref',
      name: 'ref',
      type: 'reference',
      target_form_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d99',
    } as Field,
  ]);

  it('recusa quando o formulário apontado não está na lista dos acessíveis', () => {
    expect(erros(def, ['0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40'])).toContain(
      'formulario_desconhecido',
    );
  });

  it('aceita quando está', () => {
    expect(erros(def, ['0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d99'])).toEqual([]);
  });

  it('sem lista de formulários conhecidos, a regra é saltada em vez de adivinhada', () => {
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 7 — geometry_field', () => {
  it('recusa um geometry_field que não existe', () => {
    const def = base([texto('f_a')], { settings: { geometry_field: 'f_nada' } });
    expect(erros(def)).toContain('geometry_field_invalido');
  });

  it('recusa um geometry_field que não é geopoint', () => {
    const def = base([texto('f_a')], { settings: { geometry_field: 'f_a' } });
    expect(erros(def)).toContain('geometry_field_invalido');
  });

  it('recusa um geopoint que vive dentro de um repetível: o registo só tem uma geometria', () => {
    const def = base(
      [
        {
          id: 'g_rep',
          name: 'rep',
          type: 'repeat',
          fields: [{ id: 'f_geo', name: 'geo', type: 'geopoint' } as Field],
        } as Field,
      ],
      { settings: { geometry_field: 'f_geo' } },
    );
    expect(erros(def)).toContain('geometry_field_invalido');
  });

  it('aceita um geopoint da raiz', () => {
    const def = base([{ id: 'f_geo', name: 'geo', type: 'geopoint' } as Field], {
      settings: { geometry_field: 'f_geo' },
    });
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 8 — $self fora de um constraint', () => {
  it('recusa $self num relevant', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: '==', args: ['$self', 'x'] } })]);
    expect(erros(def)).toContain('self_fora_de_constraint');
  });

  it('aceita $self num constraint', () => {
    const def = base([texto('f_a', 'a', { constraint: { op: '==', args: ['$self', 'x'] } })]);
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 9 — $..x fora de um repetível', () => {
  it('recusa $..x num campo da raiz', () => {
    const def = base([
      texto('f_mun', 'municipio'),
      texto('f_a', 'a', { relevant: { op: '==', args: ['$..f_mun', 'x'] } }),
    ]);
    expect(erros(def)).toContain('ambito_pai_fora_de_repeticao');
  });

  it('aceita $..x dentro de um repetível', () => {
    const def = base([
      texto('f_mun', 'municipio'),
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [texto('f_x', 'x', { relevant: { op: '==', args: ['$..f_mun', 'Cacuaco'] } })],
      } as Field,
    ]);
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 10 — aridade', () => {
  it('recusa argumentos a menos', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: '==', args: ['$f_a'] } })]);
    const result = validateDefinition(def);
    expect(result.issues.find((i) => i.code === 'aridade_invalida')?.message).toContain(
      'exactamente 2',
    );
  });

  it('recusa argumentos a mais num operador de aridade fixa', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: 'not', args: [true, false] } })]);
    expect(erros(def)).toContain('aridade_invalida');
  });

  it('aceita variádicos com mais de dois argumentos', () => {
    const def = base([texto('f_a', 'a', { relevant: { op: 'or', args: [true, false, true] } })]);
    expect(erros(def)).toEqual([]);
  });

  it('recusa um operador que não existe no formato', () => {
    const def = base([
      texto('f_a', 'a', { relevant: { op: 'regex', args: ['$f_a', 'x'] } as never }),
    ]);
    expect(erros(def)).toContain('operador_desconhecido');
  });
});

describe('§8 regra 11 — count e sum sobre algo que não é repetível', () => {
  it('recusa count sobre um campo simples', () => {
    const def = base([
      texto('f_a'),
      {
        id: 'f_c',
        name: 'c',
        type: 'calculate',
        calculation: { op: 'count', args: ['$f_a'] },
      } as Field,
    ]);
    expect(erros(def)).toContain('agregacao_sem_repetivel');
  });

  it('recusa sum sobre um campo que não está dentro do repetível indicado', () => {
    const def = base([
      texto('f_fora', 'fora'),
      { id: 'g_rep', name: 'rep', type: 'repeat', fields: [texto('f_dentro', 'dentro')] } as Field,
      {
        id: 'f_c',
        name: 'c',
        type: 'calculate',
        calculation: { op: 'sum', args: ['$g_rep', 'f_fora'] },
      } as Field,
    ]);
    expect(erros(def)).toContain('campo_somado_fora_do_repetivel');
  });

  it('recusa sum com referência em vez do id em texto simples', () => {
    const def = base([
      { id: 'g_rep', name: 'rep', type: 'repeat', fields: [texto('f_dentro', 'dentro')] } as Field,
      {
        id: 'f_c',
        name: 'c',
        type: 'calculate',
        calculation: { op: 'sum', args: ['$g_rep', '$f_dentro'] },
      } as Field,
    ]);
    expect(erros(def)).toContain('sum_sem_campo');
  });

  it('aceita count e sum bem formados, incluindo em repetível aninhado', () => {
    const def = base([
      {
        id: 'g_rep',
        name: 'rep',
        type: 'repeat',
        fields: [
          { id: 'f_v', name: 'v', type: 'decimal' } as Field,
          {
            id: 'g_sub',
            name: 'sub',
            type: 'repeat',
            fields: [{ id: 'f_w', name: 'w', type: 'decimal' } as Field],
          } as Field,
          {
            id: 'f_sub_total',
            name: 'sub_total',
            type: 'calculate',
            calculation: { op: 'sum', args: ['$g_sub', 'f_w'] },
          } as Field,
        ],
      } as Field,
      {
        id: 'f_total',
        name: 'total',
        type: 'calculate',
        calculation: { op: 'sum', args: ['$g_rep', 'f_v'] },
      } as Field,
      {
        id: 'f_n',
        name: 'n',
        type: 'calculate',
        calculation: { op: 'count', args: ['$g_rep'] },
      } as Field,
    ]);
    expect(erros(def)).toEqual([]);
  });
});

describe('§8 regra 12 — calculation num campo editável', () => {
  it('recusa calculation num campo que não é calculate nem readonly', () => {
    const def = base([texto('f_a', 'a', { calculation: { op: 'concat', args: ['x', 'y'] } })]);
    expect(erros(def)).toContain('calculo_em_campo_editavel');
  });

  it('aceita se estiver readonly', () => {
    const def = base([
      texto('f_a', 'a', { readonly: true, calculation: { op: 'concat', args: ['x', 'y'] } }),
    ]);
    expect(erros(def)).toEqual([]);
  });

  it('aceita num campo do tipo calculate', () => {
    const def = base([
      {
        id: 'f_c',
        name: 'c',
        type: 'calculate',
        calculation: { op: 'concat', args: ['x', 'y'] },
      } as Field,
    ]);
    expect(erros(def)).toEqual([]);
  });
});

describe('avisos que não recusam a publicação', () => {
  it('avisa quando uma restrição usa today ou now', () => {
    const def = base([
      {
        id: 'f_d',
        name: 'd',
        type: 'date',
        constraint: { op: '<=', args: ['$self', { op: 'today', args: [] }] },
      } as Field,
    ]);
    const result = validateDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => i.code)).toContain('restricao_nao_reproduzivel');
  });

  it('recusa valores repetidos numa lista de escolhas', () => {
    const def = base([{ id: 'f_s', name: 's', type: 'select_one', choices_ref: 'l1' } as Field], {
      choice_lists: {
        l1: [
          { value: 'a', label: { pt: 'A' } },
          { value: 'a', label: { pt: 'A outra vez' } },
        ],
      },
    });
    expect(erros(def)).toContain('valor_de_escolha_duplicado');
  });

  it('recusa um repetível com min maior do que max', () => {
    const def = base([
      { id: 'g_rep', name: 'rep', type: 'repeat', min: 5, max: 2, fields: [texto('f_a')] } as Field,
    ]);
    expect(erros(def)).toContain('repetivel_min_maior_que_max');
  });
});
