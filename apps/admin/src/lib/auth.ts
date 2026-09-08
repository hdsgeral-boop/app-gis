import type { NextAuthOptions } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import KeycloakProvider from 'next-auth/providers/keycloak';

/**
 * Sessão do painel, contra o mesmo Keycloak que a API valida.
 *
 * O painel não guarda senhas nem emite tokens próprios: o `access_token` que
 * chega aqui é o mesmo que a API verifica contra o JWKS do realm. Uma só
 * identidade em todo o sistema, e um só sítio onde a revogar.
 */
/**
 * O `issuer`, lido no momento em que é preciso.
 *
 * NÃO PODE REBENTAR AO CARREGAR O MÓDULO. O `next build` percorre as páginas
 * para recolher a configuração, e nessa altura não há ambiente nenhum — nem
 * deve haver: as variáveis de produção não entram numa imagem Docker. Um
 * `throw` no topo do ficheiro fazia a compilação falhar com «Failed to collect
 * page data», que não diz o que está errado.
 *
 * Em tempo de execução a falta continua a ser um erro, e um erro claro: é aí
 * que ela importa e é aí que alguém a pode corrigir.
 */
function emissor(): string {
  const valor = process.env.KEYCLOAK_ISSUER;
  if (valor) return valor;

  // NUNCA rebentar aqui. Este módulo é carregado pelo `next build` quando ele
  // pré-desenha as páginas de erro, e nessa altura não há ambiente nenhum —
  // nem deve haver: as variáveis de produção não entram numa imagem Docker.
  //
  // Um `throw` fazia a compilação falhar com «<Html> should not be imported
  // outside of pages/_document», que não tem nada que ver com o que se passa:
  // o Next apanha a excepção, cai na página de erro do encaminhador antigo, e
  // é ESSA que rebenta. Duas horas a olhar para o erro errado.
  //
  // Tentei antes distinguir a compilação pelo `NEXT_PHASE`, e não serve: o
  // Next não o define nos processos que pré-desenham as páginas.
  console.error(
    'KEYCLOAK_ISSUER não está definida — a autenticação não vai funcionar. Ver .env.example.',
  );
  return 'https://keycloak-nao-configurado.invalido/realms/cvforms';
}

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? 'cvforms-admin',
      // Cliente público com PKCE: não há segredo do lado do painel.
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
      issuer: emissor(),
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        // `expires_at` vem em segundos; guardamos em milissegundos para não
        // andar a converter em todo o lado.
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
        delete token.erro;
        return token;
      }

      // A SESSÃO DO PAINEL DURA MUITO MAIS DO QUE O TOKEN DE ACESSO.
      // O realm emite tokens de 15 minutos e a sessão do Keycloak dura 30
      // dias. Sem renovar aqui, ao fim de um quarto de hora o painel continua
      // a mostrar o nome de quem entrou — porque o cookie da sessão ainda é
      // válido — e TODAS as páginas passam a dizer «respondeu 401», porque o
      // token que vai para a API já expirou. Parece a API avariada e é a
      // renovação em falta.
      const expiraEm = token.accessTokenExpiresAt as number | undefined;
      // Trinta segundos de margem: um token que expira a meio do pedido dá o
      // mesmo 401 que não ter token nenhum.
      if (expiraEm && Date.now() < expiraEm - 30_000) return token;

      return renovar(token);
    },
    async session({ session, token }) {
      // O `access_token` fica só do lado do servidor. Expô-lo ao browser
      // dava a qualquer script da página uma credencial da API.
      session.expiraEm = token.accessTokenExpiresAt as number | undefined;
      session.erro = token.erro as string | undefined;
      return session;
    },
  },
  pages: { signIn: '/entrar' },
};

/**
 * Troca o `refresh_token` por um par novo, contra o mesmo realm.
 *
 * Se falhar, NÃO se deita a sessão fora aqui: marca-se o erro e deixa-se o
 * token como está. Quem chama a API vê um 401 e manda entrar de novo — e é
 * melhor do que expulsar alguém a meio de um formulário por causa de um
 * Keycloak que esteve dois segundos em baixo.
 */
export async function renovar(token: JWT): Promise<JWT> {
  const refresh = token.refreshToken as string | undefined;
  if (!refresh) return { ...token, erro: 'sem refresh token' };

  try {
    const resposta = await fetch(`${emissor()}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.KEYCLOAK_CLIENT_ID ?? 'cvforms-admin',
        ...(process.env.KEYCLOAK_CLIENT_SECRET
          ? { client_secret: process.env.KEYCLOAK_CLIENT_SECRET }
          : {}),
        refresh_token: refresh,
      }),
    });

    const corpo = (await resposta.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!resposta.ok || !corpo.access_token) {
      // Nunca registar o corpo: traz credenciais (restrição inegociável 9).
      console.error(`renovação do token recusada pelo Keycloak: ${corpo.error ?? resposta.status}`);
      return { ...token, erro: 'renovacao_recusada' };
    }

    return {
      ...token,
      accessToken: corpo.access_token,
      // O Keycloak roda o refresh token por omissão; ficar com o antigo faz a
      // renovação seguinte falhar.
      refreshToken: corpo.refresh_token ?? refresh,
      accessTokenExpiresAt: Date.now() + (corpo.expires_in ?? 300) * 1000,
      erro: undefined,
    };
  } catch (e) {
    console.error(`não foi possível falar com o Keycloak para renovar: ${(e as Error).message}`);
    return { ...token, erro: 'keycloak_inacessivel' };
  }
}

declare module 'next-auth' {
  interface Session {
    expiraEm?: number;
    erro?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number;
    erro?: string;
  }
}
