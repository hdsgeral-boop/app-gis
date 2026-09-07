import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';
import type { FastifyReply } from 'fastify';

/**
 * Um corpo de pedido mal formado é um 400, não um 500.
 *
 * Sem isto, um `parse()` do Zod que falha sobe como excepção qualquer e o Nest
 * responde «Internal server error». O cliente fica sem saber o que corrigir, e
 * quem lê os logs vai à procura de um erro do servidor que não existe.
 *
 * As mensagens do Zod vão inteiras: dizem o caminho exacto do campo errado, e
 * esconder isso não protege nada — o esquema do pedido é público na
 * ESPECIFICACAO §6.
 */
@Catch(ZodError)
export class FiltroDeErrosDeValidacao implements ExceptionFilter {
  catch(erro: ZodError, host: ArgumentsHost): void {
    const resposta = host.switchToHttp().getResponse<FastifyReply>();
    resposta.status(HttpStatus.BAD_REQUEST).send({
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'o pedido não respeita o formato esperado',
      problemas: erro.issues.map((i) => ({
        campo: i.path.join('.') || '(raiz)',
        codigo: i.code,
        mensagem: i.message,
      })),
    });
  }
}
