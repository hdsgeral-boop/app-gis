import { describe, expect, it } from 'vitest';

import { LeitorNmea, analisarFrase, avaliarPrecisao, eErro, pontoDeLeitura } from '../src/index.js';

/**
 * F7.4 — o analisador de NMEA.
 *
 * As frases usadas aqui têm o formato e os valores de um receptor a sério — um
 * Emlid Reach a debitar RTK fixo — com os checksums calculados. O que se está a
 * proteger é a interpretação da QUALIDADE do fixo: é ela que distingue um
 * ponto de 2 cm de um ponto de 5 m, e é ela que o limiar de precisão do
 * formulário compara. Ler mal o campo 6 da GGA faz um cadastro inteiro parecer
 * bom quando não é.
 */

// Emlid Reach a debitar um fixo RTK resolvido.
const GGA_FIXO = '$GNGGA,142530.00,0850.29800,S,01314.06400,E,4,12,0.61,68.4,M,17.2,M,1.0,0000*45';
const GST = '$GNGST,142530.00,0.021,0.018,0.014,0.0,0.018,0.014,0.031*49';
const RMC = '$GNRMC,142530.00,A,0850.29800,S,01314.06400,E,0.03,0.00,050926,,,A*5C';
const GSA = '$GNGSA,A,3,05,07,09,13,15,20,21,30,,,,,1.21,0.61,1.04*13';

/** O mesmo receptor sem correcções: autónomo, com HDOP mau. */
const GGA_AUTONOMO = '$GPGGA,142600.00,0850.29500,S,01314.06100,E,1,06,2.40,66.1,M,17.2,M,,*76';

