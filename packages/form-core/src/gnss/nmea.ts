import type { GnssFixType } from '../types/index.js';

/**
 * Analisador de NMEA 0183 (F7.4).
 *
 * Vive no `form-core` por uma razão prática: a app precisa dele para ler um
 * receptor externo, e o servidor precisa dele para validar o que a app lhe
 * manda e para o relatório de qualidade. Duas implementações do mesmo formato
 * divergiriam exactamente no que interessa — a interpretação da qualidade do
 * fixo.
 *
 * Trata as três frases que decidem tudo:
 *   - `GGA` — posição, qualidade do fixo, satélites, HDOP, idade das correcções
 *   - `RMC` — posição, data e hora, e se o fixo é válido
 *   - `GST` — desvio padrão da posição, que é a ÚNICA fonte honesta de
 *     precisão em metros. Sem `GST`, o que se tem é uma estimativa a partir do
 *     HDOP, e isso é dito a quem lê.
 *
 * Regra que atravessa o ficheiro: uma frase que não se percebe é IGNORADA, não
 * é adivinhada. Um receptor a debitar lixo não pode fazer a app gravar um
 * ponto inventado (restrição inegociável 8).
 */

export interface FraseNmea {
  /** `GGA`, `RMC`, `GST`… já sem o prefixo do talker (`GP`, `GN`, `GA`). */
  tipo: string;
  campos: string[];
  /** `true` se a frase trazia checksum e ele bateu certo. */
  checksumValido: boolean;
}

/**
 * Qualidade do fixo, tal como o campo 6 da GGA a codifica.
 *
 * A correspondência não é decorativa: é ela que distingue um ponto de 2 cm de
 * um ponto de 5 m, e é ela que o limiar de precisão do formulário usa.
 */
const QUALIDADE_GGA: Record<string, GnssFixType> = {
  '0': 'unknown', // sem fixo
  '1': 'single', // autónomo
  '2': 'dgps',
  '3': 'single', // PPS
  '4': 'fixed', // RTK com ambiguidades resolvidas
  '5': 'float', // RTK float
  '6': 'unknown', // estimado (dead reckoning) — NÃO é uma posição medida
  '7': 'manual',
  '8': 'unknown', // modo de simulação
  '9': 'has_ppp',
};

export interface LeituraGnss {
  lat: number;
  lon: number;
  alt: number | undefined;
  fixType: GnssFixType;
  satellites: number | undefined;
  hdop: number | undefined;
  pdop: number | undefined;
  /**
   * Precisão horizontal em metros. Vem do `GST` quando existe; caso contrário
   * é estimada a partir do HDOP e `precisaoEstimada` fica `true`.
   */
  accuracyM: number | undefined;
  precisaoEstimada: boolean;
  /** Idade das correcções diferenciais, em segundos. */
  correctionsAgeS: number | undefined;
  collectedAt: string | undefined;
}

/** Divide uma frase NMEA e verifica o checksum. */
export function analisarFrase(linha: string): FraseNmea | undefined {
  const limpa = linha.trim();
  if (!limpa.startsWith('$') && !limpa.startsWith('!')) return undefined;

  const asterisco = limpa.lastIndexOf('*');
  const corpo = asterisco === -1 ? limpa.slice(1) : limpa.slice(1, asterisco);
  const esperado = asterisco === -1 ? undefined : limpa.slice(asterisco + 1, asterisco + 3);

  let checksum = 0;
  for (let i = 0; i < corpo.length; i++) checksum ^= corpo.charCodeAt(i);
  const calculado = checksum.toString(16).toUpperCase().padStart(2, '0');

  const campos = corpo.split(',');
  const cabecalho = campos[0] ?? '';
  if (cabecalho.length < 3) return undefined;

  return {
    // Os dois primeiros caracteres são o talker: GP (GPS), GN (multi-
    // constelação), GA (Galileo)… O que interessa é o resto.
    tipo: cabecalho.slice(2),
    campos,
    checksumValido: esperado !== undefined && esperado.toUpperCase() === calculado,
  };
}

/**
 * Acumula frases e produz uma leitura completa.
 *
 * Existe porque a informação vem repartida: a posição está na GGA, a precisão
 * em metros na GST, e a data na RMC. Um receptor debita-as em rajada, várias
 * vezes por segundo, e o que a app precisa é do conjunto.
 */
export class LeitorNmea {
  private ultimaGga: LeituraGnss | undefined;
  private ultimaData: string | undefined;
  private desvioGst: number | undefined;
  private pdop: number | undefined;
  /** Frases com checksum errado desde o arranque. Diagnóstico de cabo/rádio. */
  private corrompidas = 0;

  /**
   * Consome uma linha. Devolve a leitura corrente quando ela ficou completa
   * com esta frase, e `undefined` quando ainda falta alguma coisa.
   */
  consumir(linha: string): LeituraGnss | undefined {
    const frase = analisarFrase(linha);
    if (!frase) return undefined;
    if (!frase.checksumValido) {
      // Um checksum errado significa cabo mau, rádio com interferência ou
      // baud rate errado. Aceitar a frase seria gravar uma posição que o
      // receptor não disse.
      this.corrompidas++;
      return undefined;
    }

    switch (frase.tipo) {
      case 'GGA':
        this.ultimaGga = this.lerGga(frase.campos);
        break;
      case 'GST':
        this.desvioGst = this.lerGst(frase.campos);
        break;
      case 'RMC':
        this.ultimaData = this.lerRmc(frase.campos);
        break;
      case 'GSA':
        this.pdop = numero(frase.campos[15]);
        break;
      default:
        return undefined;
    }

    return this.leitura();
  }

