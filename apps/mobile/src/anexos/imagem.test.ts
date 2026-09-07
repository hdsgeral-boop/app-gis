import { describe, expect, it } from 'vitest';

import {
  planearRedimensionamento,
  prepararFotografia,
  type Dimensoes,
  type ManipuladorDeImagem,
} from './imagem.js';

/**
 * F9.1 — redimensionar antes de entrar na fila.
 *
 * O trabalho sobre os pixels é nativo e não se testa aqui. O que se testa é a
 * decisão, que é onde os erros custam dinheiro a sério: ampliar uma foto
 * pequena, deformar uma panorâmica, ou deixar passar 4 MB porque o
 * `max_dimension_px` veio indefinido.
 */

/** Câmara de um Android de gama baixa. */
const CAMARA: Dimensoes = { largura: 4000, altura: 3000 };

function manipulador(
  dimensoes: Dimensoes,
  opcoes: { falharMedida?: boolean; falharRedimensionar?: boolean; bytes?: number } = {},
): ManipuladorDeImagem & { chamadas: Dimensoes[] } {
  const chamadas: Dimensoes[] = [];
  return {
    chamadas,
    async medir() {
      if (opcoes.falharMedida) throw new Error('ficheiro ilegível');
      return dimensoes;
    },
    async redimensionar(_uri, destino) {
      if (opcoes.falharRedimensionar) throw new Error('sem memória');
      chamadas.push(destino);
      return { uri: 'file://reduzida.jpg', bytes: 320_000 };
    },
    async tamanho() {
      return opcoes.bytes ?? 4_000_000;
    },
  };
}

describe('F9.1 — que dimensões usar', () => {
  it('reduz o lado maior ao limite e mantém a proporção', () => {
    const plano = planearRedimensionamento(CAMARA, 1600);
    expect(plano.redimensionar).toBe(true);
    expect(plano.destino).toEqual({ largura: 1600, altura: 1200 });
    // 4:3 continua 4:3. Uma foto deformada de um contador não se lê.
    expect(plano.destino.largura / plano.destino.altura).toBeCloseTo(4 / 3, 5);
  });

  it('usa o lado maior mesmo quando a foto está de pé', () => {
    const plano = planearRedimensionamento({ largura: 3000, altura: 4000 }, 1600);
    expect(plano.destino).toEqual({ largura: 1200, altura: 1600 });
  });

  it('nunca amplia uma foto que já é pequena', () => {
    // Ampliar acrescenta bytes e não acrescenta detalhe nenhum.
    const plano = planearRedimensionamento({ largura: 800, altura: 600 }, 1600);
    expect(plano.redimensionar).toBe(false);
    expect(plano.destino).toEqual({ largura: 800, altura: 600 });
  });

  it('sem max_dimension_px não mexe no ficheiro', () => {
    // O limite é dado do formulário. Inventar um aqui seria decidir pelo
    // administrador — e para um levantamento de fissuras 1600 px pode ser
    // pouco.
    const plano = planearRedimensionamento(CAMARA, undefined);
    expect(plano.redimensionar).toBe(false);
    expect(plano.motivo).toContain('max_dimension_px');
  });

  it('uma imagem muito estreita nunca fica com uma dimensão a zero', () => {
    // Com `Math.floor`, 8000×3 a 1600 px daria altura 0 — e o manipulador
    // rebenta com um erro que não diz o que se passou.
    const plano = planearRedimensionamento({ largura: 8000, altura: 3 }, 1600);
    expect(plano.destino.altura).toBeGreaterThanOrEqual(1);
    expect(plano.destino.largura).toBe(1600);
  });

  it('dimensões inválidas dão erro em vez de um plano inventado', () => {
    expect(() => planearRedimensionamento({ largura: 0, altura: 100 }, 1600)).toThrow(/inválidas/);
  });
});

describe('F9.1 — preparar a fotografia', () => {
  it('entrega a imagem reduzida quando há limite', async () => {
    const m = manipulador(CAMARA);
    const pronta = await prepararFotografia('file://original.jpg', 1600, m);

    expect(pronta.alterada).toBe(true);
    expect(pronta.uri).toBe('file://reduzida.jpg');
    expect(pronta.bytes).toBe(320_000);
    expect(m.chamadas).toEqual([{ largura: 1600, altura: 1200 }]);
  });

  it('se o redimensionamento falhar, segue o original', async () => {
    // Uma foto grande que sobe devagar custa dinheiro; uma foto que não sobe
    // é um registo de campo incompleto, e isso é pior.
    const m = manipulador(CAMARA, { falharRedimensionar: true });
    const pronta = await prepararFotografia('file://original.jpg', 1600, m);

    expect(pronta.alterada).toBe(false);
    expect(pronta.uri).toBe('file://original.jpg');
    expect(pronta.bytes).toBe(4_000_000);
    expect(pronta.motivo).toContain('segue o original');
  });

  it('se nem sequer se conseguir medir, segue o original', async () => {
    const m = manipulador(CAMARA, { falharMedida: true });
    const pronta = await prepararFotografia('file://original.jpg', 1600, m);

    expect(pronta.alterada).toBe(false);
    expect(pronta.uri).toBe('file://original.jpg');
  });

  it('não toca no ficheiro quando já cabe no limite', async () => {
    const m = manipulador({ largura: 1200, altura: 900 }, { bytes: 180_000 });
    const pronta = await prepararFotografia('file://pequena.jpg', 1600, m);

    expect(pronta.alterada).toBe(false);
    expect(m.chamadas).toEqual([]);
  });
});
