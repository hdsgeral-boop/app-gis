import type { NextAuthOptions } from 'next-auth';
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
      }
      return token;
    },
    async session({ session, token }) {
      // O `access_token` fica só do lado do servidor. Expô-lo ao browser
      // dava a qualquer script da página uma credencial da API.
      session.expiraEm = token.accessTokenExpiresAt as number | undefined;
      return session;
    },
  },
  pages: { signIn: '/entrar' },
};

declare module 'next-auth' {
  interface Session {
    expiraEm?: number;
  }
}
