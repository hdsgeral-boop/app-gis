import { createHmac, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../config/env.js';

/**
 * URLs pré-assinados para o armazenamento de objectos (F9.3).
 *
 * O ficheiro NÃO passa pela API. Um telefone a enviar uma fotografia de 2 MB
 * por uma rede de campo demora minutos, e ter a API a segurar essa ligação
 * durante minutos por cada foto de cada técnico é a forma mais rápida de a
 * deitar abaixo. O telefone fala directamente com o armazenamento, e a API só
 * assina a autorização.
 *
 * A assinatura é AWS SigV4 escrita à mão. Podia ser o `@aws-sdk/s3-request-
 * presigner`, mas isso são ~3 MB de dependências para produzir uma string —
 * e é uma string cuja especificação não muda desde 2012.
 */

/**
 * Em que balde é que o objecto está.
 *
 * Os mosaicos de mapa vivem num balde separado dos anexos: são poucos
 * ficheiros grandes e partilhados por toda a organização, e os anexos são
 * muitos, pequenos e privados de cada registo. Regras de retenção e de
 * limpeza diferentes pedem baldes diferentes.
 */
export interface OpcoesDeBalde {
  balde?: string;
}

export interface UrlAssinado {
  url: string;
  metodo: 'PUT' | 'GET';
  /** Instante em que deixa de valer. */
  expiraEm: string;
  /** Cabeçalhos que o cliente TEM de enviar, senão a assinatura não bate. */
  cabecalhos: Record<string, string>;
}

@Injectable()
export class ArmazenamentoService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * Chave do objecto.
   *
   * Deriva do hash do conteúdo, e não do `id` do anexo: dois técnicos que
   * fotografem a mesma chapa produzem o mesmo ficheiro, e não vale a pena
   * guardá-lo duas vezes nem enviá-lo duas vezes (F9.6).
   *
   * A organização vai no caminho para o dia em que for preciso apagar tudo o
   * que é de um cliente, ou mover um cliente para outro balde.
   */
  chave(orgId: string, hash: string, extensao: string): string {
    const limpo = hash.replace(/[^a-f0-9]/gi, '').toLowerCase();
    // Dois níveis de prefixo: um balde com um milhão de objectos numa só
    // pasta é lento de listar em qualquer implementação de S3.
    return `${orgId}/${limpo.slice(0, 2)}/${limpo.slice(2, 4)}/${limpo}${extensao}`;
  }

  paraEnviar(
    chave: string,
    mimeType: string,
    expiraEmS = 900,
    opcoes: OpcoesDeBalde = {},
  ): UrlAssinado {
    return this.assinar('PUT', chave, expiraEmS, { 'content-type': mimeType }, opcoes);
  }

  paraDescarregar(chave: string, expiraEmS = 900, opcoes: OpcoesDeBalde = {}): UrlAssinado {
    return this.assinar('GET', chave, expiraEmS, {}, opcoes);
  }

  /**
   * AWS SigV4 com a assinatura na query string.
   *
   * Só o que é preciso para um `PUT` e um `GET` de um objecto. Não trata de
   * multipart nem de listagens — quando fizerem falta, é altura de trazer o
   * SDK e não de continuar a escrever isto à mão.
   */
  private assinar(
    metodo: 'PUT' | 'GET',
    chave: string,
    expiraEmS: number,
    cabecalhosExtra: Record<string, string>,
    opcoes: OpcoesDeBalde = {},
  ): UrlAssinado {
    const balde = opcoes.balde || this.env.S3_BUCKET;
    // O `host` entra na assinatura. Tem de ser aquele por onde o telefone vai
    // pedir, e não aquele por onde a API fala com o armazenamento.
    const endpoint = new URL(this.env.S3_PUBLIC_ENDPOINT || this.env.S3_ENDPOINT);
    const caminho = this.env.S3_FORCE_PATH_STYLE ? `/${balde}/${chave}` : `/${chave}`;
    const anfitriao = this.env.S3_FORCE_PATH_STYLE ? endpoint.host : `${balde}.${endpoint.host}`;

    const agora = new Date();
    const carimbo = agora
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const dia = carimbo.slice(0, 8);
    const alcance = `${dia}/${this.env.S3_REGION}/s3/aws4_request`;

    // Os cabeçalhos assinados têm de ir por ordem alfabética, em minúsculas.
    const assinados: Record<string, string> = { host: anfitriao, ...cabecalhosExtra };
    const nomesAssinados = Object.keys(assinados).sort();
    const cabecalhosCanonicos = nomesAssinados
      .map((n) => `${n}:${assinados[n]!.trim()}\n`)
      .join('');

    const consulta = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.env.S3_ACCESS_KEY_ID}/${alcance}`,
      'X-Amz-Date': carimbo,
      'X-Amz-Expires': String(expiraEmS),
      'X-Amz-SignedHeaders': nomesAssinados.join(';'),
    });
    // O S3 exige a query ordenada e com o escape específico dele.
    const consultaCanonica = [...consulta.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${escaparS3(k)}=${escaparS3(v)}`)
      .join('&');

    const pedidoCanonico = [
      metodo,
      caminho.split('/').map(escaparS3).join('/'),
      consultaCanonica,
      cabecalhosCanonicos,
      nomesAssinados.join(';'),
      // `UNSIGNED-PAYLOAD`: o corpo não é assinado. Assiná-lo obrigaria a
      // conhecer o ficheiro inteiro no momento de assinar, e quem o tem é o
      // telefone, não a API.
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const paraAssinar = [
      'AWS4-HMAC-SHA256',
      carimbo,
      alcance,
      createHash('sha256').update(pedidoCanonico).digest('hex'),
    ].join('\n');

    const chaveData = hmac(`AWS4${this.env.S3_SECRET_ACCESS_KEY}`, dia);
    const chaveRegiao = hmac(chaveData, this.env.S3_REGION);
    const chaveServico = hmac(chaveRegiao, 's3');
    const chaveAssinatura = hmac(chaveServico, 'aws4_request');
    const assinatura = createHmac('sha256', chaveAssinatura).update(paraAssinar).digest('hex');

    return {
      url: `${endpoint.protocol}//${anfitriao}${caminho}?${consultaCanonica}&X-Amz-Signature=${assinatura}`,
      metodo,
      expiraEm: new Date(agora.getTime() + expiraEmS * 1000).toISOString(),
      cabecalhos: cabecalhosExtra,
    };
  }
}

function hmac(chave: string | Buffer, dados: string): Buffer {
  return createHmac('sha256', chave).update(dados).digest();
}

/**
 * O S3 escapa tudo excepto `A-Za-z0-9-._~`. O `encodeURIComponent` deixa
 * passar `!*'()`, e um objecto com um desses no nome falha a assinatura de uma
 * forma que ninguém liga ao nome do ficheiro.
 */
function escaparS3(valor: string): string {
  return encodeURIComponent(valor).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
