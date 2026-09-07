/**
 * Preparação de uma fotografia antes de entrar na fila (F9.1).
 *
 * PORQUE É QUE ISTO IMPORTA MAIS DO QUE PARECE. A câmara de um Android de
 * gama baixa dá 4000×3000 e 4 MB. Numa rede de campo a 30 kB/s, isso são dois
 * minutos por foto e dinheiro real do técnico ou da empresa. Um formulário com
 * cinco fotos por registo e trinta registos por dia são 600 MB por dia e por
 * pessoa. Redimensionar para 1600 px do lado maior tira-lhe 90 % do peso sem
 * tirar nada do que se vê numa chapa de contador.
 *
 * O que vive aqui é a DECISÃO — que dimensões, que qualidade, se vale a pena
 * mexer no ficheiro. O trabalho sobre os pixels é do `expo-image-manipulator`,
 * que é nativo e entra por injecção: sem isso, esta parte só se poderia provar
 * com um telefone na mão, e é exactamente a parte onde é fácil enganar-se num
 * arredondamento e entregar imagens deformadas.
 */

export interface Dimensoes {
  largura: number;
  altura: number;
}

export interface PlanoDeRedimensionamento {
  /** `false` quando a imagem já é suficientemente pequena. */
  redimensionar: boolean;
  destino: Dimensoes;
  qualidade: number;
  motivo: string;
}

/**
 * Qualidade JPEG por omissão.
 *
 * 0,8 é o ponto em que a diferença deixa de se ver num ecrã de telemóvel e o
 * ficheiro já é menos de metade. Acima disso paga-se rede por pixels que
 * ninguém distingue; abaixo começam a aparecer artefactos em texto pequeno —
 * e o que se fotografa são muitas vezes números de série.
 */
const QUALIDADE_POR_OMISSAO = 0.8;

/**
 * Calcula o destino mantendo a proporção.
 *
 * Arredonda com `Math.round` e nunca abaixo de 1 px: um `Math.floor` numa
 * imagem muito estreita dá zero, e uma dimensão zero rebenta o manipulador
 * com um erro que não diz o que se passou.
 */
export function planearRedimensionamento(
  origem: Dimensoes,
  maxDimensaoPx: number | undefined,
  qualidade = QUALIDADE_POR_OMISSAO,
): PlanoDeRedimensionamento {
  if (
    !Number.isFinite(origem.largura) ||
    !Number.isFinite(origem.altura) ||
    origem.largura <= 0 ||
    origem.altura <= 0
  ) {
    throw new Error('dimensões da imagem inválidas');
  }

  if (!maxDimensaoPx || maxDimensaoPx <= 0) {
    return {
      redimensionar: false,
      destino: origem,
      qualidade,
      motivo: 'o formulário não define max_dimension_px',
    };
  }

  const maior = Math.max(origem.largura, origem.altura);
  if (maior <= maxDimensaoPx) {
    // Nunca AMPLIAR: subir a resolução de uma foto pequena só lhe acrescenta
    // bytes e não lhe acrescenta detalhe nenhum.
    return {
      redimensionar: false,
      destino: origem,
      qualidade,
      motivo: `já cabe em ${maxDimensaoPx} px`,
    };
  }

  const factor = maxDimensaoPx / maior;
  return {
    redimensionar: true,
    destino: {
      largura: Math.max(1, Math.round(origem.largura * factor)),
      altura: Math.max(1, Math.round(origem.altura * factor)),
    },
    qualidade,
    motivo: `${maior} px acima do limite de ${maxDimensaoPx} px`,
  };
}

/** O que o manipulador nativo tem de saber fazer. */
export interface ManipuladorDeImagem {
  medir(uri: string): Promise<Dimensoes>;
  redimensionar(
    uri: string,
    destino: Dimensoes,
    qualidade: number,
  ): Promise<{ uri: string; bytes: number }>;
  tamanho(uri: string): Promise<number>;
}

export interface FotografiaPreparada {
  uri: string;
  bytes: number;
  dimensoes: Dimensoes;
  /** `true` se o ficheiro entregue é diferente do original. */
  alterada: boolean;
  motivo: string;
}

/**
 * Prepara uma fotografia para a fila de anexos.
 *
 * Se o redimensionamento falhar, devolve o ORIGINAL em vez de rebentar. Uma
 * foto grande que sobe devagar é um problema de custo; uma foto que não sobe é
 * um problema de dados — e perder um registo de campo é o pior defeito
 * possível deste sistema.
 */
export async function prepararFotografia(
  uri: string,
  maxDimensaoPx: number | undefined,
  manipulador: ManipuladorDeImagem,
  qualidade = QUALIDADE_POR_OMISSAO,
): Promise<FotografiaPreparada> {
  const original = async (motivo: string): Promise<FotografiaPreparada> => ({
    uri,
    bytes: await manipulador.tamanho(uri).catch(() => 0),
    dimensoes: await manipulador.medir(uri).catch(() => ({ largura: 0, altura: 0 })),
    alterada: false,
    motivo,
  });

  let dimensoes: Dimensoes;
  try {
    dimensoes = await manipulador.medir(uri);
  } catch (erro) {
    return original(`não foi possível medir a imagem: ${mensagem(erro)}`);
  }

  const plano = planearRedimensionamento(dimensoes, maxDimensaoPx, qualidade);
  if (!plano.redimensionar) return original(plano.motivo);

  try {
    const resultado = await manipulador.redimensionar(uri, plano.destino, plano.qualidade);
    return {
      uri: resultado.uri,
      bytes: resultado.bytes,
      dimensoes: plano.destino,
      alterada: true,
      motivo: plano.motivo,
    };
  } catch (erro) {
    return original(`redimensionamento falhou, segue o original: ${mensagem(erro)}`);
  }
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
