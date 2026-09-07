'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface Utilizador {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  active: boolean;
  last_seen_at: string | null;
  papeis: Array<{ id: string; key: string; name: string }>;
  equipas: Array<{ id: string; key: string; name: string }>;
  formularios: number;
}

export interface Papel {
  id: string;
  key: string;
  name: string;
  sistema: boolean;
}

export interface Equipa {
  id: string;
  key: string;
  name: string;
  membros: number;
}

/**
 * Papéis e equipas de cada pessoa (F6.5).
 *
 * Antes disto, pôr um técnico a trabalhar obrigava a escrever SQL numa consola
 * de produção. Uma consola de produção corre como dono das tabelas, e o dono
 * ignora o RLS — ou seja, a operação mais rotineira da plataforma era também a
 * mais perigosa.
 *
 * Não há aqui «criar utilizador»: a identidade vive no Keycloak e a linha
 * aparece no primeiro login (ADR-0006). Um utilizador criado aqui nunca
 * conseguiria entrar, e alguém ia perder uma tarde a perceber porquê.
 */
export function Pessoas({
  utilizadores,
  papeis,
  equipas,
}: {
  utilizadores: Utilizador[];
  papeis: Papel[];
  equipas: Equipa[];
}) {
  const router = useRouter();
  const [aGravar, setAGravar] = useState<string | undefined>(undefined);
  const [erro, setErro] = useState<string | undefined>(undefined);
  const [novaEquipa, setNovaEquipa] = useState({ key: '', nome: '' });

  async function chamar(caminho: string, corpo: unknown, marca: string) {
    setAGravar(marca);
    setErro(undefined);
    try {
      const resposta = await fetch(`/api/cvforms${caminho}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      if (!resposta.ok) {
        const dados = (await resposta.json().catch(() => ({}))) as { message?: string };
        throw new Error(dados.message ?? `a API respondeu ${resposta.status}`);
      }
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setAGravar(undefined);
    }
  }

  function alternarPapel(utilizador: Utilizador, papelId: string) {
    const actuais = new Set(utilizador.papeis.map((p) => p.id));
    if (actuais.has(papelId)) actuais.delete(papelId);
    else actuais.add(papelId);
    // O endpoint substitui a lista inteira: o que o ecrã mostra é o estado
    // final, e não uma diferença calculada no browser que se perde quando duas
    // pessoas editam ao mesmo tempo.
    return chamar(
      `/admin/users/${utilizador.id}/roles`,
      { papeis: [...actuais] },
      `${utilizador.id}:${papelId}`,
    );
  }

  function alternarEquipa(utilizador: Utilizador, equipaId: string, membros: Utilizador[]) {
    const dentro = utilizador.equipas.some((e) => e.id === equipaId);
    const ids = new Set(membros.map((m) => m.id));
    if (dentro) ids.delete(utilizador.id);
    else ids.add(utilizador.id);
    return chamar(
      `/admin/teams/${equipaId}/members`,
      { utilizadores: [...ids] },
      `${utilizador.id}:${equipaId}`,
    );
  }

  return (
    <>
      {erro ? <p className="erro">{erro}</p> : null}

      <div className="cartao">
        <h2>Utilizadores</h2>
        <table className="tabela">
          <thead>
            <tr>
              <th>Utilizador</th>
              <th>Papéis</th>
              <th>Equipas</th>
              <th>Formulários</th>
              <th>Última vez</th>
            </tr>
          </thead>
          <tbody>
            {utilizadores.map((utilizador) => (
              <tr key={utilizador.id}>
                <td>
                  <strong>{utilizador.display_name ?? utilizador.username}</strong>
                  <br />
                  <span className="suave pequeno">{utilizador.username}</span>
                </td>
                <td>
                  {papeis.map((papel) => (
                    <label key={papel.id} className="linha" style={{ gap: '0.35rem' }}>
                      <input
                        type="checkbox"
                        checked={utilizador.papeis.some((p) => p.id === papel.id)}
                        disabled={aGravar !== undefined}
                        onChange={() => void alternarPapel(utilizador, papel.id)}
                      />
                      <span className="pequeno">{papel.name}</span>
                    </label>
                  ))}
                </td>
                <td>
                  {equipas.map((equipa) => (
                    <label key={equipa.id} className="linha" style={{ gap: '0.35rem' }}>
                      <input
                        type="checkbox"
                        checked={utilizador.equipas.some((e) => e.id === equipa.id)}
                        disabled={aGravar !== undefined}
                        onChange={() =>
                          void alternarEquipa(
                            utilizador,
                            equipa.id,
                            utilizadores.filter((u) => u.equipas.some((e) => e.id === equipa.id)),
                          )
                        }
                      />
                      <span className="pequeno">{equipa.name}</span>
                    </label>
                  ))}
                  {equipas.length === 0 ? <span className="suave pequeno">sem equipas</span> : null}
                </td>
                <td>{utilizador.formularios}</td>
                <td className="suave pequeno">
                  {utilizador.last_seen_at
                    ? new Date(utilizador.last_seen_at).toLocaleDateString('pt-PT')
                    : 'nunca entrou'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {utilizadores.length === 0 ? (
          <p className="suave">
            Ainda ninguém entrou nesta organização. A linha de cada pessoa aparece aqui no primeiro
            login — a identidade vive no Keycloak, e esta tabela é o espelho.
          </p>
        ) : null}
      </div>

      <div className="cartao">
        <h2>Equipas</h2>
        <p className="suave">
          Uma equipa serve para atribuir um formulário a um grupo de pessoas de uma vez. Entrar numa
          equipa nunca tira acesso a ninguém: onde duas atribuições se sobrepõem, ganha a mais
          permissiva.
        </p>
        <div className="linha">
          <input
            placeholder="chave (ex.: bengo)"
            value={novaEquipa.key}
            onChange={(e) => setNovaEquipa({ ...novaEquipa, key: e.target.value })}
          />
          <input
            placeholder="Nome (ex.: Brigada do Bengo)"
            value={novaEquipa.nome}
            onChange={(e) => setNovaEquipa({ ...novaEquipa, nome: e.target.value })}
          />
          <button
            type="button"
            className="botao"
            disabled={!novaEquipa.key || !novaEquipa.nome || aGravar !== undefined}
            onClick={() =>
              void chamar('/admin/teams', novaEquipa, 'equipa').then(() =>
                setNovaEquipa({ key: '', nome: '' }),
              )
            }
          >
            Criar equipa
          </button>
        </div>
      </div>
    </>
  );
}
