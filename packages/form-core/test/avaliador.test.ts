import { describe, expect, it } from 'vitest';

import { childContext, evaluate, evaluateBoolean, makeContext } from '../src/index.js';
import type { EvalContext, Expression, ExpressionArg, RecordData } from '../src/index.js';

/**
 * F1.6 a F1.9 — o avaliador.
 *
 * Cada operador com caso normal, caso limite e caso nulo. O que se está a
 * proteger aqui não é a aritmética: é a semântica de nulos, que é onde estas
 * linguagens falham em silêncio e produzem registos errados em campo.
 */

const AGORA = new Date('2026-09-05T14:30:00Z');

function ctx(values: RecordData = {}, extra: Partial<EvalContext> = {}): EvalContext {
  return makeContext(values, { now: AGORA, ...extra });
}

function ev(
  expr: ExpressionArg,
  values: RecordData = {},
  extra: Partial<EvalContext> = {},
): unknown {
  return evaluate(expr, ctx(values, extra));
}

const op = (o: string, ...args: ExpressionArg[]): Expression =>
  ({ op: o, args }) as unknown as Expression;

describe('referências (§6.1)', () => {
  it('resolve $id no âmbito actual', () => {
    expect(ev('$f_cod', { f_cod: 'LC000123' })).toBe('LC000123');
  });

  it('uma string sem $ é literal', () => {
    expect(ev('industrial')).toBe('industrial');
  });

  it('um campo sem valor dá null, não undefined', () => {
    expect(ev('$f_inexistente', {})).toBeNull();
  });

  it('$self só existe se o contexto o trouxer', () => {
    expect(ev('$self', {}, { self: 42 })).toBe(42);
    expect(ev('$self', {})).toBeNull();
  });

  it('$id de dentro de um repetível encontra o campo do âmbito de fora', () => {
    const raiz = ctx({ f_mun: 'Cacuaco' });
    const instancia = childContext(raiz, { f_ns: 'A1' });
    expect(evaluate('$f_mun', instancia)).toBe('Cacuaco');
    expect(evaluate('$f_ns', instancia)).toBe('A1');
  });

  it('$..id salta o âmbito actual e começa no pai', () => {
    const raiz = ctx({ f_mun: 'Cacuaco' });
    const instancia = childContext(raiz, { f_ns: 'A1' });
    expect(evaluate('$..f_mun', instancia)).toBe('Cacuaco');
    // Do âmbito da raiz não há pai nenhum: dá nulo, e o validador da definição
    // recusa a expressão muito antes disto acontecer em campo.
    expect(evaluate('$..f_mun', raiz)).toBeNull();
  });
});

describe('comparação e nulos (§6.3)', () => {
  it('compara números e texto', () => {
    expect(ev(op('==', '$a', 3), { a: 3 })).toBe(true);
    expect(ev(op('!=', '$a', 3), { a: 4 })).toBe(true);
    expect(ev(op('>', '$a', 100), { a: 250 })).toBe(true);
    expect(ev(op('<=', '$a', 100), { a: 100 })).toBe(true);
  });

  it('compara datas como datas, não como texto', () => {
    expect(ev(op('>', '2026-01-10', '2026-01-09'))).toBe(true);
    expect(ev(op('<', '2026-01-09T23:00:00Z', '2026-01-10'))).toBe(true);
  });

  it('qualquer comparação com null dá null, nunca false', () => {
    for (const operador of ['==', '!=', '<', '<=', '>', '>=']) {
      expect(ev(op(operador, '$a', 3), { a: null }), operador).toBeNull();
    }
  });

  it('string vazia conta como null', () => {
    expect(ev(op('==', '$a', ''), { a: '' })).toBeNull();
    expect(ev(op('is_null', '$a'), { a: '' })).toBe(true);
  });

  it('between é inclusivo nos dois extremos e nulo com null', () => {
    expect(ev(op('between', '$a', 0, 1000), { a: 0 })).toBe(true);
    expect(ev(op('between', '$a', 0, 1000), { a: 1000 })).toBe(true);
    expect(ev(op('between', '$a', 0, 1000), { a: 1000.1 })).toBe(false);
    expect(ev(op('between', '$a', 0, 1000), { a: null })).toBeNull();
  });
});

