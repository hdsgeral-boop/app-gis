import { describe, expect, it } from 'vitest';
import type { Field, FormDefinition } from '@cvforms/form-core';

import {
  IdentifierAllocator,
  buildManifest,
  canonicalJson,
  definitionHash,
  generateViews,
  quoteIdentifier,
  sanitizeIdentifier,
  viewName,
} from '../src/views/index.js';

/**
 * F2.1 a F2.10 e F2.13 — o gerador de vistas, testado sem base de dados.
 *
 * O gerador só produz texto SQL, e é de propósito: dá para provar aqui, em
 * milissegundos e sem docker, que nenhum `name` escrito por um humano se torna
 * SQL executável. A prova de que o SQL gerado CORRE está em
 * `vistas-postgres.test.ts`, contra um Postgres com PostGIS a sério.
 */

const FORM_ID = '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40';
const VERSION_ID = '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d99';

function definir(fields: Field[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    spec_version: 1,
    form_id: FORM_ID,
    version: 4,
    title: { pt: 'Local de Consumo' },
    fields,
    ...extra,
  } as FormDefinition;
}

function gerar(definition: FormDefinition) {
  return generateViews({
    definition,
    projectKey: 'piloto_bengo',
    formKey: 'local_consumo',
    formId: FORM_ID,
    formVersionId: VERSION_ID,
  });
}

const raiz = (r: ReturnType<typeof gerar>) => r.views.find((v) => !v.isActual && !v.repeatFieldId)!;
const actual = (r: ReturnType<typeof gerar>) =>
  r.views.find((v) => v.isActual && !v.repeatFieldId)!;

describe('F2.1 — saneamento de identificadores', () => {
  it('acentos, espaços e maiúsculas geram uma coluna válida', () => {
    expect(sanitizeIdentifier('Potência Contratada (kVA)')).toBe('potencia_contratada_kva');
    expect(sanitizeIdentifier('  código  do  local ')).toBe('codigo_do_local');
    expect(sanitizeIdentifier('Nº de postes')).toBe('n_de_postes');
  });

  it('um identificador que comece por dígito passa a começar por letra', () => {
    expect(sanitizeIdentifier('2026_leituras')).toBe('n_2026_leituras');
  });

  it('nunca devolve vazio', () => {
    expect(sanitizeIdentifier('***', 'campo')).toBe('campo');
    expect(sanitizeIdentifier('')).toBe('campo');
  });

  it('trunca aos 63 bytes do Postgres', () => {
    const longo = sanitizeIdentifier('a'.repeat(200));
    expect(longo).toHaveLength(63);
  });

  it('desambigua colisões em vez de deixar uma coluna apagar a outra', () => {
    const allocator = new IdentifierAllocator();
    // Duas grafias diferentes que saneiam para o mesmo: sem sufixo, a segunda
    // coluna substituía a primeira e os dados apareciam sob o nome errado.
    expect(allocator.allocate('potência contratada')).toBe('potencia_contratada');
    expect(allocator.allocate('Potencia-Contratada')).toBe('potencia_contratada_2');
    expect(allocator.allocate('POTENCIA_CONTRATADA')).toBe('potencia_contratada_3');
  });

  it('a desambiguação de nomes longos continua a caber nos 63 bytes', () => {
    const allocator = new IdentifierAllocator();
    const base = 'x'.repeat(70);
    const primeiro = allocator.allocate(base);
    const segundo = allocator.allocate(base);
    expect(primeiro).toHaveLength(63);
    expect(segundo.length).toBeLessThanOrEqual(63);
    expect(segundo).not.toBe(primeiro);
  });

  it('palavras reservadas do SQL passam, porque tudo é citado', () => {
    expect(quoteIdentifier(sanitizeIdentifier('select'))).toBe('"select"');
    expect(quoteIdentifier(sanitizeIdentifier('order'))).toBe('"order"');
  });

  it('o nome da vista segue o padrão da especificação', () => {
    expect(viewName({ project: 'piloto_bengo', form: 'local_consumo', version: 4 })).toBe(
      'v_piloto_bengo_local_consumo_v4',
    );
    expect(viewName({ project: 'piloto_bengo', form: 'local_consumo', version: 'actual' })).toBe(
      'v_piloto_bengo_local_consumo_actual',
    );
    expect(
      viewName({
        project: 'piloto_bengo',
        form: 'local_consumo',
        repeatPath: ['contadores'],
        version: 4,
      }),
    ).toBe('v_piloto_bengo_local_consumo_contadores_v4');
  });

  it('um nome de vista longo de mais é truncado e continua único', () => {
    const a = viewName({ project: 'p'.repeat(40), form: 'formulario_um', version: 1 });
    const b = viewName({ project: 'p'.repeat(40), form: 'formulario_dois', version: 1 });
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
  });
});

