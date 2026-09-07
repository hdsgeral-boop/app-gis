import { describe, expect, it } from 'vitest';

import { diffDefinitions } from '../src/index.js';
import type { FormDefinition } from '../src/index.js';

import localConsumo from './fixtures/local-consumo.json';

/**
 * F1.13 — diff entre versões, com classificação (FORM-SPEC §9).
 *
 * Os 11 casos listados na especificação, cada um classificado. A regra por
 * trás de todos: uma alteração é compatível quando os registos já recolhidos
 * continuam a ler-se sem ambiguidade.
 */

function versao(): FormDefinition {
  return structuredClone(localConsumo) as unknown as FormDefinition;
}

/** Aplica uma mutação à cópia da versão de referência. */
function alterada(fn: (def: FormDefinition) => void): FormDefinition {
  const def = versao();
  fn(def);
  def.version += 1;
  return def;
}

function classificacao(next: FormDefinition, code: string) {
  const diff = diffDefinitions(versao(), next);
  const entry = diff.entries.find((e) => e.code === code);
  return { diff, entry };
}

describe('sem alterações', () => {
  it('duas versões iguais não produzem entradas', () => {
    const diff = diffDefinitions(versao(), versao());
    expect(diff.entries).toEqual([]);
    expect(diff.compatible).toBe(true);
  });
});

describe('compatíveis (§9)', () => {
  it('1. acrescentar um campo', () => {
    const next = alterada((def) => {
      def.fields.push({ id: 'f_novo', name: 'novo', type: 'text', label: { pt: 'Novo' } });
    });
    const { diff, entry } = classificacao(next, 'campo_acrescentado');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });

  it('2. acrescentar uma opção a uma lista', () => {
    const next = alterada((def) => {
      def.choice_lists?.['lista_tipos']?.push({ value: 'comercial', label: { pt: 'Comercial' } });
    });
    const { diff, entry } = classificacao(next, 'opcao_acrescentada');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });

  it('3. alterar label, hint, appearance e constraint_message', () => {
    const next = alterada((def) => {
      const campo = def.fields[0]!;
      campo.label = { pt: 'Código de identificação' };
      campo.hint = { pt: 'Está gravado na chapa' };
      campo.appearance = 'horizontal';
      campo.constraint_message = { pt: 'Tem de ser LC seguido de seis dígitos' };
    });
    const diff = diffDefinitions(versao(), next);
    expect(diff.compatible).toBe(true);
    expect(diff.entries.map((e) => e.code)).toEqual(
      expect.arrayContaining(['rotulo_alterado', 'apresentacao_alterada']),
    );
  });

  it('4. alterar o name — muda a coluna da vista, nunca os dados', () => {
    const next = alterada((def) => {
      def.fields[0]!.name = 'codigo_identificacao';
    });
    const { diff, entry } = classificacao(next, 'name_alterado');
    expect(entry?.classification).toBe('compativel');
    expect(entry?.message).toContain('dados ficam intactos');
    expect(diff.compatible).toBe(true);
  });

  it('5. tornar um campo obrigatório menos restritivo', () => {
    const next = alterada((def) => {
      def.fields[0]!.required = false;
    });
    const { diff, entry } = classificacao(next, 'obrigatoriedade_relaxada');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });

  it('6. alargar uma restrição', () => {
    const next = alterada((def) => {
      delete def.fields[0]!.constraint;
      delete def.fields[0]!.constraint_message;
    });
    const { diff, entry } = classificacao(next, 'restricao_alargada');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });

  it('alargar um limite numérico também é compatível', () => {
    const next = alterada((def) => {
      const repeat = def.fields.find((f) => f.id === 'g_cont');
      if (repeat && repeat.type === 'repeat') repeat.max = 20;
    });
    const { diff, entry } = classificacao(next, 'limite_alargado');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });
});