function comChecksum(corpo: string): string {
  let c = 0;
  for (let i = 0; i < corpo.length; i++) c ^= corpo.charCodeAt(i);
  return `$${corpo}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}

describe('análise de frases', () => {
  it('separa o tipo, ignorando o talker', () => {
    expect(analisarFrase(GGA_FIXO)?.tipo).toBe('GGA');
    expect(analisarFrase(GGA_AUTONOMO)?.tipo).toBe('GGA');
    expect(analisarFrase(GSA)?.tipo).toBe('GSA');
  });

  it('valida o checksum', () => {
    expect(analisarFrase(comChecksum('GNGGA,1,2,3'))?.checksumValido).toBe(true);
    expect(analisarFrase('$GNGGA,1,2,3*00')?.checksumValido).toBe(false);
  });

  it('ignora o que não é uma frase NMEA', () => {
    expect(analisarFrase('isto não é NMEA')).toBeUndefined();
    expect(analisarFrase('')).toBeUndefined();
  });
});

describe('leitura de posição', () => {
  it('converte graus e minutos em graus decimais, com o sinal do hemisfério', () => {
    const leitor = new LeitorNmea();
    const leitura = leitor.consumir(GGA_FIXO);
    // 08°50,298' S = -(8 + 50,298/60) = -8,83830
    expect(leitura?.lat).toBeCloseTo(-8.8383, 5);
    // 013°14,064' E = 13 + 14,064/60 = 13,2344
    expect(leitura?.lon).toBeCloseTo(13.2344, 5);
    expect(leitura?.alt).toBeCloseTo(68.4, 2);
  });

  it('lê os satélites, o HDOP e a idade das correcções', () => {
    const leitura = new LeitorNmea().consumir(GGA_FIXO);
    expect(leitura?.satellites).toBe(12);
    expect(leitura?.hdop).toBeCloseTo(0.61, 2);
    expect(leitura?.correctionsAgeS).toBeCloseTo(1.0, 2);
  });

  it('uma frase com checksum errado é ignorada, não adivinhada', () => {
    const leitor = new LeitorNmea();
    // Cabo mau, interferência no rádio, baud rate errado: aceitar isto seria
    // gravar uma posição que o receptor não disse.
    expect(
      leitor.consumir(
        '$GNGGA,142530.00,0850.29800,S,01314.06400,E,4,12,0.61,68.4,M,17.2,M,1.0,0000*00',
      ),
    ).toBeUndefined();
    expect(leitor.frasesCorrompidas).toBe(1);
    expect(leitor.leitura()).toBeUndefined();
  });

  it('qualidade 0 é «sem fixo»: as coordenadas não valem nada', () => {
    const semFixo = comChecksum('GPGGA,142600.00,0850.29500,S,01314.06100,E,0,00,99.9,,M,,M,,');
    expect(new LeitorNmea().consumir(semFixo)).toBeUndefined();
  });
});

describe('qualidade do fixo — o campo que decide tudo', () => {
  const casos: Array<[string, string]> = [
    ['1', 'single'],
    ['2', 'dgps'],
    ['4', 'fixed'],
    ['5', 'float'],
    ['9', 'has_ppp'],
    ['7', 'manual'],
    // 6 é «estimado» (dead reckoning): NÃO é uma posição medida.
    ['6', 'unknown'],
    // 8 é modo de simulação. Gravar isto como um ponto real seria pôr dados
    // inventados num cadastro.
    ['8', 'unknown'],
  ];

  for (const [codigo, esperado] of casos) {
    it(`qualidade ${codigo} é ${esperado}`, () => {
      const frase = comChecksum(
        `GNGGA,142530.00,0850.29800,S,01314.06400,E,${codigo},12,0.61,68.4,M,17.2,M,1.0,0000`,
      );
      expect(new LeitorNmea().consumir(frase)?.fixType).toBe(esperado);
    });
  }
});

describe('precisão em metros', () => {
  it('com GST, a precisão é medida', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    const leitura = leitor.consumir(GST);
    // sqrt(0,018² + 0,014²) ≈ 0,0228 m
    expect(leitura?.accuracyM).toBeCloseTo(0.0228, 3);
    expect(leitura?.precisaoEstimada).toBe(false);
  });

  it('sem GST, a precisão é estimada do HDOP — e diz-se que é', () => {
    const leitura = new LeitorNmea().consumir(GGA_AUTONOMO);
    expect(leitura?.precisaoEstimada).toBe(true);
    expect(leitura?.accuracyM).toBeCloseTo(2.4 * 2.5, 2);
  });

  it('o PDOP vem da GSA — e é o PDOP, não o VDOP', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    const leitura = leitor.consumir(GSA);
    // Os três últimos campos da GSA são PDOP, HDOP e VDOP, por essa ordem:
    // 1,21 / 0,61 / 1,04. Trocá-los é fácil e passa despercebido — o HDOP da
    // GSA bate certo com o da GGA, e é isso que serve de confirmação.
    expect(leitura?.pdop).toBeCloseTo(1.21, 2);
    expect(leitura?.hdop).toBeCloseTo(0.61, 2);
  });
});

describe('data e hora', () => {
  it('a RMC dá o instante em UTC', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    const leitura = leitor.consumir(RMC);
    expect(leitura?.collectedAt).toBe('2026-09-05T14:25:30.000Z');
  });

  it('uma RMC com aviso (V) não dá instante nenhum', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    const aviso = comChecksum('GNRMC,142530.00,V,0850.29800,S,01314.06400,E,0.03,0.00,050926,,,N');
    const leitura = leitor.consumir(aviso);
    expect(leitura?.collectedAt).toBeUndefined();
  });
});

describe('conversão para o ponto que fica gravado', () => {
  it('um fixo RTK com GST produz um ponto completo', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    leitor.consumir(GST);
    const leitura = leitor.consumir(RMC)!;

    const ponto = pontoDeLeitura(leitura, 'external_tcp');
    expect(eErro(ponto)).toBe(false);
    if (eErro(ponto)) return;

    // Restrição inegociável 8: precisão, tipo de fixo e origem, sempre.
    expect(ponto).toMatchObject({ fix_type: 'fixed', source: 'external_tcp' });
    expect(ponto.accuracy_m).toBeCloseTo(0.0228, 3);
    expect(ponto.collected_at).toBe('2026-09-05T14:25:30.000Z');
  });

  it('sem precisão nenhuma, recusa-se a produzir um ponto', () => {
    // Um receptor sem GST e sem HDOP. Devolver um ponto sem precisão seria
    // pior do que não devolver nenhum: não é auditável nem comparável com o
    // limiar do formulário.
    const semHdop = comChecksum(
      'GNGGA,142530.00,0850.29800,S,01314.06400,E,4,12,,68.4,M,17.2,M,1.0,0000',
    );
    const leitura = new LeitorNmea().consumir(semHdop)!;
    const resultado = pontoDeLeitura(leitura, 'external_tcp');
    expect(eErro(resultado)).toBe(true);
    if (!eErro(resultado)) return;
    expect(resultado.erro).toContain('precisão');
  });
});

describe('F7.7 — limiar de precisão por formulário', () => {
  const ponto = (accuracy: number) => ({
    lat: -8.8383,
    lon: 13.2344,
    accuracy_m: accuracy,
    fix_type: 'fixed' as const,
    source: 'external_tcp' as const,
  });

  it('abaixo do limiar, passa sem aviso', () => {
    expect(avaliarPrecisao(ponto(0.02), 2)).toMatchObject({ aceitavel: true, aviso: undefined });
  });

  it('acima do limiar, avisa e explica o que fazer — mas não recusa', () => {
    const avaliacao = avaliarPrecisao(ponto(12), 2);
    expect(avaliacao.aceitavel).toBe(false);
    expect(avaliacao.aviso).toContain('12.00 m');
    expect(avaliacao.aviso).toContain('escrever porquê');
  });

  it('sem limiar definido, qualquer precisão passa', () => {
    expect(avaliarPrecisao(ponto(30), undefined).aceitavel).toBe(true);
  });

  it('uma precisão estimada é assinalada mesmo quando passa', () => {
    const avaliacao = avaliarPrecisao(ponto(1), 2, true);
    expect(avaliacao.aceitavel).toBe(true);
    expect(avaliacao.aviso).toContain('estimada');
  });
});

describe('uma rajada real do receptor', () => {
  it('acumula as frases e produz uma leitura completa', () => {
    const leitor = new LeitorNmea();
    let ultima;
    for (const linha of [GSA, GGA_FIXO, GST, RMC]) {
      const leitura = leitor.consumir(linha);
      if (leitura) ultima = leitura;
    }
    expect(ultima).toMatchObject({ fixType: 'fixed', satellites: 12, precisaoEstimada: false });
    expect(ultima?.pdop).toBeCloseTo(1.21, 2);
    expect(ultima?.collectedAt).toBe('2026-09-05T14:25:30.000Z');
  });

  it('lixo pelo meio não estraga a leitura', () => {
    const leitor = new LeitorNmea();
    leitor.consumir(GGA_FIXO);
    leitor.consumir('\x00\x00lixo binário do cabo');
    leitor.consumir('$GNGGA,truncad');
    const leitura = leitor.consumir(GST);
    expect(leitura?.lat).toBeCloseTo(-8.8383, 5);
  });
});
