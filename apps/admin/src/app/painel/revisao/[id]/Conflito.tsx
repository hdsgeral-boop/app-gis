'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface RevisaoEmConflito {
  id: string;
  revision_no: number;
  data: Record<string, unknown>;
  author_id: string | null;
  device_id: string | null;
  server_received_at: string;
}

interface Props {
  recordId: string;
  revisoes: RevisaoEmConflito[];
  /** `id` do campo → rótulo legível. Vazio se a definição não veio. */
  rotulos: Record<string, string>;
  revisaoCorrente: string | null;
}

/**
 * Duas versões lado a lado, e um botão por cada (F5.7).
 *
 * O que este ecrã NÃO faz é fundir as duas automaticamente. Uma fusão campo a
 * campo produz um registo que nenhum dos dois técnicos alguma vez viu, e
 * ninguém consegue explicar de onde veio cada valor — num cadastro que serve
 * para decidir onde se põe equipamento, isso é pior do que escolher mal.
 *
 * Escolher NÃO apaga o ramo perdedor: a API grava uma revisão nova com os
 * dados escolhidos, e o histórico fica inteiro (restrição inegociável 4).
 */
export function Conflito({ recordId, revisoes, rotulos, revisaoCorrente }: Props) {
  const router = useRouter();
  const [aGravar, setAGravar] = useState<string | undefined>(undefined);
  const [erro, setErro] = useState<string | undefined>(undefined);
  const [nota, setNota] = useState('');

  // Todos os campos que aparecem em qualquer um dos ramos, para as colunas
  // ficarem alinhadas: um campo preenchido só num deles é exactamente o que
  // interessa ver.
  const campos = [...new Set(revisoes.flatMap((r) => Object.keys(r.data)))].sort();

  async function escolher(revisaoId: string) {
    setAGravar(revisaoId);
    setErro(undefined);
    try {
      const resposta = await fetch(`/api/cvforms/records/${recordId}/resolver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisao_escolhida: revisaoId,
          ...(nota.trim() ? { nota: nota.trim() } : {}),
        }),
      });
      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => ({}))) as { message?: string };
        throw new Error(corpo.message ?? `a API respondeu ${resposta.status}`);
      }
      router.push('/painel/revisao');
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setAGravar(undefined);
    }
  }

  return (
    <div className="cartao">
      <table className="tabela">
        <thead>
          <tr>
            <th>Campo</th>
            {revisoes.map((revisao) => (
              <th key={revisao.id}>
                Revisão {revisao.revision_no}
                {revisao.id === revisaoCorrente ? ' (corrente)' : ''}
                <br />
                <span className="suave pequeno">
                  {new Date(revisao.server_received_at).toLocaleString('pt-PT')}
                  {revisao.device_id ? ` · ${revisao.device_id}` : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campos.map((campo) => {
            const valores = revisoes.map((r) => formatar(r.data[campo]));
            const diferem = new Set(valores).size > 1;
            return (
              <tr key={campo} style={diferem ? { fontWeight: 600 } : undefined}>
                <td>
                  {rotulos[campo] ?? campo}
                  {diferem ? <span className="suave"> ≠</span> : null}
                </td>
                {valores.map((valor, i) => (
                  <td key={revisoes[i]!.id}>{valor}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      <label className="campo" style={{ marginTop: '1rem', display: 'block' }}>
        <span className="rotulo">Porque escolheste esta (fica na auditoria)</span>
        <textarea
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          rows={2}
          placeholder="ex.: a segunda leitura foi feita com o receptor externo"
        />
      </label>

      {erro ? <p className="erro">{erro}</p> : null}

      <div className="linha" style={{ marginTop: '1rem' }}>
        {revisoes.map((revisao) => (
          <button
            key={revisao.id}
            type="button"
            className="botao"
            disabled={aGravar !== undefined}
            onClick={() => void escolher(revisao.id)}
          >
            {aGravar === revisao.id ? 'A gravar…' : `Ficar com a revisão ${revisao.revision_no}`}
          </button>
        ))}
      </div>

      <p className="suave pequeno" style={{ marginTop: '0.75rem' }}>
        A que não escolheres não é apagada. Fica no histórico do registo, com o autor e a data — uma
        revisão nunca se apaga nem se sobrescreve.
      </p>
    </div>
  );
}

/** Um valor de resposta como se lê numa célula, sem inventar formatação. */
function formatar(valor: unknown): string {
  if (valor === null || valor === undefined) return '—';
  if (Array.isArray(valor)) return valor.map(formatar).join(', ');
  if (typeof valor === 'object') {
    const ponto = valor as { lat?: number; lon?: number; accuracy_m?: number };
    if (typeof ponto.lat === 'number' && typeof ponto.lon === 'number') {
      // Um ponto mostra-se com a precisão: entre dois ramos, é quase sempre a
      // precisão que decide qual é o bom.
      return `${ponto.lat.toFixed(6)}, ${ponto.lon.toFixed(6)}${
        typeof ponto.accuracy_m === 'number' ? ` (±${ponto.accuracy_m} m)` : ''
      }`;
    }
    return JSON.stringify(valor);
  }
  return String(valor);
}
