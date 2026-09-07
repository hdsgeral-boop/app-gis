'use client';

import { signIn } from 'next-auth/react';

export function BotaoEntrar() {
  return (
    <button className="botao" onClick={() => void signIn('keycloak', { callbackUrl: '/painel' })}>
      Entrar com o Keycloak
    </button>
  );
}
