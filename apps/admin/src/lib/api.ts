import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { cookies, headers } from 'next/headers';

import { authOptions, renovar } from './auth';

/**
 * Chama a API do Consul Colect em nome do utilizador com sessão iniciada.
 *
 * Só corre no servidor: o `access_token` nunca chega ao browser. O painel é
 * um cliente da API como outro qualquer — não tem atalho para a base de dados.
 */
export async function chamarApi<T>(caminho: string, init?: RequestInit): Promise<T> {
  const resposta = await chamarApiBruto(caminho, init);
  if (!resposta.ok) {
    // A mensagem da API pode trazer detalhes; o estado é o que interessa a quem chama.
    throw new Error(`${caminho} respondeu ${resposta.status}`);
  }
  return (await resposta.json()) as T;
}

/**
 * O mesmo, mas devolve a resposta como veio.
 *
 * A ponte do construtor precisa disto: um 409 com a lista de alterações
 * incompatíveis é uma resposta útil, e transformá-la numa excepção perderia
 * exactamente a parte que o administrador tem de ler.
 */
export async function chamarApiBruto(caminho: string, init?: RequestInit): Promise<Response> {
  const base = process.env.API_URL ?? 'http://localhost:4000';
  const token = await tokenDeAcesso();
  if (!token) throw new Error('sem sessão iniciada');

  return fetch(`${base}${caminho}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    cache: 'no-store',
  });
}

/**
 * Cache dos tokens renovados aqui, em memória do processo.
 *
 * Um render de página faz duas ou três chamadas à API; sem isto, cada uma
 * pediria um token novo ao Keycloak. A chave é o refresh token, que é o que
 * identifica a sessão — nunca sai deste processo e nunca vai para log nenhum.
 */
const renovados = new Map<string, { acesso: string; expiraEm: number }>();

async function tokenDeAcesso(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const token = await getToken({
    req: {
      headers: headerStore,
      cookies: Object.fromEntries(cookieStore.getAll().map((c) => [c.name, c.value])),
    } as never,
    secret: process.env.NEXTAUTH_SECRET ?? '',
  });
  if (!token) return undefined;

  const acesso = token.accessToken as string | undefined;
  const expiraEm = token.accessTokenExpiresAt as number | undefined;
  if (acesso && expiraEm && Date.now() < expiraEm - 30_000) return acesso;

  // AQUI É QUE A RENOVAÇÃO TEM MESMO DE ACONTECER.
  //
  // O `jwt` do NextAuth renova e volta a escrever o cookie, mas só corre nas
  // rotas do próprio NextAuth — o `/api/auth/session` que o browser sonda. O
  // render de uma página do painel não passa por lá: lê o cookie tal como
  // está, com o token que já expirou, e leva um 401 da API. Era esse o defeito
  // — o painel mostrava o nome de quem entrou e todas as páginas diziam
  // «respondeu 401» ao fim de um quarto de hora.
  //
  // Um Server Component não pode escrever cookies, por isso o resultado não se
  // persiste: fica no cache acima até expirar. O realm tem
  // `revokeRefreshToken` a falso, ou seja, o refresh token continua a servir
  // enquanto a sessão do Keycloak durar; se alguém o ligar, é preciso passar a
  // renovar em middleware, que é onde há resposta onde pôr o cookie.
  const refresh = token.refreshToken as string | undefined;
  if (!refresh) return acesso;

  const guardado = renovados.get(refresh);
  if (guardado && Date.now() < guardado.expiraEm - 30_000) return guardado.acesso;

  const renovado = await renovar(token);
  const novoAcesso = renovado.accessToken;
  if (renovado.erro || !novoAcesso) return acesso;

  // Um limite qualquer, só para isto não crescer sem fim num processo de longa
  // duração. As entradas velhas são substituídas na renovação seguinte.
  if (renovados.size > 500) renovados.clear();
  renovados.set(refresh, {
    acesso: novoAcesso,
    expiraEm: renovado.accessTokenExpiresAt ?? Date.now() + 60_000,
  });
  return novoAcesso;
}

export async function sessaoActual() {
  return getServerSession(authOptions);
}
