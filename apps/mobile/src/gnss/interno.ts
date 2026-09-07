import * as Location from 'expo-location';
import {
  avaliarPrecisao,
  type EstadoDaFonte,
  type FonteDeLocalizacao,
  type GeopointValue,
  type LeituraGnss,
} from '@cvforms/form-core';

/**
 * GPS interno do telefone (F7.2).
 *
 * É a fonte que a maioria dos técnicos vai usar na maioria dos dias: um
 * receptor externo custa dinheiro e nem todas as brigadas têm um. Um Android
 * de gama baixa em céu aberto dá 3 a 8 m; encostado a um muro, 20 ou mais.
 *
 * TRÊS COISAS QUE ESTA CLASSE FAZ E QUE UM `getCurrentPositionAsync` DIRECTO
 * NÃO FAZ:
 *
 * 1. **Recusa-se a devolver a última posição conhecida.** O Android guarda a
 *    última posição e devolve-a de imediato — pode ser de há uma hora e de
 *    outro bairro. Aqui só passa uma leitura fresca; entre um erro e uma
 *    posição de há uma hora, o erro é melhor, porque o técnico move-se.
 * 2. **Espera que a precisão estabilize.** O primeiro fixo de um telefone vem
 *    com 30 ou 50 m e melhora ao longo de alguns segundos. Gravar o primeiro
 *    é gravar o pior, e é a precisão que decide se o ponto passa o limiar do
 *    formulário.
 * 3. **Nunca inventa `fix_type` nem `source`.** A restrição inegociável 8
 *    obriga os três campos, e o Android não diz que tipo de fixo tem — o que
 *    dá é uma estimativa de erro. Um GPS de telemóvel sem correcções é
 *    `single`, e é isso que fica gravado. Chamar-lhe outra coisa seria mentir
 *    a quem depois olhar para o cadastro.
 */

export interface OpcoesInterno {
  /** Quanto tempo esperar até desistir. */
  tempoMaximoMs?: number;
  /**
   * Abaixo de que precisão se pára de esperar por melhor. Sem isto, um
   * telefone parado debaixo de uma laje ficava a tentar até ao tempo máximo.
   */
  precisaoSuficienteM?: number;
  /** Injectáveis para os testes não dependerem do relógio nem do hardware. */
  agora?: () => number;
}

export class FonteGpsInterno implements FonteDeLocalizacao {
  readonly source = 'internal' as const;
  readonly descricao = 'GPS do telefone';

  private ultima: LeituraGnss | undefined;
  private ultimaEm: number | undefined;
  private subscricao: Location.LocationSubscription | undefined;
  private readonly ouvintes = new Set<(leitura: LeituraGnss) => void>();
  private readonly opcoes: Required<OpcoesInterno>;

  constructor(opcoes: OpcoesInterno = {}) {
    this.opcoes = {
      tempoMaximoMs: opcoes.tempoMaximoMs ?? 20_000,
      precisaoSuficienteM: opcoes.precisaoSuficienteM ?? 8,
      agora: opcoes.agora ?? (() => Date.now()),
    };
  }

  /**
   * Pede a permissão. Devolve o que aconteceu em vez de rebentar: um técnico
   * que recusou a permissão tem de ver uma explicação, e não um ecrã em branco.
   */
  async permissao(): Promise<{ concedida: boolean; motivo?: string }> {
    const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') return { concedida: true };
    return {
      concedida: false,
      motivo: canAskAgain
        ? 'A app precisa de acesso à localização para georreferenciar os registos.'
        : 'O acesso à localização foi recusado. Tens de o activar nas definições do telefone, em Aplicações → Consul Colect → Permissões.',
    };
  }

  estado(): EstadoDaFonte {
    return {
      ligada: this.subscricao !== undefined,
      descricao: this.descricao,
      ultimaLeitura: this.ultima,
      ultimaLeituraEm: this.ultimaEm ? new Date(this.ultimaEm).toISOString() : undefined,
    };
  }

  observar(aoLer: (leitura: LeituraGnss) => void): () => void {
    this.ouvintes.add(aoLer);
    return () => this.ouvintes.delete(aoLer);
  }

