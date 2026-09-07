import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { sessaoActual } from '@/lib/api';
import { MenuLateral } from '@/componentes/MenuLateral';

/**
 * A moldura de todo o painel.
 *
 * O menu vive aqui e não em cada página: se cada página desenhasse o seu, o
 * menu piscava a cada navegação e mais cedo ou mais tarde uma página ficava
 * com um separador a menos.
 *
 * A sessão é verificada **aqui**, uma vez, para todas as páginas por baixo.
 * Cada página ter o seu `redirect` era uma verificação que alguém acabaria por
 * esquecer numa página nova — e essa página passava a ser pública sem ninguém
 * dar por isso.
 */
export default async function LayoutDoPainel({ children }: { children: ReactNode }) {
  const sessao = await sessaoActual();
  if (!sessao) redirect('/entrar');

  return (
    <div className="painel">
      <MenuLateral
        {...(sessao.user?.name ? { nome: sessao.user.name } : {})}
        {...(sessao.user?.email ? { email: sessao.user.email } : {})}
      />
      <div className="painel-conteudo">{children}</div>
    </div>
  );
}
