'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Criar um projecto.
 *
 * A chave segue a mesma regra dos formulários — minúsculas, dígitos e
 * underscore — porque entra no nome das vistas do PostGIS
 * (`v_<projecto>_<formulario>_v1`), que atravessam o QGIS e o Power BI.
 */
export function CriarProjecto() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [chave, setChave] = useState('');
  const [chaveTocada, setChaveTocada] = useState(false);
  const [descricao, setDescricao] = useState('');
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
      const resposta = await fetch('/api/cvforms/admin/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: chave,
          nome,
          ...(descricao.trim() ? { descricao: descricao.trim() } : {}),
        }),
      });
      const corpo = await resposta.json();
      if (!resposta.ok) {
        setErro(corpo.message ?? `a API respondeu ${resposta.status}`);
        return;
      }
      setNome('');
      setChave('');
      setChaveTocada(false);
      setDescricao('');
      router.refresh();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setACriar(false);
    }
  }

  return (
    <div className="cartao">
      <h2>Criar projecto</h2>

      <label className="campo">
        <span className="rotulo">Nome</span>
        <input
          type="text"
          value={nome}
          placeholder="Piloto do Bengo"
          onChange={(e) => {
            setNome(e.target.value);
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
          placeholder="piloto_bengo"
          onChange={(e) => {
            setChaveTocada(true);
            setChave(e.target.value);
          }}
        />
        <span className="suave pequeno">
          Entra no nome das vistas: <code>v_{chave || '<chave>'}_&lt;formulário&gt;_v1</code>.
        </span>
      </label>

      <label className="campo">
        <span className="rotulo">Descrição (opcional)</span>
        <input
          type="text"
          value={descricao}
          placeholder="Levantamento de locais de consumo no Bengo"
          onChange={(e) => setDescricao(e.target.value)}
        />
      </label>

      {erro ? <p className="erro">{erro}</p> : null}

      <button
        type="button"
        className="botao"
        disabled={aCriar || nome.trim() === '' || !/^[a-z][a-z0-9_]*$/.test(chave)}
        onClick={() => void criar()}
      >
        {aCriar ? 'a criar…' : 'criar projecto'}
      </button>
    </div>
  );
}