  /**
   * Mantém o GPS a debitar, para o ecrã mostrar a precisão a melhorar.
   *
   * Custa bateria, e por isso só se liga enquanto um campo de geometria está à
   * vista — nunca em segundo plano.
   */
  async ligar(): Promise<void> {
    if (this.subscricao) return;
    const permissao = await this.permissao();
    if (!permissao.concedida) throw new Error(permissao.motivo);

    this.subscricao = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
      },
      (posicao) => this.consumir(posicao),
    );
  }

  desligar(): void {
    this.subscricao?.remove();
    this.subscricao = undefined;
  }

  async obter(opcoes: { tempoMaximoMs?: number } = {}): Promise<GeopointValue> {
    const limite = opcoes.tempoMaximoMs ?? this.opcoes.tempoMaximoMs;
    const permissao = await this.permissao();
    if (!permissao.concedida) throw new Error(permissao.motivo);

    const inicio = this.opcoes.agora();
    // Uma leitura de há mais de cinco segundos já não serve para um ponto que
    // se está a gravar agora.
    const fresca =
      this.ultima && this.ultimaEm && inicio - this.ultimaEm < 5_000 ? this.ultima : undefined;
    if (fresca && (fresca.accuracyM ?? Infinity) <= this.opcoes.precisaoSuficienteM) {
      return this.converter(fresca);
    }

    const melhor = await this.esperarPelaMelhor(limite, fresca);
    if (!melhor) {
      throw new Error(
        `o GPS não deu posição em ${Math.round(limite / 1000)} s. Sai para um sítio com céu aberto e tenta outra vez — o registo não se perde.`,
      );
    }
    return this.converter(melhor);
  }

  /** Precisão da última leitura contra o limiar do formulário. */
  avaliar(limiarM: number | undefined) {
    if (!this.ultima?.accuracyM) return undefined;
    return avaliarPrecisao(this.converter(this.ultima), limiarM, false);
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  /**
   * Fica a ouvir e guarda a melhor leitura até a precisão chegar ao suficiente
   * ou o tempo acabar. Devolve a melhor que viu, e não a última.
   */
  private esperarPelaMelhor(
    limiteMs: number,
    inicial: LeituraGnss | undefined,
  ): Promise<LeituraGnss | undefined> {
    return new Promise((resolver) => {
      let melhor = inicial;
      let terminado = false;
      const fechar = () => {
        if (terminado) return;
        terminado = true;
        cancelar();
        clearTimeout(temporizador);
        if (!ligadaAntes) this.desligar();
        resolver(melhor);
      };

      const ligadaAntes = this.subscricao !== undefined;
      const cancelar = this.observar((leitura) => {
        if ((leitura.accuracyM ?? Infinity) < (melhor?.accuracyM ?? Infinity)) melhor = leitura;
        if ((leitura.accuracyM ?? Infinity) <= this.opcoes.precisaoSuficienteM) fechar();
      });
      const temporizador = setTimeout(fechar, limiteMs);

      // `ligar` pode falhar por permissão; nesse caso desiste-se em vez de
      // ficar à espera de um evento que nunca vem.
      void this.ligar().catch(() => fechar());
    });
  }

  private consumir(posicao: Location.LocationObject): void {
    const leitura = leituraDePosicao(posicao);
    if (!leitura) return;
    this.ultima = leitura;
    this.ultimaEm = this.opcoes.agora();
    for (const ouvinte of this.ouvintes) ouvinte(leitura);
  }

  private converter(leitura: LeituraGnss): GeopointValue {
    const ponto: GeopointValue = {
      lat: leitura.lat,
      lon: leitura.lon,
      // O Android dá o raio de 68 % de confiança em metros. Não é a mesma
      // coisa que o desvio padrão de um GST, mas é uma medição e não uma
      // estimativa a partir do HDOP.
      accuracy_m: leitura.accuracyM!,
      fix_type: leitura.fixType,
      source: this.source,
    };
    if (leitura.alt !== undefined) ponto.alt = leitura.alt;
    if (leitura.collectedAt !== undefined) ponto.collected_at = leitura.collectedAt;
    return ponto;
  }
}

/**
 * Converte o que o Android dá numa leitura do Consul Colect.
 *
 * Uma posição sem `accuracy` é recusada: um ponto sem precisão não se pode
 * comparar com o limiar do formulário nem auditar (restrição inegociável 8).
 */
export function leituraDePosicao(posicao: Location.LocationObject): LeituraGnss | undefined {
  const c = posicao.coords;
  if (typeof c.accuracy !== 'number' || !Number.isFinite(c.accuracy) || c.accuracy <= 0) {
    return undefined;
  }
  return {
    lat: c.latitude,
    lon: c.longitude,
    alt: typeof c.altitude === 'number' ? c.altitude : undefined,
    // Um GPS de telemóvel sem correcções é `single`. O Android não diz o tipo
    // de fixo, e chamar-lhe `dgps` porque tem A-GPS seria inventar qualidade.
    fixType: 'single',
    satellites: undefined,
    hdop: undefined,
    pdop: undefined,
    accuracyM: c.accuracy,
    precisaoEstimada: false,
    correctionsAgeS: undefined,
    collectedAt: new Date(posicao.timestamp).toISOString(),
  };
}
