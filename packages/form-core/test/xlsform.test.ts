import { describe, expect, it } from 'vitest';

import {
  checkFormDefinitionSchema,
  collectFields,
  exportXlsForm,
  importXlsForm,
  validateDefinition,
  xpathToAst,
} from '../src/index.js';
import type { FormDefinition, XPathContext, XlsFormWorkbook } from '../src/index.js';

import localConsumo from './fixtures/local-consumo.json';
import kobo from './fixtures/xlsform-kobo-avaliacao.json';
import odk from './fixtures/xlsform-odk-cadastro-agua.json';
import survey123 from './fixtures/xlsform-survey123-inspeccao.json';

/**
 * F1.14 a F1.17 — a ponte XLSForm.
 *
 * A pergunta que estes testes respondem é uma só: um formulário que já existe
 * no Kobo, no ODK ou no Survey123 entra no primeiro dia, e o que não converte
 * é dito com a linha e a expressão exactas?
 */

const workbook = (fixture: unknown): XlsFormWorkbook => fixture as unknown as XlsFormWorkbook;

/** Contexto mínimo para testar o conversor de XPath isoladamente. */
function contextoDeTeste(
  campos: Record<string, { id: string; repeatId?: string; repeat?: boolean }>,
): XPathContext {
  return {
    resolve(name) {
      const found = campos[name];
      if (!found) return undefined;
      return found.repeatId ? { id: found.id, repeatId: found.repeatId } : { id: found.id };
    },
    repeatOf(id) {
      return Object.values(campos).find((c) => c.id === id)?.repeatId;
    },
    isRepeat(id) {
      return Object.values(campos).find((c) => c.id === id)?.repeat === true;
    },
  };
}

describe('F1.15 — conversão de XPath para AST', () => {
  const contexto = contextoDeTeste({
    x: { id: 'f_x' },
    y: { id: 'f_y' },
    servicos: { id: 'f_serv' },
    leitura: { id: 'f_leitura', repeatId: 'g_cont' },
    contadores: { id: 'g_cont', repeat: true },
  });

  it('converte o exemplo do FORM-SPEC §10', () => {
    const result = xpathToAst("selected(${servicos},'a') and ${y} > 3", contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast).toEqual({
      op: 'and',
      args: [
        { op: 'selected', args: ['$f_serv', 'a'] },
        { op: '>', args: ['$f_y', 3] },
      ],
    });
  });

  it('respeita a precedência: and liga mais do que or', () => {
    const result = xpathToAst("${x} = 'a' or ${x} = 'b' and ${y} > 3", contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.op).toBe('or');
    expect((result.ast.args[1] as { op: string }).op).toBe('and');
  });

  it('respeita os parênteses', () => {
    const result = xpathToAst("(${x} = 'a' or ${x} = 'b') and ${y} > 3", contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast.op).toBe('and');
  });

  it('converte a aritmética, incluindo div', () => {
    const result = xpathToAst('(${x} * 60) div 1000', contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast).toEqual({ op: '/', args: [{ op: '*', args: ['$f_x', 60] }, 1000] });
  });

  it('converte o ponto num constraint em $self', () => {
    const result = xpathToAst('. > 0 and . < 40', contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.ast)).toContain('$self');
  });

  it('converte regex, string-length e count-selected', () => {
    expect(xpathToAst("regex(., '^PA[0-9]{4}$')", contexto)).toMatchObject({
      ok: true,
      ast: { op: 'matches' },
    });
    expect(xpathToAst('string-length(${x})', contexto)).toMatchObject({
      ok: true,
      ast: { op: 'length' },
    });
    expect(xpathToAst('count-selected(${servicos})', contexto)).toMatchObject({
      ok: true,
      ast: { op: 'count_selected' },
    });
  });

  it('converte sum(${campo}) usando o repetível que contém o campo', () => {
    const result = xpathToAst('sum(${leitura})', contexto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast).toEqual({ op: 'sum', args: ['$g_cont', 'f_leitura'] });
  });

  it('converte true() e false()', () => {
    expect(xpathToAst('${x} = true()', contexto)).toMatchObject({
      ok: true,
      ast: { op: '==', args: ['$f_x', true] },
    });
  });

  it('falha, com a razão exacta, no que não converte', () => {
    const casos: Array<[string, RegExp]> = [
      ['indexed-repeat(${leitura}, ${contadores}, 1)', /indexed-repeat/],
      ["pulldata('municipios', 'nome', 'codigo', ${x})", /pulldata/],
      ['int(${x})', /int\(\)/],
      ['${x} mod 2', /mod/],
      ['format-date(${x}, "%Y")', /format-date/],
      ['${inexistente} = 1', /não corresponde a nenhum campo/],
      ['funcao_inventada(${x})', /não existe na versão 1/],
    ];
    for (const [expressao, esperado] of casos) {
      const result = xpathToAst(expressao, contexto);
      expect(result.ok, expressao).toBe(false);
      if (result.ok) continue;
      expect(result.error.reason, expressao).toMatch(esperado);
      expect(result.error.expression).toBe(expressao);
    }
  });

  it('uma expressão mal formada aponta a posição', () => {
    const result = xpathToAst("${x} = 'a", contexto);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.position).toBeGreaterThan(0);
  });
});

