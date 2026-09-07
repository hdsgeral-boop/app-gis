import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Sessao } from './sessao';

export const metadata: Metadata = {
  // `template` põe o nome do sistema em todos os separadores sem cada página
  // ter de se lembrar dele.
  title: { default: 'Consul Colect', template: '%s · Consul Colect' },
  description: 'Recolha de dados georreferenciados no terreno',
  icons: { icon: '/favicon.png', apple: '/apple-icon.png' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt">
      <body>
        <Sessao>{children}</Sessao>
      </body>
    </html>
  );
}