  get frasesCorrompidas(): number {
    return this.corrompidas;
  }

  /** A leitura acumulada, ou `undefined` se ainda não houver posição. */
  leitura(): LeituraGnss | undefined {
    if (!this.ultimaGga) return undefined;
    const base = this.ultimaGga;

    // O GST dá o desvio padrão em latitude e longitude; a precisão horizontal
    // é a raiz da soma dos quadrados. Quando não há GST, estima-se a partir do
    // HDOP — e diz-se que é uma estimativa, porque é.
    const accuracyM =
      this.desvioGst ?? (base.hdop !== undefined ? base.hdop * ERRO_TIPICO_POR_HDOP_M : undefined);

    return {
      ...base,
      accuracyM,
      precisaoEstimada: this.desvioGst === undefined && accuracyM !== undefined,
      pdop: this.pdop,
      ...(this.ultimaData ? { collectedAt: this.ultimaData } : {}),
    };
  }

  private lerGga(campos: string[]): LeituraGnss | undefined {
    const lat = coordenada(campos[2], campos[3]);
    const lon = coordenada(campos[4], campos[5]);
    const qualidade = campos[6] ?? '0';
    if (lat === undefined || lon === undefined) return undefined;
    // Qualidade 0 é «sem fixo»: as coordenadas que vierem não valem nada.
    if (qualidade === '0') return undefined;

    return {
      lat,
      lon,
      alt: numero(campos[9]),
      fixType: QUALIDADE_GGA[qualidade] ?? 'unknown',
      satellites: inteiro(campos[7]),
      hdop: numero(campos[8]),
      pdop: undefined,
      accuracyM: undefined,
      precisaoEstimada: false,
      correctionsAgeS: numero(campos[13]),
      collectedAt: undefined,
    };
  }

  private lerGst(campos: string[]): number | undefined {
    const desvioLat = numero(campos[6]);
    const desvioLon = numero(campos[7]);
    if (desvioLat === undefined || desvioLon === undefined) return undefined;
    return Math.sqrt(desvioLat ** 2 + desvioLon ** 2);
  }

  private lerRmc(campos: string[]): string | undefined {
    // Campo 2: A = activo, V = aviso (o fixo não é de confiança).
    if (campos[2] !== 'A') return undefined;
    const hora = campos[1] ?? '';
    const data = campos[9] ?? '';
    if (hora.length < 6 || data.length !== 6) return undefined;

    const dia = data.slice(0, 2);
    const mes = data.slice(2, 4);
    // O NMEA dá dois dígitos de ano. Um receptor não vai ser usado antes de
    // 2000, e usar 1970 como pivô punha os pontos no século errado.
    const ano = Number(data.slice(4, 6)) + 2000;
    const hh = hora.slice(0, 2);
    const mm = hora.slice(2, 4);
    const ss = hora.slice(4);
    return `${ano}-${mes}-${dia}T${hh}:${mm}:${ss.padStart(2, '0')}${ss.includes('.') ? '' : ''}Z`.replace(
      /T(\d{2}):(\d{2}):(\d+(?:\.\d+)?)Z/,
      (_, h, m, s) => {
        const segundos = Number(s);
        return `T${h}:${m}:${segundos.toFixed(3).padStart(6, '0')}Z`;
      },
    );
  }
}

/**
 * Factor de conversão de HDOP para metros, quando não há GST.
 *
 * É uma ESTIMATIVA grosseira: assume um erro típico de ~2,5 m por unidade de
 * HDOP num receptor de código. Está aqui para dar uma ordem de grandeza a quem
 * está no terreno, e nunca para alimentar um limiar de precisão sem que o
 * técnico saiba que é uma estimativa — daí o `precisaoEstimada`.
 */
const ERRO_TIPICO_POR_HDOP_M = 2.5;

/** `4004.1234`, `N` → graus decimais. */
function coordenada(valor: string | undefined, hemisferio: string | undefined): number | undefined {
  if (!valor || !hemisferio) return undefined;
  const ponto = valor.indexOf('.');
  if (ponto < 3) return undefined;
  // O NMEA junta graus e minutos no mesmo número: `ddmm.mmmm`. Os graus são
  // tudo menos os dois dígitos de minutos antes do ponto.
  const graus = Number(valor.slice(0, ponto - 2));
  const minutos = Number(valor.slice(ponto - 2));
  if (!Number.isFinite(graus) || !Number.isFinite(minutos)) return undefined;
  const decimal = graus + minutos / 60;
  if (!Number.isFinite(decimal)) return undefined;
  return hemisferio === 'S' || hemisferio === 'W' ? -decimal : decimal;
}

function numero(valor: string | undefined): number | undefined {
  if (valor === undefined || valor === '') return undefined;
  const n = Number(valor);
  return Number.isFinite(n) ? n : undefined;
}

function inteiro(valor: string | undefined): number | undefined {
  const n = numero(valor);
  return n === undefined ? undefined : Math.trunc(n);
}
