import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { FonteNmeaTcp, type SocketNmea } from './tcp.js';

/**
 * F7.3 — NMEA sobre TCP.
 *
 * Contra um servidor TCP a sério, e não contra um duplo: o defeito que este
 * ficheiro existe para apanhar é o de tratar cada pacote como uma linha. Um
 * duplo que entregue frases inteiras nunca o mostraria, porque é precisamente
 * o TCP que as parte ao meio.
 *
 * As frases são de um Emlid Reach, com os checksums a sério — um checksum
 * inventado faria o analisador recusar a frase e o teste passaria a provar o
 * contrário do que diz.
 */

/** Fixo RTK a 2 cm, na Baixa de Luanda. */
const GGA = '$GNGGA,093521.00,0850.29800,S,01314.06400,E,4,18,0.62,45.320,M,12.100,M,1.0,0000*4D';
const GST = '$GNGST,093521.00,0.021,0.018,0.014,32.1,0.014,0.012,0.030*7F';
const RMC = '$GNRMC,093521.00,A,0850.29800,S,01314.06400,E,0.021,,050926,,,R*6C';

let servidor: Server | undefined;
const abertos: Socket[] = [];

afterEach(async () => {
  for (const socket of abertos.splice(0)) socket.destroy();
  await new Promise<void>((resolver) => {
    if (!servidor) return resolver();
    servidor.close(() => resolver());
    servidor = undefined;
  });
});

/** Sobe um servidor que debita o que lhe mandarem e devolve o porto. */
async function servidorNmea(aoLigar: (socket: Socket) => void): Promise<number> {
  servidor = createServer((socket) => aoLigar(socket));
  await new Promise<void>((resolver) => servidor!.listen(0, '127.0.0.1', resolver));
  const endereco = servidor.address();
  if (typeof endereco === 'string' || endereco === null) throw new Error('sem porto');
  return endereco.port;
}

function abrirSocket(): (opcoes: { host: string; porto: number }) => Promise<SocketNmea> {
  return ({ host, porto }) =>
    new Promise((resolver, rejeitar) => {
      const socket = connect({ host, port: porto }, () => resolver(socket as SocketNmea));
      socket.once('error', rejeitar);
      abertos.push(socket);
    });
}

async function ate(condicao: () => boolean, msLimite = 3000): Promise<void> {
  const fim = Date.now() + msLimite;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condição não se verificou a tempo');
}

