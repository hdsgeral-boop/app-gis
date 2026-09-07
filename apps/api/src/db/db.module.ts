import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { createDatabase, type Database } from '@cvforms/db';
import type postgres from 'postgres';

import { ENV, type Env } from '../config/env.js';
import { contextoActual } from './contexto.js';

export const DB = Symbol('CVFORMS_DB');
export const DB_CLIENT = Symbol('CVFORMS_DB_CLIENT');
export type Db = Database;

/**
 * Duas formas de falar com a base, e a diferença importa:
 *
 * - `DB` e `client` são o caminho normal. Dentro de um pedido autenticado
 *   correm com o papel restrito e o contexto da sessão definido, e portanto
 *   sujeitos ao RLS (F6.2). É por aqui que passa tudo o que lê ou escreve
 *   dados de campo.
 * - `pool` é a ligação do dono das tabelas, sem RLS. Serve o que é
 *   administração da própria base e não pertence a nenhuma organização: criar
 *   e apagar as vistas do PostGIS ao publicar, e as verificações de saúde.
 *
 * Separá-las é deliberado. Se tudo passasse pelo `pool`, o RLS existia e não
 * valia nada; se tudo passasse pelo papel restrito, publicar um formulário
 * exigiria dar-lhe permissões de DDL sobre o esquema todo.
 */
export interface ClienteDaBase {
  /** Sujeito ao RLS dentro de um pedido. */
  client: postgres.Sql;
  /** Dono das tabelas. Só para DDL das vistas e para o /health. */
  pool: postgres.Sql;
}

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ENV],
      useFactory: (env: Env): ClienteDaBase & { db: Database } => {
        const { db, client } = createDatabase({
          url: env.DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          ssl: env.DATABASE_SSL,
        });

        // Encaminha para a ligação do pedido quando há uma. É um intermediário
        // e não uma cópia: os serviços continuam a injectar o mesmo símbolo e
        // não sabem que isto existe.
        const clientePorPedido = new Proxy(client, {
          apply(alvo, esteObjecto, argumentos: unknown[]) {
            const actual = contextoActual()?.sql ?? alvo;
            return Reflect.apply(actual as never, esteObjecto, argumentos);
          },
          get(alvo, propriedade, receptor) {
            const actual = contextoActual()?.sql;
            if (actual && propriedade in actual) {
              const valor = Reflect.get(actual, propriedade, actual) as unknown;
              return typeof valor === 'function' ? valor.bind(actual) : valor;
            }
            return Reflect.get(alvo, propriedade, receptor);
          },
        }) as postgres.Sql;

        const dbPorPedido = new Proxy(db, {
          get(alvo, propriedade, receptor) {
            const actual = contextoActual()?.db;
            if (actual) {
              const valor = Reflect.get(actual, propriedade, actual) as unknown;
              return typeof valor === 'function' ? valor.bind(actual) : valor;
            }
            return Reflect.get(alvo, propriedade, receptor);
          },
        }) as Database;

        return { db: dbPorPedido, client: clientePorPedido, pool: client };
      },
    },
    {
      provide: DB,
      inject: [DB_CLIENT],
      useFactory: (holder: { db: Database }) => holder.db,
    },
  ],
  exports: [DB, DB_CLIENT],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CLIENT) private readonly holder: ClienteDaBase) {}

  async onApplicationShutdown(): Promise<void> {
    await this.holder.pool.end();
  }
}
