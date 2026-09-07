'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface Formulario {
  id: string;
  key: string;
  titulo: Record<string, string>;
  versao_corrente: number | null;
}

export interface Pessoa {
  id: string;
  username: string;
  display_name: string | null;
}

export interface Equipa {
  id: string;
  key: string;
  name: string;
  membros: number;
}

export interface Papel {
  id: string;
  key: string;
  name: string;
}

export interface Atribuicao {
  id: string;
  formId: string;
  principalType: 'user' | 'team' | 'role';
  principalId: string;
  canRead: boolean;
  canCreate: boolean;
  canEditOwn: boolean;
  canEditAll: boolean;
  canDelete: boolean;
  scopeFilter: { valores?: string[] } | null;
}

/**
 * Quem recolhe o quê (F6.3 e F6.4).
 *
 * TRÊS COISAS QUE ESTE ECRÃ TEM DE DEIXAR CLARAS, porque enganar-se em
 * qualquer uma delas dá um técnico sem trabalho ou dados de mais na mão de
 * alguém:
 *
 * 1. **Sem atribuição, não se vê nada.** Nem os registos, nem sequer a
 *    definição do formulário. Não é uma preferência de interface: é aplicado
 *    pelo Postgres (RLS), pelas regras de sincronização e pela API.
 * 2. **A quem se atribui.** A uma pessoa, a uma equipa ou a um papel. Onde
 *    duas atribuições se sobrepõem, ganha a mais permissiva — entrar numa
 *    equipa nunca tira acesso a ninguém.
 * 3. **O âmbito.** Um técnico do Bengo não tem que ver os registos do Uíge. O
 *    filtro é uma lista de valores do campo de âmbito do formulário, e uma
 *    atribuição sem filtro apaga o filtro das outras.
 */
