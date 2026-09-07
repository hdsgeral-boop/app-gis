import TcpSocket from 'react-native-tcp-socket';

import type { AbrirSocket, SocketNmea } from './tcp';

/**
 * O socket a sério, para o `FonteNmeaTcp` (F7.3).
 *
 * Está separado do `tcp.ts` de propósito. O `react-native-tcp-socket` é um
 * módulo nativo: importá-lo dentro da classe tornaria toda a lógica de
 * enquadramento e reconexão impossível de testar sem um telefone — e é
 * precisamente essa lógica que mais facilmente se estraga. Aqui fica só a
 * ligação ao hardware, que é o que não se pode testar de outra maneira.
 */

/**
 * Abre uma ligação TCP ao receptor.
 *
 * O tempo limite é curto e é de propósito: um receptor no mesmo Wi-Fi responde
 * em milissegundos. Se demorar cinco segundos, não é lentidão — é o endereço
 * errado, ou o telefone está noutra rede. Falhar depressa deixa a reconexão
 * com espera crescente fazer o seu trabalho em vez de ficar tudo pendurado.
 */
export function abrirSocketNativo(tempoLimiteMs = 5000): AbrirSocket {
  return ({ host, porto }) =>
    new Promise<SocketNmea>((resolver, rejeitar) => {
      let decidido = false;

      const socket = TcpSocket.createConnection({ host, port: porto }, () => {
        if (decidido) return;
        decidido = true;
        clearTimeout(temporizador);
        resolver(socket as unknown as SocketNmea);
      });

      socket.on('error', (erro: Error) => {
        if (decidido) return;
        decidido = true;
        clearTimeout(temporizador);
        rejeitar(erro);
      });

      const temporizador = setTimeout(() => {
        if (decidido) return;
        decidido = true;
        socket.destroy();
        rejeitar(
          new Error(
            `sem resposta de ${host}:${porto}. Confirma que o telefone está ligado ao Wi-Fi do receptor.`,
          ),
        );
      }, tempoLimiteMs);
    });
}