describe('lógica de três valores', () => {
  const V = true;
  const F = false;
  const N = null;

  it('tabela de verdade completa do and', () => {
    const casos: Array<[unknown, unknown, unknown]> = [
      [V, V, V],
      [V, F, F],
      [F, V, F],
      [F, F, F],
      [V, N, N],
      [N, V, N],
      [F, N, F], // falso decide, mesmo com um indefinido ao lado
      [N, F, F],
      [N, N, N],
    ];
    for (const [a, b, esperado] of casos) {
      expect(ev(op('and', '$a', '$b'), { a, b }), `and(${a}, ${b})`).toBe(esperado);
    }
  });

  it('tabela de verdade completa do or', () => {
    const casos: Array<[unknown, unknown, unknown]> = [
      [V, V, V],
      [V, F, V],
      [F, V, V],
      [F, F, F],
      [V, N, V], // verdadeiro decide
      [N, V, V],
      [F, N, N],
      [N, F, N],
      [N, N, N],
    ];
    for (const [a, b, esperado] of casos) {
      expect(ev(op('or', '$a', '$b'), { a, b }), `or(${a}, ${b})`).toBe(esperado);
    }
  });

  it('not propaga o indefinido', () => {
    expect(ev(op('not', true))).toBe(false);
    expect(ev(op('not', false))).toBe(true);
    expect(ev(op('not', '$a'), { a: null })).toBeNull();
  });

  it('num contexto de decisão, null conta como falso', () => {
    expect(evaluateBoolean(op('==', '$a', 3), ctx({ a: null }))).toBe(false);
  });

  it('and faz curto-circuito: o segundo argumento não decide se o primeiro é falso', () => {
    // Sem curto-circuito, `$a > 3` com $a nulo tornaria a expressão inteira
    // indefinida em vez de falsa, e o campo apareceria quando não devia.
    expect(ev(op('and', op('not', op('is_null', '$a')), op('>', '$a', 3)), { a: null })).toBe(
      false,
    );
  });

  it('or aceita mais de dois argumentos', () => {
    expect(ev(op('or', false, false, true))).toBe(true);
  });
});

describe('aritmética', () => {
  it('soma, subtrai, multiplica e divide, com aridade variável', () => {
    expect(ev(op('+', 1, 2, 3))).toBe(6);
    expect(ev(op('-', 10, 3, 2))).toBe(5);
    expect(ev(op('*', '$q', '$p'), { q: 3, p: 2.5 })).toBe(7.5);
    expect(ev(op('/', 10, 4))).toBe(2.5);
  });

  it('divisão por zero dá null, nunca Infinity', () => {
    expect(ev(op('/', 10, 0))).toBeNull();
  });

  it('um null contamina toda a conta', () => {
    expect(ev(op('+', '$a', 1), { a: null })).toBeNull();
    expect(ev(op('*', '$a', 0), { a: null })).toBeNull();
  });

  it('texto numérico é aceite; texto não numérico dá null', () => {
    expect(ev(op('+', '3', 4))).toBe(7);
    expect(ev(op('+', 'abc', 4))).toBeNull();
  });

  it('round arredonda às casas pedidas, zero por omissão', () => {
    expect(ev(op('round', 2.5))).toBe(3);
    expect(ev(op('round', 2.4449, 2))).toBe(2.44);
    expect(ev(op('round', 1.005, 2))).toBe(1.01); // o clássico que a vírgula flutuante estraga
    expect(ev(op('round', '$a', 2), { a: null })).toBeNull();
  });
});

describe('texto', () => {
  it('matches, starts_with, ends_with, contains', () => {
    expect(ev(op('matches', '$a', '^LC[0-9]{6}$'), { a: 'LC000123' })).toBe(true);
    expect(ev(op('matches', '$a', '^LC[0-9]{6}$'), { a: 'LC12' })).toBe(false);
    expect(ev(op('starts_with', 'LC000123', 'LC'))).toBe(true);
    expect(ev(op('ends_with', 'LC000123', '123'))).toBe(true);
    expect(ev(op('contains', 'houve avaria no ramal', 'avaria'))).toBe(true);
  });

  it('um padrão inválido dá null em vez de rebentar a recolha', () => {
    expect(ev(op('matches', 'x', '['))).toBeNull();
  });

  it('length conta caracteres ou elementos', () => {
    expect(ev(op('length', 'LC000123'))).toBe(8);
    expect(ev(op('length', '$a'), { a: ['agua', 'luz'] })).toBe(2);
    expect(ev(op('length', '$a'), { a: null })).toBeNull();
  });

  it('concat junta e ignora nulos', () => {
    expect(ev(op('concat', '$rua', ' ', '$num'), { rua: 'Rua 1', num: 12 })).toBe('Rua 1 12');
    expect(ev(op('concat', '$rua', ' ', '$num'), { rua: 'Rua 1', num: null })).toBe('Rua 1 ');
  });

  it('upper, lower e trim devolvem null sobre null', () => {
    expect(ev(op('upper', 'lc'))).toBe('LC');
    expect(ev(op('lower', 'LC'))).toBe('lc');
    expect(ev(op('trim', '  x  '))).toBe('x');
    expect(ev(op('upper', '$a'), { a: null })).toBeNull();
  });
});

