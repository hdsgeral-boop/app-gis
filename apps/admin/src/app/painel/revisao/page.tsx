import Link from 'next/link';

import { chamarApi } from '@/lib/api';

interface RegistoPorRever {
  id: string;
  form_id: string;
  status: string;
  updated_at: string;
  created_by: string | null;
  revision_no: number | null;
}

interface FormularioDaLista {
  id: string;
  key: string;
  titulo: Record<string, string>;
}

/**
 * Registos à espera de olhos humanos (F5.7).
 *
 * `needs_review` significa uma de duas coisas: dois técnicos gravaram sobre a
 * mesma base e ninguém escolheu, ou a validação falhou e a revisão foi gravada
 * na mesma. As duas são deliberadas — recusar teria deixado trabalho de campo
 * preso num telefone —, mas as duas ficam a acumular se não houver este ecrã.
 *
 * É a fila de trabalho de quem valida. Se estiver vazia, está tudo tratado.
 */
export default async function Revisao() {
  let registos: RegistoPorRever[] = [];
  let formularios: FormularioDaLista[] = [];
  let erro: string | undefined;

  try {
    const [lista, forms] = await Promise.all([
      chamarApi<{ registos: RegistoPorRever[] }>('/records?status=needs_review&limite=200'),
      chamarApi<{ formularios: FormularioDaLista[] }>('/admin/forms'),
    ]);
    registos = lista.registos;
    formularios = forms.formularios;
  } catch (e) {
    erro = (e as Error).message;
  }

  const titulos = new Map(formularios.map((f) => [f.id, f.titulo.pt ?? f.key]));

  return (
    <main>
      <h1>Por rever</h1>
      <p className="suave">
        Registos em <code>needs_review</code>: houve um conflito de sincronização, ou a validação
        falhou e a revisão foi gravada à mesma. Nenhum destes registos se perdeu — estão todos aqui,
        à espera de alguém decidir.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      {registos.length === 0 && !erro ? (
        <div className="cartao">
          <p>Nada por rever.</p>
        </div>
      ) : (
        <div className="cartao">
          <table className="tabela">
            <thead>
              <tr>
                <th>Registo</th>
                <th>Formulário</th>
                <th>Revisão</th>
                <th>Actualizado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {registos.map((registo) => (
                <tr key={registo.id}>
                  <td>
                    <code className="identificador">{registo.id.slice(0, 8)}</code>
                  </td>
                  <td>{titulos.get(registo.form_id) ?? registo.form_id.slice(0, 8)}</td>
                  <td>{registo.revision_no ?? '—'}</td>
                  <td className="suave">{new Date(registo.updated_at).toLocaleString('pt-PT')}</td>
                  <td>
                    <Link className="botao secundario" href={`/painel/revisao/${registo.id}`}>
                      Rever
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/painel">← Painel</Link>
      </p>
    </main>
  );
}