describe('F1.14 e F1.17 — importar formulários reais', () => {
  it('importa um formulário do Kobo com grupos, cascata e cálculo', () => {
    const result = importXlsForm(workbook(kobo), {
      formId: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d41',
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.formKey).toBe('avaliacao_rapida');

    // Passa o schema e o validador semântico: importar não pode produzir uma
    // definição que a plataforma depois recusa publicar.
    expect(checkFormDefinitionSchema(result.definition).ok).toBe(true);
    expect(validateDefinition(result.definition).valid).toBe(true);

    const ids = collectFields(result.definition).map((v) => v.field.id);
    expect(ids).toContain('g_grupo_identificacao');
    expect(ids).toContain('f_provincia');

    // Os metadados do XLSForm não viram perguntas, e isso é comunicado.
    expect(result.losses.some((l) => l.value === 'start')).toBe(true);
    expect(ids.some((id) => id.includes('start'))).toBe(false);
  });

  it('preserva os rótulos nos dois idiomas', () => {
    const result = importXlsForm(workbook(kobo));
    const campo = collectFields(result.definition).find((v) => v.field.name === 'provincia');
    expect(campo?.field.label).toEqual({ pt: 'Província', en: 'Province' });
  });

  it('importa um formulário do ODK com repetível, sum e count', () => {
    const result = importXlsForm(workbook(odk));
    expect(result.errors).toEqual([]);
    expect(validateDefinition(result.definition).valid).toBe(true);

    const campos = collectFields(result.definition);
    const total = campos.find((v) => v.field.name === 'caudal_total');
    expect(total?.field.calculation).toEqual({ op: 'sum', args: ['$g_medicoes', 'f_caudal_lmin'] });

    const porInstancia = campos.find((v) => v.field.name === 'caudal_m3h');
    expect(porInstancia?.repeatScope).toBe('g_medicoes');

    // Um geopoint único à raiz passa a alimentar a geometria do registo.
    expect(result.definition.settings?.geometry_field).toBe('f_localizacao');
  });

  it('importa um formulário do Survey123 e traduz os tipos que não existem', () => {
    const result = importXlsForm(workbook(survey123));
    expect(result.errors).toEqual([]);
    expect(validateDefinition(result.definition).valid).toBe(true);

    const campos = collectFields(result.definition);
    expect(campos.find((v) => v.field.name === 'confirmacao')?.field.type).toBe('boolean');
    expect(campos.find((v) => v.field.name === 'origem_registo')?.field.readonly).toBe(true);
    expect(campos.find((v) => v.field.name === 'defeitos')?.field).toMatchObject({
      type: 'select_multiple',
      allow_other: true,
    });
  });

  it('o max-pixels do XLSForm vira o redimensionamento no telefone', () => {
    const result = importXlsForm(workbook(odk));
    const foto = collectFields(result.definition).find((v) => v.field.name === 'foto_ponto');
    expect(foto?.field).toMatchObject({ type: 'photo', max_dimension_px: 1600 });
  });

  it('uma expressão que não converte falha com a linha e a expressão exactas', () => {
    const comXPathImpossivel: XlsFormWorkbook = {
      survey: [
        { type: 'text', name: 'a', label: 'A' },
        { type: 'text', name: 'b', label: 'B', relevant: 'indexed-repeat(${a}, ${a}, 1) = 1' },
      ],
      choices: [],
    };
    const result = importXlsForm(comXPathImpossivel);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      row: 3, // linha 1 é o cabeçalho, linha 2 é o campo "a"
      sheet: 'survey',
      column: 'relevant',
      value: 'indexed-repeat(${a}, ${a}, 1) = 1',
    });
    expect(result.errors[0]?.reason).toContain('indexed-repeat');
  });

  it('recusa um grupo por fechar em vez de adivinhar onde acaba', () => {
    const result = importXlsForm({
      survey: [
        { type: 'begin group', name: 'g', label: 'G' },
        { type: 'text', name: 'a', label: 'A' },
      ],
      choices: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.reason).toContain('por fechar');
  });

  it('um calculation num campo que não é calculate fica readonly (§8 regra 12)', () => {
    const result = importXlsForm({
      survey: [
        { type: 'text', name: 'a', label: 'A' },
        { type: 'text', name: 'b', label: 'B', calculation: "concat(${a}, 'x')" },
      ],
      choices: [],
    });
    expect(result.errors).toEqual([]);
    expect(validateDefinition(result.definition).valid).toBe(true);
    const campo = collectFields(result.definition).find((v) => v.field.name === 'b');
    expect(campo?.field.readonly).toBe(true);
  });
});

