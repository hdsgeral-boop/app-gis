'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Criar um formulário.
 *
 * A chave é sugerida a partir do título e é editável até à criação, porque
 * depois dá nome às vistas do PostGIS — e mudá-la mais tarde renomeia camadas
 * a que alguém já pode ter ligado o QGIS.
 */
export function CriarFormulario({
  projectos,
}: {
  projectos: { id: string; key: string; name: string }[];
}) {
  const router = useRouter();
  const [titulo, setTitulo] = useState('');
  const [chave, setChave] = useState('');
  const [chaveTocada, setChaveTocada] = useState(false);
  const [projecto, setProjecto] = useState(projectos[0]?.id ?? '');
  const [erro, setErro] = useState<string>();
  const [aCriar, setACriar] = useState(false);

  const sugerirChave = (valor: string): string =>
    valor
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);

  async function criar(): Promise<void> {
    setACriar(true);
    setErro(undefined);
    try {
      const resposta = await fetch('/api/cvforms/admin/forms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projecto_id: projecto, key: chave, titulo: { pt: titulo } }),
      });
      const corpo = await resposta.json();
      if (!resposta.ok) {
        setErro(corpo.message ?? `a API respondeu ${resposta.status}`);
        return;
      }
      router.push(`/painel/formularios/${corpo.form_id}`);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setACriar(false);
    }
  }

  if (projectos.length === 0) {
    return (
      <div className="cartao">
        <p className="suave">
          Não há nenhum projecto nesta organização. Um formulário pertence sempre a um projecto.
        </p>
      </div>
    );
  }

  return (
    <div className="cartao">
      <h2>Criar formulário</h2>
      <label className="campo">
        <span className="rotulo">Título</span>
        <input
          type="text"
          value={titulo}
          placeholder="Local de Consumo"
          onChange={(e) => {
            setTitulo(e.target.value);
            if (!chaveTocada) setChave(sugerirChave(e.target.value));
          }}
        />
      </label>

      <label className="campo">
        <span className="rotulo">Chave</span>
        <input
          type="text"
          value={chave}
          pattern="[a-z][a-z0-9_]*"
          onChange={(e) => {
            setChaveTocada(true);
            setChave(e.target.value);
          }}
        />
        <span className="suave pequeno">
          Dá nome às vistas do PostGIS: <code>v_&lt;projecto&gt;_{chave || '<chave>'}_v1</code>.
          Escolhe-a bem — mudá-la depois renomeia camadas a que alguém já ligou o QGIS.
        </span>
      </label>

      <label className="campo">
        <span className="rotulo">Projecto</span>
        <select value={projecto} onChange={(e) => setProjecto(e.target.value)}>
          {projectos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {erro ? <p className="erro">{erro}</p> : null}

      <button
        type="button"
        className="botao"
        disabled={aCriar || titulo.trim() === '' || !/^[a-z][a-z0-9_]*$/.test(chave)}
        onClick={() => void criar()}
      >
        {aCriar ? 'a criar…' : 'criar e abrir o construtor'}
      </button>
    </div>
  );
}
