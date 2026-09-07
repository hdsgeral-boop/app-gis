'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface Camada {
  id: string;
  nome: string;
  descricao: string | null;
  tipo: 'pmtiles' | 'estilo_online';
  projecto_id: string | null;
  bytes: number | null;
  sha256: string | null;
  zoom_min: number | null;
  zoom_max: number | null;
  style_url: string | null;
  descarga_automatica: boolean;
  por_omissao: boolean;
}

export interface Projecto {
  id: string;
  key: string;
  name: string;
}

/**
 * Camadas de mapa (F8).
 *
 * O QUE ESTE ECRÃ FAZ E QUE UM FORMULÁRIO DE UPLOAD NORMAL NÃO FARIA:
 *
 * 1. **O ficheiro não passa pelo painel nem pela API.** Um PMTiles de uma
 *    província são 200 a 500 MB. O browser calcula o SHA-256, pede um URL
 *    assinado, e envia directamente para o armazenamento — a mesma decisão da
 *    F9.3, e pela mesma razão.
 * 2. **O hash é calculado antes de enviar.** É o que permite não voltar a
 *    enviar um mapa que já lá está, e é o que confirma que o que chegou é o
 *    que saiu.
 * 3. **Nunca mosaicos do Google.** A restrição inegociável 1 proíbe guardar
 *    mosaicos da Google para uso offline. Um `estilo_online` é outra coisa —
 *    fica online, e é isso que o tipo separado significa.
 */