describe('F1.16 — exportar', () => {
  const definition = localConsumo as unknown as FormDefinition;

  it('exporta o formulário de referência com a estrutura certa', () => {
    const { workbook: wb } = exportXlsForm(definition);
    const tipos = wb.survey.map((r) => r['type']);
    expect(tipos).toEqual([
      'text',
      'select_one lista_tipos',
      'decimal',
      'geopoint',
      'begin repeat',
      'text',
      'image',
      'end repeat',
    ]);
    expect(wb.settings?.[0]?.['form_title']).toBe('Local de Consumo');
    expect(wb.choices.map((c) => c['name'])).toEqual(['domestico', 'industrial']);
  });

  it('converte as expressões de volta para XPath', () => {
    const { workbook: wb } = exportXlsForm(definition);
    const codigo = wb.survey.find((r) => r['name'] === 'codigo');
    expect(codigo?.['constraint']).toBe("regex(., '^LC[0-9]{6}$')");
    const potencia = wb.survey.find((r) => r['name'] === 'potencia');
    expect(potencia?.['relevant']).toBe("(${tipo}='industrial')");
    expect(potencia?.['constraint']).toBe('(. >= 0 and . <= 1000)');
  });

  it('diz o que se perde em vez de o omitir em silêncio', () => {
    const comReferencia: FormDefinition = {
      ...definition,
      fields: [
        ...definition.fields,
        {
          id: 'f_pt',
          name: 'posto_transformacao',
          type: 'reference',
          target_form_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d42',
        },
      ],
    };
    const { workbook: wb, losses } = exportXlsForm(comReferencia);
    expect(wb.survey.some((r) => r['name'] === 'posto_transformacao')).toBe(false);
    expect(losses.some((l) => l.reason.includes('reference'))).toBe(true);
    // O limiar de precisão também não existe no XLSForm.
    expect(losses.some((l) => l.reason.includes('max_accuracy_m'))).toBe(true);
  });

  it('ida e volta preserva estrutura e rótulos', () => {
    const { workbook: wb } = exportXlsForm(definition);
    const reimportado = importXlsForm(wb, { formId: definition.form_id });
    expect(reimportado.errors).toEqual([]);
    expect(validateDefinition(reimportado.definition).valid).toBe(true);

    const antes = collectFields(definition).map((v) => ({
      name: v.field.name,
      type: v.field.type,
      label: v.field.label?.pt,
      scope: v.repeatScope,
    }));
    const depois = collectFields(reimportado.definition).map((v) => ({
      name: v.field.name,
      type: v.field.type,
      label: v.field.label?.pt,
      // o âmbito é o mesmo, mas o id do repetível foi gerado de novo
      scope: v.repeatScope ? 'g_contadores' : undefined,
    }));
    expect(depois).toEqual(
      antes.map((f) => ({ ...f, scope: f.scope ? 'g_contadores' : undefined })),
    );
  });

  it('a ida e volta gera ids novos — e é por isso que não se faz a um formulário com dados', () => {
    const { workbook: wb } = exportXlsForm(definition);
    const reimportado = importXlsForm(wb, { formId: definition.form_id });
    const idsAntes = collectFields(definition).map((v) => v.field.id);
    const idsDepois = collectFields(reimportado.definition).map((v) => v.field.id);
    expect(idsDepois).not.toEqual(idsAntes);
  });
});
