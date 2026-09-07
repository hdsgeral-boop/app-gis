import type { GeopointValue, GnssSource } from '../types/index.js';

import type { LeituraGnss } from './nmea.js';

/**
 * Abstracção de fonte de localização (F7.1).
 *
 * Existe para que trocar de fonte — GPS interno, receptor externo por NMEA
 * sobre TCP, receptor por Bluetooth — não toque em código de formulário
 * nenhum. O renderizador recebe isto e não sabe de onde vem o ponto.
 *
 * A implementação com hardware a sério é a F7.2 e a F7.3, e vive na app
 * móvel: precisa de permissões e de módulos nativos. O que vive aqui é o
 * contrato e a conversão para o formato do Consul Colect, que é onde estão as regras
 * — e as regras são as mesmas no telefone e no servidor.
 */

export interface EstadoDaFonte {
  ligada: boolean;
  /** Nome legível: «GPS interno», «Emlid RS2 (TCP)». */
  descricao: string;
  ultimaLeitura: LeituraGnss | undefined;
  /** Instante da última leitura, para se saber se o receptor emudeceu. */
  ultimaLeituraEm: string | undefined;
}

export interface FonteDeLocalizacao {
  readonly source: GnssSource;
  readonly descricao: string;
  estado(): EstadoDaFonte;
  /** Uma leitura, ou erro. Nunca inventa um ponto (restrição inegociável 8). */
  obter(opcoes?: { tempoMaximoMs?: number }): Promise<GeopointValue>;
  /** Notifica a cada leitura nova. Devolve a função que cancela. */
  observar(aoLer: (leitura: LeituraGnss) => void): () => void;
}

/**
 * Converte uma leitura NMEA no ponto que fica gravado.
 *
 * Recusa-se a produzir um ponto sem precisão, tipo de fixo e origem — é a
 * restrição inegociável 8, e é aqui que ela é aplicada no caminho do GNSS.
 * Devolver um ponto sem esses campos seria pior do que não devolver nenhum: um
 * ponto sem precisão não é auditável e não se pode comparar com o limiar.
 */
export function pontoDeLeitura(
  leitura: LeituraGnss,
  source: GnssSource,
): GeopointValue | { erro: string } {
  if (leitura.accuracyM === undefined) {
    return {
      erro:
        'o receptor não deu precisão: sem GST e sem HDOP não há forma honesta de a saber. ' +
        'Um ponto sem precisão não pode ser gravado.',
    };
  }
  if (leitura.fixType === 'unknown') {
    return { erro: 'o receptor não tem fixo válido neste momento' };
  }

  const ponto: GeopointValue = {
    lat: leitura.lat,
    lon: leitura.lon,
    accuracy_m: leitura.accuracyM,
    fix_type: leitura.fixType,
    source,
  };
  if (leitura.alt !== undefined) ponto.alt = leitura.alt;
  if (leitura.collectedAt !== undefined) ponto.collected_at = leitura.collectedAt;
  return ponto;
}

export function eErro(valor: GeopointValue | { erro: string }): valor is { erro: string } {
  return typeof (valor as { erro?: unknown }).erro === 'string';
}

/**
 * Decide se um ponto passa o limiar de precisão do formulário.
 *
 * A regra da ESPECIFICACAO §11: acima do limiar a app avisa de forma visível e
 * só grava com justificação escrita. Nunca recusa — recusar seria mandar o
 * técnico embora sem o registo.
 */
export interface AvaliacaoDePrecisao {
  aceitavel: boolean;
  limiarM: number | undefined;
  precisaoM: number;
  /** `true` quando a precisão foi estimada do HDOP em vez de medida. */
  estimada: boolean;
  aviso: string | undefined;
}

export function avaliarPrecisao(
  ponto: GeopointValue,
  limiarM: number | undefined,
  estimada = false,
): AvaliacaoDePrecisao {
  const precisaoM = ponto.accuracy_m;
  if (limiarM === undefined) {
    return { aceitavel: true, limiarM, precisaoM, estimada, aviso: undefined };
  }
  if (precisaoM <= limiarM) {
    return {
      aceitavel: true,
      limiarM,
      precisaoM,
      estimada,
      aviso: estimada ? 'a precisão é estimada a partir do HDOP: o receptor não dá GST' : undefined,
    };
  }
  return {
    aceitavel: false,
    limiarM,
    precisaoM,
    estimada,
    aviso:
      `Precisão de ${precisaoM.toFixed(2)} m, acima do limiar de ${limiarM} m. ` +
      'Podes gravar, mas tens de escrever porquê — a justificação fica na revisão.',
  };
}
