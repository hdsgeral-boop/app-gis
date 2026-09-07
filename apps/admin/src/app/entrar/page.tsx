import Image from 'next/image';
import { redirect } from 'next/navigation';

import { sessaoActual } from '@/lib/api';
import { BotaoEntrar } from './botao';

/**
 * Entrada no painel.
 *
 * O FUNDO ANIMADO é CSS puro — três manchas com as cores do logótipo a
 * deslizar em ciclo infinito. Nada de vídeo nem de canvas: o compositor do
 * browser trata disto na GPU e não gasta CPU. Num portátil de escritório é a
 * diferença entre uma página bonita e uma ventoinha a trabalhar, e quem entra
 * aqui de manhã entra todos os dias.
 *
 * O movimento pára sozinho em quem tenha «reduzir movimento» ligado no
 * sistema. Ver o `prefers-reduced-motion` no `globals.css`.
 */
export default async function Entrar() {
  if (await sessaoActual()) redirect('/painel');

  return (
    <div className="entrada">
      {/* `aria-hidden`: é decoração e não tem que ser lido por ninguém. */}
      <div className="entrada-fundo" aria-hidden>
        <span />
        <span />
        <span />
      </div>

      <div className="entrada-cartao">
        <Image src="/logotipo.png" alt="Consul Colect" width={72} height={72} priority />
        <h1>Consul Colect</h1>
        <p className="suave">Recolha de dados georreferenciados no terreno.</p>

        <BotaoEntrar />

        <p className="entrada-nota">
          A autenticação é feita pelo Keycloak. O painel não guarda senhas nem as vê passar.
        </p>
      </div>
    </div>
  );
}
