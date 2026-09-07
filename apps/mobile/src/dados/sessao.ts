import type { BaseLocal } from '@/forms/definicoes';

/**
 * A sessão, guardada localmente.
 *
 * Um registo gravado sem rede tem de saber a que organização e a que
 * utilizador pertence — adivinhar isso é o caminho mais curto para dados de
 * campo aparecerem na organização errada. Os tokens NÃO vivem aqui: esses
 * ficam no SecureStore (ver lib/auth.ts).
 */
export interface Sessao {
  orgId: string;
  userId?: string;
  username?: string;
}

export async function guardarSessao(db: BaseLocal, sessao: Sessao): Promise<void> {
  const pares: Array<[string, string | undefined]> = [
    ['org_id', sessao.orgId],
    ['user_id', sessao.userId],
    ['username', sessao.username],
  ];
  for (const [chave, valor] of pares) {
    if (valor === undefined) continue;
    await db.runAsync(
      `INSERT INTO sessao (chave, valor) VALUES (?, ?)
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [chave, valor],
    );
  }
}

export async function lerSessao(db: BaseLocal): Promise<Sessao | undefined> {
  const linhas = await db.getAllAsync<{ chave: string; valor: string }>(
    `SELECT chave, valor FROM sessao`,
    [],
  );
  const mapa = new Map(linhas.map((l) => [l.chave, l.valor]));
  const orgId = mapa.get('org_id');
  if (!orgId) return undefined;
  const sessao: Sessao = { orgId };
  const userId = mapa.get('user_id');
  if (userId) sessao.userId = userId;
  const username = mapa.get('username');
  if (username) sessao.username = username;
  return sessao;
}
