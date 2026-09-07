import {
  LeitorNmea,
  avaliarPrecisao,
  eErro,
  pontoDeLeitura,
  type EstadoDaFonte,
  type FonteDeLocalizacao,
  type GeopointValue,
  type LeituraGnss,
} from '@cvforms/form-core';

/**
 * Receptor GNSS externo por NMEA sobre TCP (F7.3).
 *
 * É como se liga um Emlid Reach, um Trimble ou um Leica que anuncie um servidor
 * NMEA na rede: o receptor faz Wi-Fi, o telefone liga-se-lhe, e as frases
 * chegam a 1 Hz ou mais.
 *
 * O socket entra por injecção. Em produção é o `react-native-tcp-socket`, que
 * é um módulo nativo e obriga a um dev build; nos testes é um `net.Socket` do
 * Node contra um servidor a sério. A alternativa — importar o módulo nativo
 * aqui — tornaria isto impossível de testar sem um telefone, e a parte que
 * mais facilmente se estraga é precisamente a que se pode testar sem ele.
 *
 * O QUE ESTA CLASSE EXISTE PARA RESOLVER, e que um `socket.on('data')` ingénuo
 * faz mal:
 *
 * 1. **O TCP não entrega linhas, entrega bytes.** Uma frase NMEA chega
 *    partida ao meio entre dois pacotes umas dezenas de vezes por minuto. Quem
 *    tratar cada `data` como uma linha perde essas frases — e como o checksum
 *    falha, perde-as em silêncio.
 * 2. **A ligação cai.** O técnico afasta-se do receptor, o Wi-Fi oscila, o
 *    receptor reinicia. Reconectar com espera crescente é a diferença entre um
 *    corte de dez segundos e uma manhã sem pontos.
 * 3. **Um receptor mudo não é um receptor ligado.** Se as frases pararem, o
 *    estado tem de o dizer; senão o ecrã mostra a última posição para sempre e
 *    o técnico grava um ponto onde já não está.
 */

/** O mínimo de um socket TCP. Assinado assim para o `net` e o RN servirem os dois. */
export interface SocketNmea {
  on(evento: 'data', ouvinte: (dados: Uint8Array | string) => void): void;
  on(evento: 'error', ouvinte: (erro: Error) => void): void;
  on(evento: 'close', ouvinte: () => void): void;
  destroy(): void;
}

export interface AbrirSocket {
  (opcoes: { host: string; porto: number }): Promise<SocketNmea>;
}

export interface OpcoesTcp {
  host: string;
  porto: number;
  abrir: AbrirSocket;
  /** Nome legível para o ecrã. */
  descricao?: string;
  /** Depois de quanto tempo sem frases é que a leitura deixa de valer. */
  silencioMaximoMs?: number;
  /** Espera inicial antes de reconectar; duplica até ao tecto. */
  esperaInicialMs?: number;
  esperaMaximaMs?: number;
  /**
   * Quanto tempo esperar por uma leitura com precisão MEDIDA (`GST`) quando a
   * que se tem é estimada do HDOP. Ver `obter`.
   */
  esperaPelaMedidaMs?: number;
  /** Injectável para os testes não terem de esperar a sério. */
  agendar?: (accao: () => void, ms: number) => void;
  agora?: () => number;
}

export class FonteNmeaTcp implements FonteDeLocalizacao {
  readonly source = 'external_tcp' as const;
  readonly descricao: string;

  private readonly leitor = new LeitorNmea();
  private readonly opcoes: Required<Omit<OpcoesTcp, 'descricao'>>;
  private socket: SocketNmea | undefined;
  private ligada = false;
  private encerrada = false;
  /** Resto de uma frase que chegou partida entre dois pacotes. */
  private pendente = '';
  private ultima: LeituraGnss | undefined;
  /** `true` assim que este receptor der uma precisão medida (frase `GST`). */
  private viuMedida = false;
  private leituras = 0;
  private ultimaEm: number | undefined;
  private espera: number;
  private readonly ouvintes = new Set<(leitura: LeituraGnss) => void>();

