import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module.js';
import { ENV, type Env } from '../config/env.js';
import { Publico } from '../auth/public.decorator.js';
import { VigiaDeReplicacao } from './vigia-replicacao.service.js';

interface EstadoDependencia {
  ok: boolean;
  latencia_ms?: number;
  detalhe?: string;
}

/**
 * `/health` é público de propósito: é o que o Railway, o compose e o balanceador
 * chamam, e nenhum deles tem token.
 *
 * Não expõe versões nem strings de ligação — um endpoint de saúde aberto que
 * conta a versão do Postgres é reconhecimento gratuito para quem estiver a
 * espreitar.
 *
 * O que se verifica aqui é o que, ao falhar, faz perder trabalho de campo:
 * sem MinIO as fotografias não sobem, e sem PowerSync os telefones não
 * sincronizam. Nenhum dos dois dá erro na API — dá erro no telefone de alguém
 * que está a 200 km daqui.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly vigia: VigiaDeReplicacao,
  ) {}

  @Publico()
  @Get()
  async health() {
    const [postgres, postgis, armazenamento, powersync, replicacao] = await Promise.all([
      this.verificarPostgres(),
      this.verificarPostgis(),
      this.verificarArmazenamento(),
      this.verificarPowerSync(),
      this.verificarReplicacao(),
    ]);

    // A replicação NÃO conta para o estado geral: um slot atrasado é um aviso
    // que alguém tem de ver, e não uma razão para o balanceador tirar a API de
    // serviço. Tirá-la de serviço não desatrasa slot nenhum, e deixa os
    // técnicos sem API — que é a única parte que ainda funcionava.
    const ok = postgres.ok && postgis.ok && armazenamento.ok && powersync.ok;
    return {
      status: ok ? 'ok' : 'degradado',
      at: new Date().toISOString(),
      dependencias: { postgres, postgis, armazenamento, powersync },
      replicacao,
    };
  }

  /** Vivacidade pura: responde mesmo com a base em baixo, para não ser reiniciado à toa. */
  @Publico()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * F10.9 — o alerta.
   *
   * Endpoint separado, e com um código de estado que muda, porque é assim que
   * um monitor de disponibilidade dispara: aponta-se-lhe o UptimeRobot, o
   * healthcheck do Railway ou um `curl` no cron, e é esse monitor que manda a
   * mensagem a alguém. Uma API de formulários não tem que saber mandar emails.
   *
   * 200 quando está tudo bem ou o atraso é só um aviso; **503 quando é
   * crítico**, que é quando ainda dá tempo de agir antes de o disco encher e o
   * Postgres parar de aceitar registos de campo.
   */
  @Publico()
  @Get('replicacao')
  async replicacao(@Res({ passthrough: true }) resposta: FastifyReply) {
    try {
      const estado = await this.vigia.verificar();
      if (estado.critico) resposta.status(503);
      return estado;
    } catch (error) {
      resposta.status(503);
      return { ok: false, critico: true, slots: [], detalhe: nomeDoErro(error) };
    }
  }

  private async verificarPostgres(): Promise<EstadoDependencia> {
    const inicio = Date.now();
    try {
      await this.db.execute(sql`SELECT 1`);
      return { ok: true, latencia_ms: Date.now() - inicio };
    } catch (error) {
      return { ok: false, detalhe: nomeDoErro(error) };
    }
  }

  private async verificarPostgis(): Promise<EstadoDependencia> {
    try {
      // Sem PostGIS não há `records.geom`, e a app não pode gravar um ponto.
      // Vale a pena saber isso no /health e não no primeiro registo de campo.
      const rows = await this.db.execute<{ existe: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS existe`,
      );
      const existe = Boolean((rows as unknown as { existe: boolean }[])[0]?.existe);
      return existe ? { ok: true } : { ok: false, detalhe: 'extensão postgis em falta' };
    } catch (error) {
      return { ok: false, detalhe: nomeDoErro(error) };
    }
  }

  /**
   * O balde existe e responde.
   *
   * Um `HEAD` ao balde, e não um upload de prova: o que interessa saber é se o
   * serviço está de pé e se as credenciais valem. Um 403 é uma resposta tão
   * boa como um 200 — significa que há alguém do outro lado.
   */
  private async verificarArmazenamento(): Promise<EstadoDependencia> {
    const inicio = Date.now();
    try {
      const resposta = await comTempoLimite(
        `${this.env.S3_ENDPOINT.replace(/\/$/, '')}/${this.env.S3_BUCKET}`,
        'HEAD',
      );
      return resposta.ok || resposta.status === 403
        ? { ok: true, latencia_ms: Date.now() - inicio }
        : { ok: false, detalhe: `http ${resposta.status}` };
    } catch (error) {
      return { ok: false, detalhe: nomeDoErro(error) };
    }
  }

  private async verificarPowerSync(): Promise<EstadoDependencia> {
    if (!this.env.POWERSYNC_URL) {
      // Sem URL configurado não se inventa uma falha: em desenvolvimento é
      // normal correr a API sem o serviço de sincronização em cima.
      return { ok: true, detalhe: 'não configurado' };
    }
    const inicio = Date.now();
    try {
      const resposta = await comTempoLimite(
        `${this.env.POWERSYNC_URL.replace(/\/$/, '')}/probes/liveness`,
        'GET',
      );
      return resposta.ok
        ? { ok: true, latencia_ms: Date.now() - inicio }
        : { ok: false, detalhe: `http ${resposta.status}` };
    } catch (error) {
      return { ok: false, detalhe: nomeDoErro(error) };
    }
  }

  /**
   * F10.9 — um slot de replicação parado enche o disco (ADR-0004).
   *
   * O WAL só é reciclado depois de todos os slots o terem consumido. Um
   * PowerSync em baixo durante um fim-de-semana deixa o Postgres a acumular
   * WAL até o disco acabar, e quando o disco acaba a base pára de aceitar
   * escritas — ou seja, deixa de receber registos de campo. É o modo de falha
   * mais silencioso que este sistema tem: nada dá erro até dar tudo.
   */
  private async verificarReplicacao(): Promise<EstadoDependencia & { slots?: unknown[] }> {
    // A consulta vive no vigia, num sítio só: duas cópias da mesma regra de
    // limiar divergiriam, e o `/health` passaria a dizer uma coisa e o alerta
    // outra.
    try {
      const estado = await this.vigia.verificar();
      return {
        ok: estado.ok,
        slots: estado.slots,
        ...(estado.detalhe ? { detalhe: estado.detalhe } : {}),
      };
    } catch (error) {
      return { ok: false, detalhe: nomeDoErro(error) };
    }
  }
}

/**
 * Um `fetch` que não fica pendurado.
 *
 * Sem tempo limite, um MinIO que aceita a ligação TCP e nunca responde deixa
 * o `/health` a pendurar, e um `/health` pendurado é lido pelo balanceador
 * como «morto» — a dependência em baixo derruba a API que ainda funcionava.
 */
async function comTempoLimite(url: string, metodo: 'GET' | 'HEAD', msLimite = 2000) {
  const cancelar = AbortSignal.timeout(msLimite);
  return fetch(url, { method: metodo, signal: cancelar });
}

/** Nunca devolver a mensagem crua: pode trazer o URL da base com senha dentro. */
function nomeDoErro(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'erro desconhecido';
}