/**
 * Retira os literais de texto do SQL, respeitando o escape `''`. Contar
 * caracteres perigosos no que sobra é a única verificação que interessa: um
 * `;` dentro de um literal é texto, e um `;` fora dele é um comando novo.
 */
function foraDosLiterais(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

describe('F2.2 — injecção de SQL no gerador', () => {
  // Este `name` nunca passaria o JSON Schema. O ponto é exactamente esse: o
  // schema é a primeira linha de defesa e este teste prova a segunda, para o
  // dia em que alguém escreva na base de dados sem passar pela API.
  const malicioso = definir([
    {
      id: 'f_mau',
      name: '"; DROP TABLE records; --',
      type: 'text',
    } as unknown as Field,
    { id: 'f_ok', name: 'codigo', type: 'text' } as Field,
  ]);

  it('não deixa nenhuma aspa nem ponto e vírgula escapar para o SQL', () => {
    const { createSql } = raiz(gerar(malicioso));
    const codigo = foraDosLiterais(createSql);
    expect(codigo).not.toContain('DROP TABLE');
    expect(codigo).not.toContain('--');
    // Fora dos literais há um único `;`, o que fecha o comando.
    expect(codigo.match(/;/g)).toHaveLength(1);
  });

  it('a coluna continua a existir, com um nome saneado', () => {
    const vista = raiz(gerar(malicioso));
    const coluna = vista.columns.find((c) => c.fieldId === 'f_mau');
    expect(coluna?.name).toBe('drop_table_records');
    expect(vista.createSql).toContain('"drop_table_records"');
  });

  it('um id malicioso também não escapa, e o id vai para dentro de um literal', () => {
    const comIdMau = definir([
      { id: "f'; DROP TABLE records; --", name: 'campo', type: 'text' } as unknown as Field,
    ]);
    const { createSql } = raiz(gerar(comIdMau));
    // As plicas do literal ficam duplicadas: o Postgres lê texto, não comandos.
    expect(createSql).toContain("'f''; DROP TABLE records; --'");
    const codigo = foraDosLiterais(createSql);
    expect(codigo).not.toContain('DROP TABLE');
    expect(codigo.match(/;/g)).toHaveLength(1);
  });
});

describe('F2.3 — vista raiz com colunas tipadas', () => {
  const definition = definir([
    { id: 'f_cod', name: 'codigo', type: 'text' } as Field,
    { id: 'f_n', name: 'numero_postes', type: 'integer' } as Field,
    { id: 'f_pot', name: 'potencia', type: 'decimal' } as Field,
    { id: 'f_lig', name: 'ligado', type: 'boolean' } as Field,
    { id: 'f_data', name: 'data_visita', type: 'date' } as Field,
    { id: 'f_hora', name: 'hora_visita', type: 'time' } as Field,
    { id: 'f_inst', name: 'momento', type: 'datetime' } as Field,
    { id: 'f_nota', name: 'aviso', type: 'note' } as Field,
    {
      id: 'g_id',
      name: 'identificacao',
      type: 'group',
      fields: [{ id: 'f_dentro', name: 'dentro_do_grupo', type: 'text' } as Field],
    } as Field,
  ]);
  const vista = raiz(gerar(definition));

  it('mapeia cada tipo do formato para o tipo SQL certo', () => {
    const tipos = Object.fromEntries(vista.columns.map((c) => [c.name, c.sqlType]));
    expect(tipos['codigo']).toBe('text');
    expect(tipos['numero_postes']).toBe('integer');
    expect(tipos['potencia']).toBe('numeric');
    expect(tipos['ligado']).toBe('boolean');
    expect(tipos['data_visita']).toBe('date');
    expect(tipos['hora_visita']).toBe('time');
    expect(tipos['momento']).toBe('timestamptz');
  });

  it('um note não gera coluna', () => {
    expect(vista.columns.some((c) => c.fieldId === 'f_nota')).toBe(false);
  });

  it('um grupo não cria nível: a coluna aparece na mesma vista', () => {
    expect(vista.columns.some((c) => c.name === 'dentro_do_grupo')).toBe(true);
  });

  it('traz as colunas de sistema de que o painel e o QGIS precisam', () => {
    const nomes = vista.columns.map((c) => c.name);
    expect(nomes).toEqual(
      expect.arrayContaining(['record_id', 'status', 'geom', 'updated_at', 'revision_no']),
    );
  });

  it('filtra pela versão e não mostra registos apagados', () => {
    expect(vista.createSql).toContain(`rec.form_version_id = '${VERSION_ID}'::uuid`);
    expect(vista.createSql).toContain('rec.deleted_at IS NULL');
  });

  it('o id do campo fica como comentário da coluna', () => {
    expect(vista.commentSql.some((c) => c.includes('f_cod'))).toBe(true);
  });

  it('projected: false tira a coluna da vista', () => {
    const semProjeccao = definir([
      { id: 'f_a', name: 'visivel', type: 'text' } as Field,
      { id: 'f_b', name: 'escondido', type: 'text', projected: false } as Field,
    ]);
    const nomes = raiz(gerar(semProjeccao)).columns.map((c) => c.name);
    expect(nomes).toContain('visivel');
    expect(nomes).not.toContain('escondido');
  });

  it('o tipo de um calculate vem da expressão', () => {
    const comCalculo = definir([
      { id: 'f_q', name: 'quantidade', type: 'integer' } as Field,
      { id: 'f_p', name: 'preco', type: 'decimal' } as Field,
      {
        id: 'f_total',
        name: 'total',
        type: 'calculate',
        calculation: { op: '*', args: ['$f_q', '$f_p'] },
      } as Field,
      {
        id: 'f_grande',
        name: 'e_grande',
        type: 'calculate',
        calculation: { op: '>', args: ['$f_q', 10] },
      } as Field,
    ]);
    const tipos = Object.fromEntries(
      raiz(gerar(comCalculo)).columns.map((c) => [c.name, c.sqlType]),
    );
    expect(tipos['total']).toBe('numeric');
    expect(tipos['e_grande']).toBe('boolean');
  });
});

describe('F2.4 — geopoint', () => {
  const definition = definir([{ id: 'f_geo', name: 'localizacao', type: 'geopoint' } as Field]);
  const vista = raiz(gerar(definition));

  it('gera geometry(Point,4326)', () => {
    const coluna = vista.columns.find((c) => c.name === 'localizacao');
    expect(coluna?.sqlType).toBe('geometry(Point,4326)');
    expect(coluna?.expression).toContain('cvf_views.to_point');
  });

  it('a precisão e a origem viajam com o ponto (restrição inegociável 8)', () => {
    const nomes = vista.columns.map((c) => c.name);
    expect(nomes).toContain('localizacao_accuracy_m');
    expect(nomes).toContain('localizacao_fix_type');
    expect(nomes).toContain('localizacao_source');
  });

  it('geotrace e geoshape geram linha e polígono', () => {
    const geo = definir([
      { id: 'f_t', name: 'traco', type: 'geotrace' } as Field,
      { id: 'f_s', name: 'area', type: 'geoshape' } as Field,
    ]);
    const tipos = Object.fromEntries(raiz(gerar(geo)).columns.map((c) => [c.name, c.sqlType]));
    expect(tipos['traco']).toBe('geometry(LineString,4326)');
    expect(tipos['area']).toBe('geometry(Polygon,4326)');
  });
});

describe('F2.5 — select_multiple', () => {
  const definition = definir(
    [
      {
        id: 'f_serv',
        name: 'servicos',
        type: 'select_multiple',
        choices_ref: 'l1',
      } as Field,
    ],
    { choice_lists: { l1: [{ value: 'agua', label: { pt: 'Água' } }] } },
  );
  const vista = raiz(gerar(definition));

  it('gera text[] mais a coluna _txt de compatibilidade com o ODK', () => {
    const array = vista.columns.find((c) => c.name === 'servicos');
    const texto = vista.columns.find((c) => c.name === 'servicos_txt');
    expect(array?.sqlType).toBe('text[]');
    expect(texto?.sqlType).toBe('text');
    expect(texto?.expression).toContain('array_to_string');
  });
});

describe('F2.6 e F2.7 — repetíveis', () => {
  const definition = definir([
    { id: 'f_cod', name: 'codigo', type: 'text' } as Field,
    {
      id: 'g_cont',
      name: 'contadores',
      type: 'repeat',
      fields: [
        { id: 'f_ns', name: 'numero_serie', type: 'text' } as Field,
        {
          id: 'g_leit',
          name: 'leituras',
          type: 'repeat',
          fields: [{ id: 'f_valor', name: 'valor', type: 'decimal' } as Field],
        } as Field,
      ],
    } as Field,
  ]);
  const resultado = gerar(definition);
  const filha = resultado.views.find((v) => !v.isActual && v.repeatFieldId === 'g_cont')!;
  const neta = resultado.views.find((v) => !v.isActual && v.repeatFieldId === 'g_leit')!;

  it('o repetível não vira coluna na vista-mãe', () => {
    expect(raiz(resultado).columns.some((c) => c.fieldId === 'g_cont')).toBe(false);
  });

  it('a vista-filha liga-se por record_id + idx', () => {
    const nomes = filha.columns.map((c) => c.name);
    expect(nomes).toContain('record_id');
    expect(nomes).toContain('idx');
    expect(nomes).toContain('numero_serie');
    expect(filha.name).toBe('v_piloto_bengo_local_consumo_contadores_v4');
    expect(filha.createSql).toContain('jsonb_array_elements');
    expect(filha.createSql).toContain('WITH ORDINALITY');
  });

  it('o índice começa em zero, como nos dados e nas mensagens de erro', () => {
    expect(filha.columns.find((c) => c.name === 'idx')?.expression).toContain('- 1');
  });

  it('um valor que não seja array não parte a vista', () => {
    expect(filha.createSql).toContain('jsonb_typeof');
    expect(filha.createSql).toContain("'[]'::jsonb");
  });

  it('o repetível aninhado gera uma segunda vista-filha encadeada', () => {
    const nomes = neta.columns.map((c) => c.name);
    expect(neta.name).toBe('v_piloto_bengo_local_consumo_contadores_leituras_v4');
    expect(nomes).toContain('record_id');
    expect(nomes).toContain('contadores_idx'); // liga à vista do meio
    expect(nomes).toContain('idx');
    expect(nomes).toContain('valor');
    expect(neta.createSql.match(/CROSS JOIN LATERAL/g)).toHaveLength(2);
  });
});

describe('F2.8 — vista _actual', () => {
  const definition = definir([{ id: 'f_cod', name: 'codigo', type: 'text' } as Field]);
  const vista = actual(gerar(definition));

  it('existe, e chama-se _actual', () => {
    expect(vista.name).toBe('v_piloto_bengo_local_consumo_actual');
  });

  it('filtra pelo formulário e não pela versão, e diz a versão de cada registo', () => {
    // Decisão: a `_actual` é a camada do formulário, com as colunas da versão
    // corrente. Um registo da v3 aparece com NULL nos campos novos e com
    // form_version = 3 — em vez de desaparecer do mapa por ter sido recolhido
    // antes da última publicação.
    expect(vista.createSql).toContain(`rec.form_id = '${FORM_ID}'::uuid`);
    expect(vista.createSql).not.toContain('form_version_id =');
    expect(vista.columns.some((c) => c.name === 'form_version')).toBe(true);
  });

  it('tem também vista _actual para cada repetível', () => {
    const comRepeticao = definir([
      {
        id: 'g_cont',
        name: 'contadores',
        type: 'repeat',
        fields: [{ id: 'f_ns', name: 'numero_serie', type: 'text' } as Field],
      } as Field,
    ]);
    const nomes = gerar(comRepeticao).views.map((v) => v.name);
    expect(nomes).toContain('v_piloto_bengo_local_consumo_contadores_actual');
  });
});

describe('F2.9 — publicar a versão seguinte não toca na vista anterior', () => {
  it('cada versão tem o seu nome de vista e o seu filtro', () => {
    const v4 = raiz(gerar(definir([{ id: 'f_a', name: 'a', type: 'text' } as Field])));
    const v5 = raiz(
      gerar(definir([{ id: 'f_a', name: 'a', type: 'text' } as Field], { version: 5 })),
    );
    expect(v4.name).toBe('v_piloto_bengo_local_consumo_v4');
    expect(v5.name).toBe('v_piloto_bengo_local_consumo_v5');
    // O DROP de cada uma nomeia só a sua.
    expect(v5.dropSql).not.toContain('_v4');
  });
});

describe('F2.10 — índices dos campos pesquisáveis', () => {
  const definition = definir([
    { id: 'f_cod', name: 'codigo', type: 'text', searchable: true } as Field,
    { id: 'f_outro', name: 'outro', type: 'text' } as Field,
  ]);
  const { indexes } = gerar(definition);

  it('cria um índice por campo marcado, e só por esses', () => {
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.fieldId).toBe('f_cod');
    expect(indexes[0]?.createSql).toContain("(data ->> 'f_cod')");
    expect(indexes[0]?.createSql).toContain('IF NOT EXISTS');
  });

  it('o índice é partilhado entre formulários, e não um por formulário publicado', () => {
    // Restrição inegociável 5: nenhum DDL por formulário publicado além das
    // vistas. O índice é sobre a expressão, e o nome deriva do id do campo.
    expect(indexes[0]?.name).toBe('cvf_busca_f_cod');
  });
});

