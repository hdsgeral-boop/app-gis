'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactElement } from 'react';

/**
 * O menu lateral do painel.
 *
 * PORQUE É QUE ISTO É UM MENU LATERAL E NÃO UMA BARRA EM CIMA. O painel tem
 * sete destinos e vai ter mais. Uma barra horizontal com sete separadores
 * numa portátil de 13 polegadas fica apertada e obriga a esconder metade num
 * «…» — e o que fica escondido deixa de ser usado. Na vertical há espaço para
 * os nomes por extenso e para os agrupar por assunto.
 *
 * OS ÍCONES SÃO FORMAS, NÃO EMOJI. Um emoji desenha-se de maneira diferente em
 * cada sistema, muda de tamanho conforme a fonte, e num painel de trabalho lê-se
 * como brincadeira. São SVG de traço, do mesmo peso, e a marca é a única coisa
 * com cor.
 *
 * FECHA-SE EM ECRÃS ESTREITOS. O painel é usado num escritório, mas às vezes é
 * usado num tablet no carro.
 */

interface Destino {
  href: string;
  rotulo: string;
  icone: ReactElement;
  descricao: string;
}

const traco = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const SECCOES: Array<{ titulo: string; destinos: Destino[] }> = [
  {
    titulo: 'Recolha',
    destinos: [
      {
        href: '/painel/projectos',
        rotulo: 'Projectos',
        descricao: 'onde vivem os formulários',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
        ),
      },
      {
        href: '/painel/formularios',
        rotulo: 'Formulários',
        descricao: 'desenhar, publicar e atribuir',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
            <path d="M9.5 8h5M9.5 12h5M9.5 16h3" />
          </svg>
        ),
      },
      {
        href: '/painel/revisao',
        rotulo: 'Por rever',
        descricao: 'conflitos e registos com problemas',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="M12 4 3 19h18L12 4Z" />
            <path d="M12 10v4M12 17h.01" />
          </svg>
        ),
      },
      {
        href: '/painel/mapas',
        rotulo: 'Mapas',
        descricao: 'mosaicos offline para a app',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="m9 4-6 2.5v13L9 17l6 3 6-2.5v-13L15 7 9 4Z" />
            <path d="M9 4v13M15 7v13" />
          </svg>
        ),
      },
    ],
  },
  {
    titulo: 'Administração',
    destinos: [
      {
        href: '/painel/pessoas',
        rotulo: 'Pessoas',
        descricao: 'papéis e equipas',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3 20a6 6 0 0 1 12 0" />
            <path d="M16 5.5a3.2 3.2 0 0 1 0 5M18 20a6 6 0 0 0-2-4.5" />
          </svg>
        ),
      },
      {
        href: '/painel/atribuicoes',
        rotulo: 'Atribuições',
        descricao: 'quem recolhe o quê, e onde',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="M4 7h9M4 12h9M4 17h6" />
            <path d="m16 14 2.5 2.5L23 12" />
          </svg>
        ),
      },
      {
        href: '/painel/exportacoes',
        rotulo: 'Exportações',
        descricao: 'CSV, GeoJSON, anexos e qualidade',
        icone: (
          <svg viewBox="0 0 24 24" width="18" height="18" {...traco}>
            <path d="M12 3v11" />
            <path d="m8 10 4 4 4-4" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        ),
      },
    ],
  },
];

export function MenuLateral({ nome, email }: { nome?: string; email?: string }) {
  const caminho = usePathname();
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <button
        type="button"
        className="menu-alternar"
        aria-label={aberto ? 'fechar menu' : 'abrir menu'}
        aria-expanded={aberto}
        onClick={() => setAberto(!aberto)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" {...traco}>
          {aberto ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>

      <nav className={`menu ${aberto ? 'menu-aberto' : ''}`} aria-label="Navegação principal">
        <Link href="/painel" className="menu-marca" onClick={() => setAberto(false)}>
          <Image src="/logotipo.png" alt="" width={34} height={34} priority />
          <span>
            <strong>Consul Colect</strong>
            <small>recolha de dados no terreno</small>
          </span>
        </Link>

        {SECCOES.map((seccao) => (
          <div key={seccao.titulo} className="menu-seccao">
            <h2>{seccao.titulo}</h2>
            <ul>
              {seccao.destinos.map((destino) => {
                // `startsWith` e não igualdade: `/painel/formularios/<id>`
                // tem de manter o separador aceso, senão quem entra num
                // formulário deixa de saber onde está.
                const activo = caminho.startsWith(destino.href);
                return (
                  <li key={destino.href}>
                    <Link
                      href={destino.href}
                      className={activo ? 'activo' : ''}
                      aria-current={activo ? 'page' : undefined}
                      onClick={() => setAberto(false)}
                    >
                      {destino.icone}
                      <span>
                        {destino.rotulo}
                        <small>{destino.descricao}</small>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <div className="menu-rodape">
          <div className="menu-utilizador">
            <span className="menu-inicial" aria-hidden>
              {(nome ?? email ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{nome ?? 'sessão iniciada'}</strong>
              <small>{email ?? ''}</small>
            </span>
          </div>
          <Link href="/api/auth/signout" className="menu-sair">
            Terminar sessão
          </Link>
        </div>
      </nav>

      {aberto ? (
        <button
          type="button"
          className="menu-fundo"
          aria-hidden
          tabIndex={-1}
          onClick={() => setAberto(false)}
        />
      ) : null}
    </>
  );
}