export function Atribuicoes({
  formularios,
  pessoas,
  equipas,
  papeis,
  atribuicoesPorFormulario,
}: {
  formularios: Formulario[];
  pessoas: Pessoa[];
  equipas: Equipa[];
  papeis: Papel[];
  atribuicoesPorFormulario: Record<string, Atribuicao[]>;
}) {
  const router = useRouter();
  const [formulario, setFormulario] = useState(formularios[0]?.id ?? '');
  const [erro, setErro] = useState<string>();
  const [aGravar, setAGravar] = useState(false);

  const [nova, setNova] = useState({
    tipo: 'user' as 'user' | 'team' | 'role',
    id: '',
    pode_ler: true,
    pode_criar: true,
    pode_editar_proprios: true,
    pode_editar_todos: false,
    pode_apagar: false,
    ambito: '',
  });

  const atribuicoes = atribuicoesPorFormulario[formulario] ?? [];

  function nomeDe(a: Atribuicao): string {
    if (a.principalType === 'user') {
      const p = pessoas.find((x) => x.id === a.principalId);
      return p ? (p.display_name ?? p.username) : a.principalId.slice(0, 8);
    }
    if (a.principalType === 'team') {
      return equipas.find((e) => e.id === a.principalId)?.name ?? a.principalId.slice(0, 8);
    }
    return papeis.find((p) => p.id === a.principalId)?.name ?? a.principalId.slice(0, 8);
  }

  const candidatos =
    nova.tipo === 'user'
      ? pessoas.map((p) => ({ id: p.id, nome: p.display_name ?? p.username }))
      : nova.tipo === 'team'
        ? equipas.map((e) => ({ id: e.id, nome: `${e.name} (${e.membros})` }))
        : papeis.map((p) => ({ id: p.id, nome: p.name }));

  async function guardar() {
    if (!formulario || !nova.id) return;
    setAGravar(true);
    setErro(undefined);
    try {
      const valores = nova.ambito
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

      const resposta = await fetch(`/api/cvforms/admin/forms/${formulario}/assignments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principal_type: nova.tipo,
          principal_id: nova.id,
          pode_ler: nova.pode_ler,
          pode_criar: nova.pode_criar,
          pode_editar_proprios: nova.pode_editar_proprios,
          pode_editar_todos: nova.pode_editar_todos,
          pode_apagar: nova.pode_apagar,
          // Sem valores, NÃO se manda o filtro: um filtro vazio quer dizer
          // «não vê nada», e é o contrário do que quem não escreveu nada quer.
          ...(valores.length ? { scope_filter: { valores } } : {}),
        }),
      });
      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => ({}))) as { message?: string };
        throw new Error(corpo.message ?? `a API respondeu ${resposta.status}`);
      }
      setNova({ ...nova, id: '', ambito: '' });
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setAGravar(false);
    }
  }

  return (
    <>
      {erro ? <p className="erro">{erro}</p> : null}

      <div className="cartao">
        <label className="campo">
          <span className="rotulo">Formulário</span>
          <select value={formulario} onChange={(e) => setFormulario(e.target.value)}>
            {formularios.map((f) => (
              <option key={f.id} value={f.id}>
                {f.titulo.pt ?? f.key}
                {f.versao_corrente ? ` · v${f.versao_corrente}` : ' · por publicar'}
              </option>
            ))}
          </select>
        </label>

        {formularios.length === 0 ? (
          <p className="suave">
            Ainda não há formulários. Cria um em Formulários e volta aqui para o atribuir.
          </p>
        ) : null}
      </div>

      <div className="cartao">
        <h2>Quem tem acesso</h2>
        {atribuicoes.length === 0 ? (
          <p className="vazio-tabela">
            Ninguém. Enquanto assim for, este formulário não existe para técnico nenhum — nem a
            definição chega ao telefone.
          </p>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Quem</th>
                <th>Pode</th>
                <th>Âmbito</th>
              </tr>
            </thead>
            <tbody>
              {atribuicoes.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{nomeDe(a)}</strong>
                    <br />
                    <span className="cracha">
                      {a.principalType === 'user'
                        ? 'pessoa'
                        : a.principalType === 'team'
                          ? 'equipa'
                          : 'papel'}
                    </span>
                  </td>
                  <td className="pequeno">
                    {[
                      a.canRead && 'ver',
                      a.canCreate && 'criar',
                      a.canEditAll ? 'editar tudo' : a.canEditOwn && 'editar os seus',
                      a.canDelete && 'apagar',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="pequeno">
                    {a.scopeFilter?.valores?.length ? (
                      <span className="cracha cracha-alerta">
                        {a.scopeFilter.valores.join(', ')}
                      </span>
                    ) : (
                      <span className="suave">tudo</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="cartao">
        <h2>Dar acesso</h2>

        <div className="linha">
          <label className="campo">
            <span className="rotulo">A quem</span>
            <select
              value={nova.tipo}
              onChange={(e) =>
                setNova({ ...nova, tipo: e.target.value as typeof nova.tipo, id: '' })
              }
            >
              <option value="user">Uma pessoa</option>
              <option value="team">Uma equipa</option>
              <option value="role">Um papel</option>
            </select>
          </label>

          <label className="campo expandir">
            <span className="rotulo">Quem</span>
            <select value={nova.id} onChange={(e) => setNova({ ...nova, id: e.target.value })}>
              <option value="">escolher…</option>
              {candidatos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="linha" style={{ flexWrap: 'wrap', marginTop: '0.75rem' }}>
          {(
            [
              ['pode_ler', 'ver os registos'],
              ['pode_criar', 'criar registos'],
              ['pode_editar_proprios', 'editar os seus'],
              ['pode_editar_todos', 'editar os de todos'],
              ['pode_apagar', 'apagar'],
            ] as const
          ).map(([chave, rotulo]) => (
            <label key={chave} className="linha" style={{ gap: '0.35rem' }}>
              <input
                type="checkbox"
                checked={nova[chave]}
                onChange={(e) => setNova({ ...nova, [chave]: e.target.checked })}
              />
              <span className="pequeno">{rotulo}</span>
            </label>
          ))}
        </div>

        <label className="campo" style={{ marginTop: '0.75rem' }}>
          <span className="rotulo">Âmbito (opcional)</span>
          <input
            value={nova.ambito}
            onChange={(e) => setNova({ ...nova, ambito: e.target.value })}
            placeholder="Bengo, Dande"
          />
        </label>
        <p className="suave pequeno">
          Valores do campo de âmbito do formulário, separados por vírgula. Em branco, vê tudo o que
          lhe está atribuído. Um registo cujo campo de âmbito esteja por responder não é visto por
          quem tenha filtro — é deliberado, e quem o recolheu continua a vê-lo.
        </p>

        <button
          type="button"
          className="botao"
          style={{ marginTop: '1rem' }}
          disabled={!formulario || !nova.id || aGravar}
          onClick={() => void guardar()}
        >
          {aGravar ? 'A guardar…' : 'Dar acesso'}
        </button>
      </div>
    </>
  );
}
