import Link from 'next/link';

import { chamarApi } from '@/lib/api';
import { CriarFormulario } from './criar';

interface FormularioDaLista {
  id: string;
  key: string;
  titulo: Record<string, string>;
  projecto_id: string;
  versao_corrente: number | null;
  arquivado_em: string | null;
}

interface Perfil {
  projectos: { id: string; key: string; name: string }[];
}

/**
 * Os formulários da organização.
 *
 * O que interessa saber de relance: qual é a versão publicada de cada um, e
 * quais é que ainda não foram publicados nenhuma vez — esses não existem para
 * a app móvel, por mais desenhados que estejam.
 */
export default async function Formularios() {
  let formularios: FormularioDaLista[] = [];
  let projectos: Perfil['projectos'] = [];
  let erro: string | undefined;

  try {
    const [lista, perfil] = await Promise.all([
      chamarApi<{ formularios: FormularioDaLista[] }>('/admin/forms'),
      chamarApi<Perfil>('/me'),
    ]);
    formularios = lista.formularios;
    projectos = perfil.projectos;
  } catch (e) {
    erro = (e as Error).message;
  }

  return (
    <main>
      <h1>Formulários</h1>
      <p className="suave">
        Um formulário publicado aparece na app dos técnicos a quem estiver atribuído, sem ninguém
        publicar uma versão nova da app.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      <div className="cartao">
        <table className="tabela">
          <thead>
            <tr>
              <th>Formulário</th>
              <th>Chave</th>
              <th>Versão publicada</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {formularios.length === 0 ? (
              <tr>
                <td colSpan={4} className="suave">
                  Ainda não há nenhum formulário.
                </td>
              </tr>
            ) : null}
            {formularios.map((f) => (
              <tr key={f.id} className={f.arquivado_em ? 'arquivado' : undefined}>
                <td>{f.titulo?.pt ?? f.key}</td>
                <td>
                  <code>{f.key}</code>
                </td>
                <td>
                  {f.versao_corrente ?? <span className="suave">por publicar</span>}
                  {f.arquivado_em ? <span className="suave"> · arquivado</span> : null}
                </td>
                <td>
                  <Link className="botao-suave" href={`/painel/formularios/${f.id}`}>
                    abrir
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CriarFormulario projectos={projectos} />

      <p style={{ marginTop: '2rem' }}>
        <Link href="/painel">← voltar ao painel</Link>
      </p>
    </main>
  );
}