export function Mapas({ camadas, projectos }: { camadas: Camada[]; projectos: Projecto[] }) {
  const router = useRouter();
  const [erro, setErro] = useState<string>();
  const [progresso, setProgresso] = useState<string>();
  const [nova, setNova] = useState({
    nome: '',
    projecto_id: '',
    descarga_automatica: false,
    por_omissao: false,
  });
  const [estilo, setEstilo] = useState({ nome: '', style_url: '' });

  async function api(caminho: string, corpo?: unknown, metodo: 'POST' | 'DELETE' = 'POST') {
    const resposta = await fetch(`/api/cvforms${caminho}`, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
    if (!resposta.ok) {
      const dados = (await resposta.json().catch(() => ({}))) as { message?: string };
      throw new Error(dados.message ?? `a API respondeu ${resposta.status}`);
    }
    return resposta.json();
  }

  /**
   * SHA-256 do ficheiro, por blocos.
   *
   * A `crypto.subtle.digest` do browser precisa do ficheiro inteiro em
   * memória, e 500 MB num portátil com 8 GB não passa. Lê-se por blocos e
   * acumula-se — mais lento, mas não rebenta.
   */
  async function hashDoFicheiro(ficheiro: File): Promise<string> {
    const BLOCO = 8 * 1024 * 1024;
    const partes: Uint8Array[] = [];
    for (let inicio = 0; inicio < ficheiro.size; inicio += BLOCO) {
      const bloco = await ficheiro.slice(inicio, inicio + BLOCO).arrayBuffer();
      partes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', bloco)));
      setProgresso(`a verificar… ${Math.round(((inicio + BLOCO) / ficheiro.size) * 100)}%`);
    }
    // Hash dos hashes: identifica o conteúdo de forma estável sem carregar o
    // ficheiro inteiro. Não é o SHA-256 do ficheiro, e não precisa de ser —
    // serve para deduplicar e para confirmar, e as duas pontas usam esta.
    const junto = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
    let deslocamento = 0;
    for (const p of partes) {
      junto.set(p, deslocamento);
      deslocamento += p.length;
    }
    const final = await crypto.subtle.digest('SHA-256', junto);
    return [...new Uint8Array(final)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function carregar(ficheiro: File) {
    setErro(undefined);
    try {
      if (!nova.nome.trim()) throw new Error('dá um nome à camada antes de escolher o ficheiro');

      const hash = await hashDoFicheiro(ficheiro);

      setProgresso('a criar a camada…');
      const criada = (await api('/mapas/camadas', {
        nome: nova.nome.trim(),
        tipo: 'pmtiles',
        ...(nova.projecto_id ? { projecto_id: nova.projecto_id } : {}),
        descarga_automatica: nova.descarga_automatica,
        por_omissao: nova.por_omissao,
      })) as { id: string };

      setProgresso('a pedir autorização…');
      const upload = (await api(`/mapas/camadas/${criada.id}/upload`, {
        hash,
        bytes: ficheiro.size,
      })) as { url: string; cabecalhos: Record<string, string> };

      setProgresso(`a enviar ${(ficheiro.size / 1_048_576).toFixed(0)} MB…`);
      const envio = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.cabecalhos,
        body: ficheiro,
      });
      if (!envio.ok) throw new Error(`o armazenamento recusou o ficheiro (${envio.status})`);

      await api(`/mapas/camadas/${criada.id}/completo`, { bytes: ficheiro.size });

      setProgresso(undefined);
      setNova({ nome: '', projecto_id: '', descarga_automatica: false, por_omissao: false });
      router.refresh();
    } catch (e) {
      setProgresso(undefined);
      setErro((e as Error).message);
    }
  }

  return (
    <>
      {erro ? <p className="erro">{erro}</p> : null}

      <div className="cartao">
        <h2>Camadas</h2>
        {camadas.length === 0 ? (
          <p className="suave">
            Ainda não há nenhuma. Sem uma camada offline, o mapa da app fica em branco quando não
            houver rede — que é a maior parte do tempo no terreno.
          </p>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Camada</th>
                <th>Tipo</th>
                <th>Tamanho</th>
                <th>Projecto</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {camadas.map((camada) => (
                <tr key={camada.id}>
                  <td>
                    <strong>{camada.nome}</strong>
                    {camada.por_omissao ? <span className="suave"> · fundo</span> : null}
                    {camada.descarga_automatica ? (
                      <span className="suave"> · automática</span>
                    ) : null}
                    {camada.tipo === 'pmtiles' && !camada.bytes ? (
                      <>
                        <br />
                        <span className="erro pequeno">
                          o ficheiro não chegou a subir — a app ignora esta camada
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>{camada.tipo === 'pmtiles' ? 'offline' : 'online'}</td>
                  <td>{camada.bytes ? `${(camada.bytes / 1_048_576).toFixed(0)} MB` : '—'}</td>
                  <td>
                    {camada.projecto_id
                      ? (projectos.find((p) => p.id === camada.projecto_id)?.name ?? '—')
                      : 'toda a organização'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="botao-suave perigo"
                      onClick={() =>
                        void api(`/mapas/camadas/${camada.id}`, undefined, 'DELETE')
                          .then(() => router.refresh())
                          .catch((e: Error) => setErro(e.message))
                      }
                    >
                      arquivar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="cartao">
        <h2>Carregar um mapa offline</h2>
        <p className="suave">
          Um ficheiro <code>.pmtiles</code>. O ficheiro vai directamente para o armazenamento — não
          passa por aqui nem pela API, porque um mapa de uma província são centenas de megabytes.
        </p>

        <div className="linha">
          <input
            placeholder="Nome (ex.: Bengo — ortofoto 2025)"
            value={nova.nome}
            onChange={(e) => setNova({ ...nova, nome: e.target.value })}
          />
          <select
            value={nova.projecto_id}
            onChange={(e) => setNova({ ...nova, projecto_id: e.target.value })}
          >
            <option value="">toda a organização</option>
            {projectos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="linha" style={{ marginTop: '0.75rem' }}>
          <label className="linha" style={{ gap: '0.35rem' }}>
            <input
              type="checkbox"
              checked={nova.descarga_automatica}
              onChange={(e) => setNova({ ...nova, descarga_automatica: e.target.checked })}
            />
            <span className="pequeno">descarregar sozinha (só em Wi-Fi)</span>
          </label>
          <label className="linha" style={{ gap: '0.35rem' }}>
            <input
              type="checkbox"
              checked={nova.por_omissao}
              onChange={(e) => setNova({ ...nova, por_omissao: e.target.checked })}
            />
            <span className="pequeno">usar como mapa de fundo</span>
          </label>
        </div>

        <p className="suave pequeno" style={{ marginTop: '0.5rem' }}>
          Um mapa de 300 MB por rede móvel custa dinheiro real ao técnico. Só marca «descarregar
          sozinha» se a brigada tiver Wi-Fi onde dorme.
        </p>

        <input
          type="file"
          accept=".pmtiles,application/octet-stream"
          disabled={progresso !== undefined}
          style={{ marginTop: '0.75rem' }}
          onChange={(e) => {
            const ficheiro = e.target.files?.[0];
            if (ficheiro) void carregar(ficheiro);
            e.target.value = '';
          }}
        />
        {progresso ? <p className="suave">{progresso}</p> : null}
      </div>

      <div className="cartao">
        <h2>Mapa online</h2>
        <p className="suave">
          Um estilo MapLibre, para usar no escritório e onde houver rede. Nunca fica guardado no
          telefone — a restrição 1 proíbe guardar mosaicos de terceiros para uso offline, e é por
          isso que isto é um tipo separado.
        </p>
        <div className="linha">
          <input
            placeholder="Nome (ex.: Ruas)"
            value={estilo.nome}
            onChange={(e) => setEstilo({ ...estilo, nome: e.target.value })}
          />
          <input
            placeholder="https://…/style.json"
            value={estilo.style_url}
            onChange={(e) => setEstilo({ ...estilo, style_url: e.target.value })}
          />
          <button
            type="button"
            className="botao"
            disabled={!estilo.nome || !estilo.style_url}
            onClick={() =>
              void api('/mapas/camadas', {
                nome: estilo.nome,
                tipo: 'estilo_online',
                style_url: estilo.style_url,
              })
                .then(() => {
                  setEstilo({ nome: '', style_url: '' });
                  router.refresh();
                })
                .catch((e: Error) => setErro(e.message))
            }
          >
            Acrescentar
          </button>
        </div>
      </div>
    </>
  );
}
