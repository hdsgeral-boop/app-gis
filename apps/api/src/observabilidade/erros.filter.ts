import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { capturarErro } from './sentry.js';

/**
 * Apanha o que ninguém apanhou (F10.6).
 *
 * O QUE RELATA E O QUE NÃO RELATA. Um 400, um 403 ou um 404 são o sistema a
 * funcionar: alguém pediu uma coisa a que não tem direito, ou mandou um corpo
 * inválido. Relatar isso enche o painel de erros de ruído, e um painel de
 * erros com ruído deixa de ser lido. O que sobe é o 5xx — o que nós fizemos
 * mal.
 *
 * O QUE VAI NO RELATO. A rota, o método, o identificador do pedido e a
 * organização. **Nunca o corpo**: o corpo de um `POST /records` é uma resposta
 * de campo, e a restrição inegociável 9 não abre excepção para telemetria.
 *
 * O QUE VOLTA PARA QUEM PEDIU. Uma mensagem genérica e o `request_id`. A
 * mensagem crua de um erro do Postgres traz nomes de colunas, e às vezes traz
 * o URL da base com a senha lá dentro.
 */
@Catch()
export class ErrosFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erros');

  catch(excepcao: unknown, host: ArgumentsHost): void {
    const contexto = host.switchToHttp();
    const resposta = contexto.getResponse<FastifyReply>();
    const pedido = contexto.getRequest<FastifyRequest & { principal?: { orgId?: string } }>();

    const estado = excepcao instanceof HttpException ? excepcao.getStatus() : 500;

    if (estado < 500) {
      // Deixa passar tal e qual: a mensagem de um 400 é para quem chamou ler,
      // e muitas delas são úteis (a lista de campos inválidos, por exemplo).
      const corpo =
        excepcao instanceof HttpException ? excepcao.getResponse() : { message: 'pedido inválido' };
      void resposta.status(estado).send(corpo);
      return;
    }

    const requestId = (pedido as { id?: string }).id;
    this.logger.error(
      `${pedido.method} ${pedido.url} → 500`,
      excepcao instanceof Error ? excepcao.stack : String(excepcao),
    );
    capturarErro(excepcao, {
      metodo: pedido.method,
      rota: pedido.url,
      request_id: requestId,
      org_id: pedido.principal?.orgId,
    });

    void resposta.status(500).send({
      statusCode: 500,
      message: 'erro interno; o pedido foi registado',
      request_id: requestId,
    });
  }
}
