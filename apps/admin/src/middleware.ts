import { withAuth } from 'next-auth/middleware';

/**
 * Tudo o que estiver debaixo de /painel exige sessão.
 *
 * O mesmo princípio da API: fechado por omissão. Uma página nova dentro de
 * /painel fica protegida sem ninguém se lembrar de a proteger.
 */
export default withAuth({ pages: { signIn: '/entrar' } });

export const config = { matcher: ['/painel/:path*'] };