describe('conjuntos e repetíveis (F1.8)', () => {
  const dados: RecordData = {
    f_serv: ['agua', 'luz'],
    g_cont: [
      { f_leitura: 10, g_sub: [{ f_v: 1 }, { f_v: 2 }] },
      { f_leitura: 32.5, g_sub: [{ f_v: 4 }] },
      { f_leitura: null, g_sub: [] },
    ],
  };

  it('in aceita lista literal', () => {
    expect(ev(op('in', '$t', ['a', 'b']), { t: 'a' })).toBe(true);
    expect(ev(op('in', '$t', ['a', 'b']), { t: 'c' })).toBe(false);
    expect(ev(op('in', '$t', ['a', 'b']), { t: null })).toBeNull();
  });

  it('selected e count_selected sobre select_multiple', () => {
    expect(ev(op('selected', '$f_serv', 'agua'), dados)).toBe(true);
    expect(ev(op('selected', '$f_serv', 'gas'), dados)).toBe(false);
    expect(ev(op('count_selected', '$f_serv'), dados)).toBe(2);
    expect(ev(op('count_selected', '$f_nada'), dados)).toBe(0);
  });

  it('selected aceita também a forma ODK, com valores separados por espaço', () => {
    expect(ev(op('selected', '$s', 'luz'), { s: 'agua luz' })).toBe(true);
  });

  it('count conta instâncias; um repetível vazio conta zero', () => {
    expect(ev(op('count', '$g_cont'), dados)).toBe(3);
    expect(ev(op('count', '$g_inexistente'), dados)).toBe(0);
  });

  it('sum soma um campo em todas as instâncias, ignorando os nulos', () => {
    expect(ev(op('sum', '$g_cont', 'f_leitura'), dados)).toBe(42.5);
  });

  it('sum de um repetível vazio é zero, não null', () => {
    expect(ev(op('sum', '$g_vazio', 'f_x'), { g_vazio: [] })).toBe(0);
  });

  it('conta e soma dentro de um repetível aninhado, com $.. a resolver o pai', () => {
    const raiz = ctx(dados);
    const primeira = childContext(
      raiz,
      dados['g_cont'] ? (dados['g_cont'] as RecordData[])[0]! : {},
    );
    expect(evaluate(op('count', '$g_sub'), primeira)).toBe(2);
    expect(evaluate(op('sum', '$g_sub', 'f_v'), primeira)).toBe(3);
    // De dentro da instância, o total do repetível de fora continua alcançável.
    expect(evaluate(op('sum', '$..g_cont', 'f_leitura'), primeira)).toBe(42.5);
  });
});

describe('nulidade e controlo', () => {
  it('is_null cobre null, undefined, texto vazio e lista vazia', () => {
    expect(ev(op('is_null', '$a'), { a: null })).toBe(true);
    expect(ev(op('is_null', '$a'), {})).toBe(true);
    expect(ev(op('is_null', '$a'), { a: '' })).toBe(true);
    expect(ev(op('is_null', '$a'), { a: [] })).toBe(true);
    expect(ev(op('is_null', '$a'), { a: 0 })).toBe(false); // zero é um valor
    expect(ev(op('is_null', '$a'), { a: false })).toBe(false);
  });

  it('coalesce devolve o primeiro não nulo', () => {
    expect(ev(op('coalesce', '$a', 'sem código'), { a: null })).toBe('sem código');
    expect(ev(op('coalesce', '$a', 'sem código'), { a: 'LC1' })).toBe('LC1');
    expect(ev(op('coalesce', '$a', '$b'), { a: null, b: null })).toBeNull();
  });

  it('if escolhe um ramo e só avalia esse', () => {
    expect(ev(op('if', op('>', '$a', 3), 'sim', 'não'), { a: 4 })).toBe('sim');
    expect(ev(op('if', op('>', '$a', 3), 'sim', 'não'), { a: 1 })).toBe('não');
    // Condição indefinida segue pelo ramo falso: é a regra do §6.3.
    expect(ev(op('if', op('>', '$a', 3), 'sim', 'não'), { a: null })).toBe('não');
  });
});

