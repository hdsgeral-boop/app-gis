import Link from 'next/link';

import { chamarApi } from '@/lib/api';
import { CriarProjecto } from './criar';

interface Projecto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  formularios: number;
}

/**
 * Projectos da organização.
 *
 * É o primeiro ecrã de uma instalação nova, e não por gosto de hierarquia: um
 * formulário pertence sempre a um projecto, e sem projecto o ecrã de criar
 * formulário não tem onde o pôr.
 */
export default async function Projectos() {
  let projectos: Projecto[] = [];
  let erro: string | undefined;

  try {
    projectos = (await chamarApi<{ projectos: Projecto[] }>('/admin/projects')).projectos;
  } catch (e) {
    erro = (e as Error).message;
  }

  return (
    <main>
      <div className="marca-fita" />
      <h1>Projectos</h1>
      <p className="suave">
        Um projecto agrupa os formulários de um mesmo trabalho. Dá nome às vistas que o QGIS lê, e é
        por ele que as exportações e os mapas se organizam.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      <div className="cartao">
        <table className="tabela">
          <thead>
            <tr>
              <th>Projecto</th>
              <th>Chave</th>
              <th>Formulários</th>
            </tr>
          </thead>
          <tbody>
            {projectos.length === 0 ? (
              <tr>
                <td colSpan={3} className="vazio-tabela">
                  Ainda não há nenhum. Cria o primeiro aqui abaixo.
                </td>
              </tr>
            ) : null}
            {projectos.map((p) => (
              <tr key={p.id} className={p.archived_at ? 'arquivado' : undefined}>
                <td>
                  {p.name}
                  {p.description ? (
                    <>
                      <br />
                      <span className="suave pequeno">{p.description}</span>
                    </>
                  ) : null}
                  {p.archived_at ? <span className="suave"> · arquivado</span> : null}
                </td>
                <td>
                  <code>{p.key}</code>
                </td>
                <td className="suave">{p.formularios}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CriarProjecto />

      <p style={{ marginTop: '2rem' }}>
        <Link href="/painel/formularios">Formulários →</Link>
      </p>
    </main>
  );
}
