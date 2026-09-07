import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';

import { DB_CLIENT } from '../db/db.module.js';
import { ENV, type Env } from '../config/env.js';
import { capturarAviso } from '../observabilidade/sentry.js';

/**
 * Vigia dos slots de replicação (F10.9, ADR-0004).
 *
 * O MODO DE FALHA QUE ISTO EXISTE PARA APANHAR. O Postgres só recicla um
 * ficheiro de WAL depois de todos os slots de replicação o terem consumido. Se
 * o PowerSync ficar em baixo — um contentor que morreu, uma migração que
 * correu mal, um fim-de-semana — o WAL acumula-se e mais nada. Não há erro,
 * não há aviso, não há lentidão. Até que o disco enche; e quando o disco
 * enche, o Postgres pára de aceitar escritas, ou seja, **deixa de receber
 * registos de campo**. É o modo de falha mais silencioso que este sistema tem.
 *
 * PORQUE É QUE UM `/health` NÃO CHEGAVA. O `/health` é olhado por um
 * balanceador que só quer saber se há-de mandar tráfego. Um slot atrasado não
 * é razão para tirar a API de serviço — tirá-la não desatrasa slot nenhum e
 * deixa os técnicos sem a única parte que ainda funcionava. Portanto o
 * `/health` continua verde, e o aviso sai por outros dois caminhos:
 *
 *   1. **O log**, com nível `error`, que é o que qualquer agregador apanha;
 *   2. **`GET /health/replicacao`**, que responde 503 quando é crítico — é aí
 *      que se aponta um monitor de disponibilidade (UptimeRobot, o healthcheck
 *      do Railway, um cron com `curl`), e é esse monitor que manda a mensagem
 *      a alguém.
 *
 * Deliberadamente não manda emails nem SMS: um sistema que manda mensagens por
 * si tem de saber a quem, com que credenciais e com que limites, e nada disso
 * é responsabilidade de uma API de formulários.
 */

export interface EstadoDoSlot {
  nome: string;
  activo: boolean;
  atraso_mb: number;
}

export interface EstadoDaReplicacao {
  ok: boolean;
  critico: boolean;
  slots: EstadoDoSlot[];
  detalhe: string | undefined;
  verificado_em: string;
}

@Injectable()
export class VigiaDeReplicacao implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VigiaDeReplicacao.name);
  private temporizador: NodeJS.Timeout | undefined;
  private ultimo: EstadoDaReplicacao | undefined;
  /** Para não repetir o mesmo aviso a cada verificação. */
  private avisados = new Set<string>();

  constructor(
    @Inject(DB_CLIENT) private readonly holder: { pool: postgres.Sql },
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.REPLICACAO_VIGIA_S <= 0) return;
    // `unref` para o temporizador não segurar o processo: uma API que não
    // fecha porque tem um intervalo pendente é uma API que fica a reiniciar
    // durante um deploy.
    this.temporizador = setInterval(() => {
      void this.verificar().catch(() => undefined);
    }, this.env.REPLICACAO_VIGIA_S * 1000);
    this.temporizador.unref?.();
  }

  onModuleDestroy(): void {
    if (this.temporizador) clearInterval(this.temporizador);
  }

  /** O último estado conhecido, sem ir à base. */
  get estado(): EstadoDaReplicacao | undefined {
    return this.ultimo;
  }

  async verificar(): Promise<EstadoDaReplicacao> {
    const linhas = await this.holder.pool<
      Array<{ slot_name: string; active: boolean; atraso_bytes: string }>
    >`
      SELECT slot_name, active,
             COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint AS atraso_bytes
      FROM pg_replication_slots
    `;

    const slots: EstadoDoSlot[] = linhas.map((l) => ({
      nome: l.slot_name,
      activo: l.active,
      atraso_mb: Math.round(Number(l.atraso_bytes) / 1_048_576),
    }));

    const aviso = slots.filter(
      (s) => !s.activo || s.atraso_mb > this.env.REPLICACAO_ATRASO_ALERTA_MB,
    );
    const criticos = slots.filter((s) => s.atraso_mb > this.env.REPLICACAO_ATRASO_CRITICO_MB);

    const estado: EstadoDaReplicacao = {
      ok: aviso.length === 0,
      critico: criticos.length > 0,
      slots,
      detalhe: aviso.length
        ? `slots a acumular WAL: ${aviso.map((s) => `${s.nome} (${s.atraso_mb} MB${s.activo ? '' : ', inactivo'})`).join(', ')}`
        : undefined,
      verificado_em: new Date().toISOString(),
    };

    this.anunciar(estado, criticos);
    this.ultimo = estado;
    return estado;
  }

  /**
   * Diz uma vez por slot, e volta a dizer quando o problema passa.
   *
   * Um aviso repetido a cada trinta segundos ensina quem o lê a ignorá-lo, e
   * um aviso que se ignora não é um aviso.
   */
  private anunciar(estado: EstadoDaReplicacao, criticos: EstadoDoSlot[]): void {
    const problemas = new Set(
      estado.slots
        .filter((s) => !s.activo || s.atraso_mb > this.env.REPLICACAO_ATRASO_ALERTA_MB)
        .map((s) => s.nome),
    );

    for (const slot of estado.slots) {
      const temProblema = problemas.has(slot.nome);
      const jaAvisado = this.avisados.has(slot.nome);

      if (temProblema && !jaAvisado) {
        this.avisados.add(slot.nome);
        const critico = criticos.some((c) => c.nome === slot.nome);
        const mensagem =
          `slot de replicação "${slot.nome}" com ${slot.atraso_mb} MB de WAL por consumir` +
          (slot.activo ? '' : ' e sem consumidor ligado') +
          '. O disco enche e o Postgres pára de aceitar escritas.';
        if (critico) this.logger.error(mensagem);
        else this.logger.warn(mensagem);
        capturarAviso(mensagem, {
          slot: slot.nome,
          atraso_mb: slot.atraso_mb,
          activo: slot.activo,
        });
      }

      if (!temProblema && jaAvisado) {
        this.avisados.delete(slot.nome);
        this.logger.log(`slot de replicação "${slot.nome}" voltou ao normal`);
      }
    }
  }
}

/** Mesma consulta, para quem só quer o número sem o serviço. */
export const CONSULTA_DOS_SLOTS = sql`SELECT slot_name FROM pg_replication_slots`;