describe('datas', () => {
  it('today e now usam o instante do contexto, para o teste ser reproduzível', () => {
    expect(ev(op('today'))).toBe('2026-09-05');
    expect(ev(op('now'))).toBe('2026-09-05T14:30:00.000Z');
  });

  it('date_diff_days conta dias inteiros', () => {
    expect(ev(op('date_diff_days', '2026-09-05', '2026-09-01'))).toBe(4);
    expect(ev(op('date_diff_days', '2026-09-01', '2026-09-05'))).toBe(-4);
    expect(ev(op('date_diff_days', '$f_data', op('today')), { f_data: '2026-09-10' })).toBe(5);
  });

  it('date_diff_days com data inválida ou nula dá null', () => {
    expect(ev(op('date_diff_days', 'ontem', '2026-09-01'))).toBeNull();
    expect(ev(op('date_diff_days', '$a', '2026-09-01'), { a: null })).toBeNull();
  });
});

describe('distance_m (F1.9)', () => {
  const ponto = (lat: number, lon: number) => ({
    lat,
    lon,
    accuracy_m: 0.02,
    fix_type: 'fixed',
    source: 'external_tcp',
  });

  // Valores de referência do elipsóide WGS84, independentes desta
  // implementação: um grau de longitude no equador e um grau de latitude
  // junto ao equador são constantes tabeladas.
  it('reproduz um grau de longitude no equador (111 319,49 m)', () => {
    const d = ev(op('distance_m', '$a', '$b'), { a: ponto(0, 0), b: ponto(0, 1) }) as number;
    expect(Math.abs(d - 111319.49) / 111319.49).toBeLessThan(0.0005);
  });

  it('reproduz um grau de latitude junto ao equador (110 574,39 m)', () => {
    const d = ev(op('distance_m', '$a', '$b'), { a: ponto(0, 0), b: ponto(1, 0) }) as number;
    expect(Math.abs(d - 110574.39) / 110574.39).toBeLessThan(0.0005);
  });

  it('Luanda–Caxito com erro abaixo de 0,5 % do valor conhecido', () => {
    // Luanda (-8,8383 / 13,2344) a Caxito, sede do Bengo (-8,5785 / 13,6644).
    // Referência, calculada à mão a partir das constantes tabeladas acima:
    // Δlat 0,2598° × 110 574 m = 28 727 m; Δlon 0,4300° × 111 319 × cos(8,7°)
    // = 47 317 m; hipotenusa = 55 354 m. É uma aproximação plana, boa a esta
    // escala, e serve exactamente para o que interessa: confirmar que o
    // resultado não vem de outra fórmula nem noutra unidade.
    const d = ev(op('distance_m', '$a', '$b'), {
      a: ponto(-8.8383, 13.2344),
      b: ponto(-8.5785, 13.6644),
    }) as number;
    expect(Math.abs(d - 55354) / 55354).toBeLessThan(0.005);
  });

  it('a mesma coordenada dá zero e um ponto em falta dá null', () => {
    expect(ev(op('distance_m', '$a', '$a'), { a: ponto(-8.8, 13.2) })).toBe(0);
    expect(ev(op('distance_m', '$a', '$b'), { a: ponto(-8.8, 13.2), b: null })).toBeNull();
  });
});

describe('robustez', () => {
  it('um operador desconhecido dá null em vez de rebentar', () => {
    expect(ev({ op: 'inventado', args: [1, 2] } as unknown as Expression)).toBeNull();
  });

  it('aridade errada dá null; recusá-la é trabalho do validador da definição', () => {
    expect(ev(op('=='))).toBeNull();
  });

  it('não há eval: uma string com código é apenas uma string', () => {
    expect(ev('1 + 1')).toBe('1 + 1');
  });
});