describe('F7.3 — leitura de um receptor por TCP', () => {
  it('lê um ponto RTK fixo de um receptor a sério', async () => {
    const porto = await servidorNmea((socket) => {
      socket.write(`${GGA}\r\n${GST}\r\n${RMC}\r\n`);
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();

    const ponto = await fonte.obter({ tempoMaximoMs: 3000 });

    expect(ponto.fix_type).toBe('fixed');
    expect(ponto.source).toBe('external_tcp');
    // Restrição inegociável 8: todo o ponto guardado leva precisão, tipo de
    // fixo e origem.
    expect(ponto.accuracy_m).toBeGreaterThan(0);
    expect(ponto.accuracy_m).toBeLessThan(0.1);
    expect(ponto.lat).toBeCloseTo(-8.8383, 4);
    expect(ponto.lon).toBeCloseTo(13.2344, 4);
    fonte.desligar();
  });

  it('uma frase partida entre dois pacotes não se perde', async () => {
    // É o defeito que este ficheiro existe para apanhar. O TCP entrega bytes,
    // não linhas: quem tratar cada `data` como uma frase perde umas dezenas
    // por minuto — e em silêncio, porque o checksum falha.
    const corte = 30;
    const porto = await servidorNmea((socket) => {
      socket.write(GGA.slice(0, corte));
      setTimeout(() => socket.write(`${GGA.slice(corte)}\r\n${GST}\r\n`), 30);
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();

    const ponto = await fonte.obter({ tempoMaximoMs: 3000 });
    expect(ponto.fix_type).toBe('fixed');
    // Nenhuma frase corrompida: se o `pendente` não existisse, seriam duas.
    expect(fonte.frasesCorrompidas).toBe(0);
    fonte.desligar();
  });

  it('várias frases num só pacote são todas lidas', async () => {
    const porto = await servidorNmea((socket) => {
      socket.write(`${GGA}\r\n${GST}\r\n${RMC}\r\n${GGA}\r\n`);
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    let leituras = 0;
    fonte.observar(() => leituras++);
    await fonte.ligar();

    await ate(() => leituras >= 3);
    expect(fonte.frasesCorrompidas).toBe(0);
    fonte.desligar();
  });

  it('lixo no meio não impede as frases boas de passar', async () => {
    // Um cabo mau, um baud rate errado ou outro protocolo na mesma porta.
    const porto = await servidorNmea((socket) => {
      socket.write(`ruído sem cifrão\r\n$GNGGA,dados,a,menos*00\r\n${GGA}\r\n${GST}\r\n`);
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();

    const ponto = await fonte.obter({ tempoMaximoMs: 3000 });
    expect(ponto.fix_type).toBe('fixed');
    fonte.desligar();
  });
});

describe('F7.3 — o que acontece quando corre mal', () => {
  it('uma leitura velha não passa por leitura nova', async () => {
    // O técnico move-se. Um ponto gravado onde ele já não está é pior do que
    // um ponto que não se gravou.
    let relogio = 1_000_000;
    const porto = await servidorNmea((socket) => socket.write(`${GGA}\r\n${GST}\r\n`));

    const fonte = new FonteNmeaTcp({
      host: '127.0.0.1',
      porto,
      abrir: abrirSocket(),
      silencioMaximoMs: 5_000,
      agora: () => relogio,
    });
    await fonte.ligar();
    await ate(() => fonte.estado().ultimaLeitura !== undefined);

    relogio += 60_000;
    expect(fonte.estado().ultimaLeitura).toBeUndefined();
    await expect(fonte.obter({ tempoMaximoMs: 150 })).rejects.toThrow(
      /não deu posição|sem ligação/,
    );
    fonte.desligar();
  });

  it('sem posição, recusa em vez de inventar um ponto', async () => {
    const porto = await servidorNmea(() => {
      // Servidor que aceita a ligação e nunca diz nada. É o receptor ligado
      // mas sem vista para o céu.
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();

    await expect(fonte.obter({ tempoMaximoMs: 150 })).rejects.toThrow(/não deu posição/);
    expect(fonte.estado().ligada).toBe(true);
    fonte.desligar();
  });

  it('reconecta sozinha quando a ligação cai', async () => {
    let ligacoes = 0;
    const porto = await servidorNmea((socket) => {
      ligacoes++;
      if (ligacoes === 1) {
        // O receptor reiniciou, ou o técnico afastou-se do Wi-Fi.
        socket.destroy();
        return;
      }
      socket.write(`${GGA}\r\n${GST}\r\n`);
    });

    const fonte = new FonteNmeaTcp({
      host: '127.0.0.1',
      porto,
      abrir: abrirSocket(),
      esperaInicialMs: 10,
    });
    await fonte.ligar();

    await ate(() => ligacoes >= 2);
    const ponto = await fonte.obter({ tempoMaximoMs: 3000 });
    expect(ponto.fix_type).toBe('fixed');
    fonte.desligar();
  });

  it('desligar não volta a reconectar', async () => {
    let ligacoes = 0;
    const porto = await servidorNmea((socket) => {
      ligacoes++;
      socket.destroy();
    });

    const fonte = new FonteNmeaTcp({
      host: '127.0.0.1',
      porto,
      abrir: abrirSocket(),
      esperaInicialMs: 10,
    });
    await fonte.ligar();
    await ate(() => ligacoes >= 1);
    fonte.desligar();

    const depois = ligacoes;
    await new Promise((r) => setTimeout(r, 120));
    expect(ligacoes).toBe(depois);
  });

  it('um receptor a debitar lixo sem quebras de linha não enche a memória', async () => {
    const porto = await servidorNmea((socket) => {
      socket.write('x'.repeat(20_000));
      setTimeout(() => socket.write(`\r\n${GGA}\r\n${GST}\r\n`), 30);
    });

    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();

    const ponto = await fonte.obter({ tempoMaximoMs: 3000 });
    expect(ponto.fix_type).toBe('fixed');
    fonte.desligar();
  });
});

describe('F7.7 — limiar de precisão', () => {
  it('um fixo RTK passa um limiar de 2 cm; um limiar de 1 mm não', async () => {
    const porto = await servidorNmea((socket) => socket.write(`${GGA}\r\n${GST}\r\n`));
    const fonte = new FonteNmeaTcp({ host: '127.0.0.1', porto, abrir: abrirSocket() });
    await fonte.ligar();
    await ate(() => fonte.estado().ultimaLeitura !== undefined);

    expect(fonte.avaliar(0.05)?.aceitavel).toBe(true);
    const apertado = fonte.avaliar(0.001);
    expect(apertado?.aceitavel).toBe(false);
    // Acima do limiar avisa e deixa gravar com justificação — nunca recusa.
    expect(apertado?.aviso).toContain('justificação');
    fonte.desligar();
  });
});