  constructor(opcoes: OpcoesTcp) {
    this.descricao = opcoes.descricao ?? `Receptor NMEA (${opcoes.host}:${opcoes.porto})`;
    this.opcoes = {
      host: opcoes.host,
      porto: opcoes.porto,
      abrir: opcoes.abrir,
      silencioMaximoMs: opcoes.silencioMaximoMs ?? 10_000,
      esperaPelaMedidaMs: opcoes.esperaPelaMedidaMs ?? 1_500,
      esperaInicialMs: opcoes.esperaInicialMs ?? 1_000,
      esperaMaximaMs: opcoes.esperaMaximaMs ?? 30_000,
      agendar: opcoes.agendar ?? ((accao, ms) => void setTimeout(accao, ms)),
      agora: opcoes.agora ?? (() => Date.now()),
    };
    this.espera = this.opcoes.esperaInicialMs;
  }

  async ligar(): Promise<void> {
    this.encerrada = false;
    await this.abrir();
  }

  desligar(): void {
    this.encerrada = true;
    this.ligada = false;
    this.socket?.destroy();
    this.socket = undefined;
  }

  estado(): EstadoDaFonte {
    return {
      ligada: this.ligada,
      descricao: this.descricao,
      ultimaLeitura: this.leituraFresca(),
      ultimaLeituraEm: this.ultimaEm ? new Date(this.ultimaEm).toISOString() : undefined,
    };
  }

  observar(aoLer: (leitura: LeituraGnss) => void): () => void {
    this.ouvintes.add(aoLer);
    return () => this.ouvintes.delete(aoLer);
  }

  /**
   * Uma leitura, ou erro. NUNCA inventa um ponto (restrição inegociável 8).
   *
   * Espera por uma frase nova em vez de devolver a última que tem: entre uma
   * posição de há trinta segundos e um erro, o erro é melhor — o técnico
   * move-se, e um ponto gravado onde ele já não está é pior do que um ponto
   * que não se gravou.
   */
  async obter(opcoes: { tempoMaximoMs?: number } = {}): Promise<GeopointValue> {
    const limite = opcoes.tempoMaximoMs ?? 15_000;
    const primeira = this.leituraFresca() ?? (await this.proximaLeitura(limite));
    if (!primeira) {
      throw new Error(
        this.ligada
          ? `o receptor está ligado mas não deu posição em ${Math.round(limite / 1000)} s: pode estar sem vista para o céu`
          : 'sem ligação ao receptor',
      );
    }

    // A GGA chega antes da GST, e uma leitura só com GGA tem a precisão
    // ESTIMADA do HDOP. Devolvê-la de imediato faria um receptor RTK que dá
    // 2 cm medidos gravar 1,5 m estimados — e é a precisão que decide se o
    // ponto passa o limiar do formulário, ou seja, gravava-se um aviso falso
    // e um valor falso. Espera-se um pouco pela medida.
    //
    // A espera só existe enquanto houver razão para crer que este receptor dá
    // GST: um que nunca a deu não pode custar um segundo e meio a cada ponto.
    // A GST costuma vir no mesmo pacote que a GGA, e é processada logo a
    // seguir. Quando isso acontece, a leitura medida já está aqui antes de
    // esta linha correr — e esperar por outra seria esperar por nada.
    const jaMedida = this.leituraFresca();
    if (jaMedida && !jaMedida.precisaoEstimada) return this.converter(jaMedida);

    if (primeira.precisaoEstimada && (this.viuMedida || this.leituras <= 4)) {
      const medida = await this.proximaLeitura(
        Math.min(this.opcoes.esperaPelaMedidaMs, limite),
        (leitura) => !leitura.precisaoEstimada,
      );
      if (medida) return this.converter(medida);
    }

    return this.converter(primeira);
  }

