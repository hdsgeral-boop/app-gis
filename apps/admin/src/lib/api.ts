import { getServerSession } from 'next-auth';
import { getToken } from 'next-auth/jwt';
import { cookies, headers } from 'next/headers';

import { authOptions } from './auth';

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
  return token?.accessToken as string | undefined;
}

export async function sessaoActual() {
  return getServerSession(authOptions);
}