describe('incompatíveis (§9)', () => {
  it('7. remover um campo', () => {
    const next = alterada((def) => {
      def.fields = def.fields.filter((f) => f.id !== 'f_pot');
    });
    const { diff, entry } = classificacao(next, 'campo_removido');
    expect(entry?.classification).toBe('incompativel');
    expect(diff.compatible).toBe(false);
  });

  it('8. alterar o tipo de um campo', () => {
    const next = alterada((def) => {
      const campo = def.fields.find((f) => f.id === 'f_pot');
      if (campo) campo.type = 'text' as typeof campo.type;
    });
    const { diff, entry } = classificacao(next, 'tipo_alterado');
    expect(entry?.classification).toBe('incompativel');
    expect(diff.compatible).toBe(false);
  });

  it('9. remover uma opção de uma lista', () => {
    const next = alterada((def) => {
      def.choice_lists!['lista_tipos'] = def.choice_lists!['lista_tipos']!.filter(
        (c) => c.value !== 'industrial',
      );
    });
    const { diff, entry } = classificacao(next, 'opcao_removida');
    expect(entry?.classification).toBe('incompativel');
    expect(diff.compatible).toBe(false);
  });

  it('10. apertar uma restrição', () => {
    const next = alterada((def) => {
      const campo = def.fields.find((f) => f.id === 'f_pot');
      if (campo) campo.constraint = { op: 'between', args: ['$self', 0, 100] };
    });
    const { diff, entry } = classificacao(next, 'restricao_apertada');
    expect(entry?.classification).toBe('incompativel');
    expect(entry?.message).toContain('confirmação');
    expect(diff.compatible).toBe(false);
  });

  it('11. alterar o geometry_field', () => {
    const next = alterada((def) => {
      def.fields.push({ id: 'f_geo2', name: 'localizacao_2', type: 'geopoint' });
      def.settings!.geometry_field = 'f_geo2';
    });
    const { diff, entry } = classificacao(next, 'geometry_field_alterado');
    expect(entry?.classification).toBe('incompativel');
    expect(diff.compatible).toBe(false);
  });

  it('passar a exigir resposta invalida registos antigos', () => {
    const next = alterada((def) => {
      const campo = def.fields.find((f) => f.id === 'f_pot');
      if (campo) campo.required = true;
    });
    const { diff, entry } = classificacao(next, 'obrigatoriedade_apertada');
    expect(entry?.classification).toBe('incompativel');
    expect(diff.compatible).toBe(false);
  });

  it('apertar um limite numérico', () => {
    const next = alterada((def) => {
      const repeat = def.fields.find((f) => f.id === 'g_cont');
      if (repeat && repeat.type === 'repeat') repeat.max = 2;
    });
    const { entry } = classificacao(next, 'limite_apertado');
    expect(entry?.classification).toBe('incompativel');
  });

  it('mover um campo para dentro de um repetível muda o nível dos dados', () => {
    const next = alterada((def) => {
      def.fields = def.fields.filter((f) => f.id !== 'f_pot');
      const repeat = def.fields.find((f) => f.id === 'g_cont');
      if (repeat && repeat.type === 'repeat') {
        repeat.fields.push({ id: 'f_pot', name: 'potencia', type: 'decimal' });
      }
    });
    const { entry } = classificacao(next, 'ambito_alterado');
    expect(entry?.classification).toBe('incompativel');
  });
});

describe('alterações que não invalidam nada', () => {
  it('mudar um cálculo não reescreve os valores já gravados', () => {
    const next = alterada((def) => {
      def.fields.push({
        id: 'f_calc',
        name: 'calculado',
        type: 'calculate',
        calculation: { op: 'count', args: ['$g_cont'] },
      });
    });
    const primeiro = diffDefinitions(versao(), next);
    expect(primeiro.compatible).toBe(true);

    const depois = structuredClone(next);
    const campo = depois.fields.find((f) => f.id === 'f_calc');
    if (campo) campo.calculation = { op: '+', args: [{ op: 'count', args: ['$g_cont'] }, 1] };
    const segundo = diffDefinitions(next, depois);
    expect(segundo.entries.find((e) => e.code === 'calculo_alterado')?.classification).toBe(
      'compativel',
    );
    expect(segundo.compatible).toBe(true);
  });

  it('apertar o limiar de precisão aplica-se a recolhas novas, não às antigas', () => {
    const next = alterada((def) => {
      def.settings!.max_accuracy_m = 0.5;
    });
    const { diff, entry } = classificacao(next, 'limiar_de_precisao_apertado');
    expect(entry?.classification).toBe('compativel');
    expect(diff.compatible).toBe(true);
  });
});