  /** Precisão da última leitura contra o limiar do formulário. */
  avaliar(limiarM: number | undefined) {
    const leitura = this.leituraFresca();
    if (!leitura?.accuracyM) return undefined;
    const ponto = pontoDeLeitura(leitura, this.source);
    if (eErro(ponto)) return undefined;
    return avaliarPrecisao(ponto, limiarM, leitura.precisaoEstimada);
  }

  get frasesCorrompidas(): number {
    return this.leitor.frasesCorrompidas;
  }

  // ── Interno ──────────────────────────────────────────────────────────────

  private converter(leitura: LeituraGnss): GeopointValue {
    const ponto = pontoDeLeitura(leitura, this.source);
    if (eErro(ponto)) throw new Error(ponto.erro);
    return ponto;
  }

  private leituraFresca(): LeituraGnss | undefined {
    if (!this.ultima || this.ultimaEm === undefined) return undefined;
    return this.opcoes.agora() - this.ultimaEm <= this.opcoes.silencioMaximoMs
      ? this.ultima
      : undefined;
  }

  private proximaLeitura(
    limiteMs: number,
    serve: (leitura: LeituraGnss) => boolean = () => true,
  ): Promise<LeituraGnss | undefined> {
    return new Promise((resolver) => {
      let terminado = false;
      const cancelar = this.observar((leitura) => {
        if (terminado || !serve(leitura)) return;
        terminado = true;
        cancelar();
        resolver(leitura);
      });
      this.opcoes.agendar(() => {
        if (terminado) return;
        terminado = true;
        cancelar();
        resolver(undefined);
      }, limiteMs);
    });
  }

  private async abrir(): Promise<void> {
    if (this.encerrada) return;
    try {
      const socket = await this.opcoes.abrir({
        host: this.opcoes.host,
        porto: this.opcoes.porto,
      });
      this.socket = socket;
      this.ligada = true;
      // Uma ligação que pegou repõe a espera: um corte agora não deve herdar
      // o castigo de um corte de há uma hora.
      this.espera = this.opcoes.esperaInicialMs;

      socket.on('data', (dados) => this.consumir(dados));
      socket.on('error', () => this.cair());
      socket.on('close', () => this.cair());
    } catch {
      this.cair();
    }
  }

  private cair(): void {
    if (!this.ligada && this.socket === undefined) return;
    this.ligada = false;
    this.socket = undefined;
    // O resto de uma frase partida não sobrevive a uma reconexão: juntá-lo ao
    // primeiro pacote da ligação seguinte produziria uma frase inventada.
    this.pendente = '';
    if (this.encerrada) return;

    const espera = this.espera;
    this.espera = Math.min(this.espera * 2, this.opcoes.esperaMaximaMs);
    this.opcoes.agendar(() => void this.abrir(), espera);
  }

  /**
   * Junta os bytes que chegaram ao resto do que ficou, e só processa linhas
   * completas.
   *
   * O `pendente` é o que separa isto de perder frases: um pacote pode acabar a
   * meio de um `$GNGGA` e o resto vir no seguinte.
   */
  private consumir(dados: Uint8Array | string): void {
    const texto =
      typeof dados === 'string' ? dados : new TextDecoder('utf-8', { fatal: false }).decode(dados);
    this.pendente += texto;

    const linhas = this.pendente.split(/\r?\n/);
    // A última é o que sobra: ou está vazia (o pacote acabou numa quebra) ou é
    // meia frase à espera do resto.
    this.pendente = linhas.pop() ?? '';

    // Um receptor a debitar lixo não pode encher a memória do telefone: se o
    // «resto» crescer sem quebra de linha nenhuma, não é uma frase NMEA.
    if (this.pendente.length > 4096) this.pendente = '';

    for (const linha of linhas) {
      if (!linha.trim()) continue;
      const leitura = this.leitor.consumir(linha);
      if (!leitura) continue;
      this.ultima = leitura;
      this.ultimaEm = this.opcoes.agora();
      this.leituras++;
      if (!leitura.precisaoEstimada) this.viuMedida = true;
      for (const ouvinte of this.ouvintes) ouvinte(leitura);
    }
  }
}
