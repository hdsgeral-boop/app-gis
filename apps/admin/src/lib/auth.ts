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
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    // Um valor de fachada, só para a compilação atravessar. Nunca é usado:
    // qualquer pedido a sério lê o ambiente outra vez.
    return 'https://exemplo.invalido/realms/cvforms';
  }
  throw new Error('KEYCLOAK_ISSUER não está definida. Ver .env.example.');
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
