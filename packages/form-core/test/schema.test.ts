import { describe, expect, it } from 'vitest';

import {
  FIELD_TYPES,
  SPEC_VERSION,
  checkFormDefinitionSchema,
  collectFields,
  fieldPathById,
  findField,
  formDefinitionSchema,
} from '../src/index.js';
import type { FormDefinition } from '../src/index.js';

import localConsumo from './fixtures/local-consumo.json';
import todosOsTipos from './fixtures/todos-os-tipos.json';

function esperaValida(input: unknown): FormDefinition {
  const result = checkFormDefinitionSchema(input);
  if (!result.ok) {
    throw new Error('esperava definição válida, mas: ' + JSON.stringify(result.issues, null, 2));
  }
  return result.definition;
}

function comCampoAlterado(patch: Record<string, unknown>): unknown {
  const base = structuredClone(localConsumo) as Record<string, unknown>;
  const fields = base.fields as Record<string, unknown>[];
  fields[0] = { ...fields[0], ...patch };
  return base;
}

describe('JSON Schema da definição de formulário', () => {
  it('aceita o exemplo do contrato da especificação (§4)', () => {
    const definition = esperaValida(localConsumo);
    expect(definition.title.pt).toBe('Local de Consumo');
    expect(definition.version).toBe(4);
  });

  it('aceita uma definição com um campo de cada tipo suportado', () => {
    const definition = esperaValida(todosOsTipos);
    const tipos = new Set(collectFields(definition).map((v) => v.field.type));
    for (const tipo of FIELD_TYPES) {
      expect(tipos, `o tipo "${tipo}" tem de estar coberto pelas fixtures`).toContain(tipo);
    }
  });

  it('fixa a versão do formato em 1', () => {
    expect(SPEC_VERSION).toBe(1);
    expect(formDefinitionSchema.properties.spec_version.const).toBe(1);
  });
});

describe('rejeições do schema', () => {
  it('recusa um rótulo sem português', () => {
    const result = checkFormDefinitionSchema(comCampoAlterado({ label: { en: 'Code' } }));
    expect(result.ok).toBe(false);
  });

  it('recusa propriedades desconhecidas num campo', () => {
    const result = checkFormDefinitionSchema(comCampoAlterado({ cor_do_botao: 'azul' }));
    expect(result.ok).toBe(false);
  });

  it('recusa um operador de expressão que não existe', () => {
    const result = checkFormDefinitionSchema(
      comCampoAlterado({ constraint: { op: 'shell_exec', args: ['$self'] } }),
    );
    expect(result.ok).toBe(false);
  });

  it('recusa um `id` que não é um identificador seguro', () => {
    const result = checkFormDefinitionSchema(comCampoAlterado({ id: 'código do local' }));
    expect(result.ok).toBe(false);
  });

  it('recusa um `name` com aspas — a barreira contra injecção começa aqui', () => {
    const result = checkFormDefinitionSchema(
      comCampoAlterado({ name: 'x"; drop table records; --' }),
    );
    expect(result.ok).toBe(false);
  });

  it('recusa um select_one sem lista de escolhas', () => {
    const base = structuredClone(localConsumo) as Record<string, unknown>;
    const fields = base.fields as Record<string, unknown>[];
    delete (fields[1] as Record<string, unknown>).choices_ref;
    expect(checkFormDefinitionSchema(base).ok).toBe(false);
  });

  it('recusa uma definição sem campos', () => {
    expect(checkFormDefinitionSchema({ ...localConsumo, fields: [] }).ok).toBe(false);
  });

  it('recusa uma spec_version diferente da suportada', () => {
    expect(checkFormDefinitionSchema({ ...localConsumo, spec_version: 2 }).ok).toBe(false);
  });

  it('aponta o caminho exacto do erro', () => {
    const result = checkFormDefinitionSchema(comCampoAlterado({ id: 'não válido' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith('/fields/0'))).toBe(true);
  });
});

describe('travessia da árvore de campos', () => {
  const definition = esperaValida(todosOsTipos);

  it('vê os campos dentro de grupos e de repetíveis', () => {
    expect(findField(definition, 'f_dentro_grupo')).toBeDefined();
    expect(findField(definition, 'f_aninhado')).toBeDefined();
  });

  it('regista o âmbito de repetição mais próximo', () => {
    expect(findField(definition, 'f_dentro_grupo')?.repeatScope).toBeUndefined();
    expect(findField(definition, 'f_dentro_repeat')?.repeatScope).toBe('g_repeat');
    expect(findField(definition, 'f_aninhado')?.repeatScope).toBe('g_repeat_aninhado');
  });

  it('devolve o caminho completo até um campo aninhado', () => {
    expect(fieldPathById(definition, 'f_aninhado')).toEqual([
      'g_repeat',
      'g_repeat_aninhado',
      'f_aninhado',
    ]);
  });

  it('não inventa campos que não existem', () => {
    expect(findField(definition, 'f_inexistente')).toBeUndefined();
    expect(fieldPathById(definition, 'f_inexistente')).toBeUndefined();
  });
});
