import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@cvforms/db';
import type postgres from 'postgres';

/**
 * Contexto da base por pedido (F6.2).
 *
 * O RLS do Postgres só protege se a API se ligar com um papel que lhe esteja
 * sujeito e disser, a cada pedido, quem está a perguntar. Sem isto, as
 * políticas da migração 0004 existem e não valem nada — que é exactamente o
 * modo de falha que o ADR-0010 aponta como o mais perigoso, porque não dá
 * erro nenhum.
 *
 * Como funciona: cada pedido autenticado reserva uma ligação do pool, faz
 * `SET ROLE cvforms_app` e escreve o `org_id` e o `user_id` na sessão. Os
 * serviços não mudam — o `DB` e o `DB_CLIENT` que eles injectam são
 * intermediários que, dentro de um pedido, falam com essa ligação reservada, e
 * fora dele com o pool normal.
 *
 * Porquê `SET ROLE` numa ligação reservada e não uma transacção por pedido:
 * uma transacção por pedido tornaria cada leitura numa transacção aberta
 * durante todo o processamento, incluindo o tempo de rede. A ligação reservada
 * tem o mesmo efeito de isolamento sem prender uma transacção.
 */

export interface ContextoDaBase {
  sql: postgres.Sql;
  db: PostgresJsDatabase<typeof schema>;
}

const armazenamento = new AsyncLocalStorage<ContextoDaBase>();

export function contextoActual(): ContextoDaBase | undefined {
  return armazenamento.getStore();
}

export interface AbrirContextoInput {
  pool: postgres.Sql;
  papel: string;
  orgId: string;
  userId: string | undefined;
  /**
   * Modo administrativo: dispensa a atribuição por formulário, dentro da
   * própria organização. NUNCA atravessa organizações.
   */
  administracao: boolean;
}

/**
 * Corre o bloco com uma ligação reservada, no papel restrito e com o contexto
 * da sessão definido.
 *
 * Repõe sempre o estado antes de devolver a ligação ao pool. Uma ligação que
 * volte ao pool com `SET ROLE` por reverter contaminaria o pedido seguinte, e
 * o sintoma seria dados a aparecer na organização errada — o defeito exacto
 * que isto existe para impedir.
 */
export async function comContexto<T>(
  input: AbrirContextoInput,
  bloco: () => Promise<T>,
): Promise<T> {
  const ligacao = await input.pool.reserve();
  try {
    await ligacao.unsafe(`SET ROLE ${identificador(input.papel)}`);
    await ligacao`SELECT set_config('cvf.org_id', ${input.orgId}, false)`;
    await ligacao`SELECT set_config('cvf.user_id', ${input.userId ?? ''}, false)`;
    await ligacao`SELECT set_config('cvf.admin', ${input.administracao ? 'true' : 'false'}, false)`;

    // O Drizzle lê `options.parsers` e `options.serializers` do cliente, e uma
    // ligação reservada não as traz — são do pool. Sem isto o construtor
    // rebenta com «Cannot read properties of undefined (reading 'parsers')»,
    // que não aponta para nada.
    const ligacaoTipada = Object.assign(ligacao, {
      options: (input.pool as unknown as { options: unknown }).options,
    }) as unknown as postgres.Sql;

    const db = drizzle(ligacaoTipada, { schema });
    return await armazenamento.run({ sql: ligacaoTipada, db }, bloco);
  } finally {
    try {
      await ligacao.unsafe('RESET ROLE');
      await ligacao`SELECT set_config('cvf.org_id', '', false)`;
      await ligacao`SELECT set_config('cvf.user_id', '', false)`;
      await ligacao`SELECT set_config('cvf.admin', 'false', false)`;
    } catch {
      // Se nem repor se consegue, a ligação está partida. Devolvê-la ao pool
      // suja o pedido seguinte; o `release` fecha-a se ela estiver em erro.
    }
    ligacao.release();
  }
}

/**
 * O nome do papel vai para dentro de um `SET ROLE`, que não aceita parâmetros.
 * Vem do ambiente, não de um pedido — mas o dia em que passar a vir de outro
 * sítio, isto continua a não deixar passar nada.
 */
function identificador(nome: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) {
    throw new Error(`nome de papel inválido: ${nome}`);
  }
  return `"${nome}"`;
}
