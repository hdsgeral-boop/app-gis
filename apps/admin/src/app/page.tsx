import { redirect } from 'next/navigation';

import { sessaoActual } from '@/lib/api';

export default async function Inicio() {
  const sessao = await sessaoActual();
  redirect(sessao ? '/painel' : '/entrar');
}