describe('F2.13 — manifesto do formulário', () => {
  const definition = definir(
    [
      { id: 'f_cod', name: 'codigo', type: 'text' } as Field,
      { id: 'f_foto', name: 'foto', type: 'photo' } as Field,
      { id: 'f_s', name: 's', type: 'select_one', choices_ref: 'l1' } as Field,
    ],
    { choice_lists: { l1: [{ value: 'a', label: { pt: 'A' } }] } },
  );

  it('o hash é estável e não depende da ordem das chaves', () => {
    const a = definitionHash(definition);
    // A mesma definição com as chaves por outra ordem: sem canonicalização, o
    // hash mudava e todos os telefones do país voltavam a descarregar a mesma
    // definição por uma rede que se paga ao megabyte.
    const reordenado = Object.fromEntries(
      Object.entries(definition).reverse(),
    ) as unknown as FormDefinition;
    expect(Object.keys(reordenado)).not.toEqual(Object.keys(definition));
    expect(definitionHash(reordenado)).toBe(a);
  });

  it('o hash muda quando a definição muda', () => {
    const outra = { ...definition, version: 5 };
    expect(definitionHash(outra)).not.toBe(definitionHash(definition));
  });

  it('o JSON canónico ordena as chaves e ignora undefined', () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
  });

  it('lista as listas de escolha, a media e as vistas', () => {
    const manifest = buildManifest(definition, gerar(definition), '2026-09-05T10:00:00Z');
    expect(manifest.choice_lists).toEqual([
      { key: 'l1', count: 1, hash: expect.stringContaining('sha256:') },
    ]);
    expect(manifest.media).toEqual([{ field_id: 'f_foto', kind: 'photo' }]);
    expect(manifest.views.map((v) => v.name)).toContain('v_piloto_bengo_local_consumo_v4');
    expect(manifest.hash).toBe(definitionHash(definition));
  });
});
