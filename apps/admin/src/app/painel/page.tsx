import Link from 'next/link';

import { chamarApi } from '@/lib/api';

interface Perfil {
  username: string;
  nome?: string | null;
  org: { id: string; key?: string; name?: string; provisionada: boolean };
  papeis: string[];
  projectos: { id: string; key: string; name: string }[];
  formularios: {
    form_id: string;
    key: string;
    titulo: Record<string, string>;
    versao_corrente: number | null;
  }[];
  aviso?: string;
}

interface Registo {
  id: string;
  form_id: string;
}

/**
 * A entrada do painel.
 *
 * O QUE ESTÁ AQUI É O QUE ALGUÉM PRECISA DE SABER AO ABRIR DE MANHÃ, e nada
 * mais: quantos registos estão à espera de decisão humana, quantos formulários
 * ainda não foram publicados, e se a organização está provisionada. A
 * navegação vive no menu; repeti-la aqui em botões seria a mesma lista duas
 * vezes.
 *
 * O número de «por rever» é o único que exige acção. Se estiver a zero, não há
 * nada a fazer nesta página — e isso é uma informação tão útil como a outra.
 */
export default async function Painel() {
  let perfil: Perfil | undefined;
  let porRever = 0;
  let erro: string | undefined;

  try {
    const [p, registos] = await Promise.all([
      chamarApi<Perfil>('/me'),
      chamarApi<{ registos: Registo[] }>('/records?status=needs_review&limite=200').catch(() => ({
        registos: [] as Registo[],
      })),
    ]);
    perfil = p;
    porRever = registos.registos.length;
  } catch (e) {
    erro = (e as Error).message;
  }

  const porPublicar = perfil?.formularios.filter((f) => f.versao_corrente === null) ?? [];

  return (
    <main>
      <div className="marca-fita" />
      <div className="cabecalho-pagina">
        <div>
          <h1>{perfil?.org.name ?? 'Painel'}</h1>
          <p className="suave">
            {perfil?.nome ?? perfil?.username ?? ''}
            {perfil?.papeis.length ? ` · ${perfil.papeis.join(', ')}` : ''}
          </p>
        </div>
      </div>

      {erro ? (
        <div className="cartao">
          <strong>A API não respondeu.</strong>
          <p className="suave">
            {erro}. Confirma que a API está a correr e que o <code>API_URL</code> aponta para ela.
          </p>
        </div>
      ) : null}

      {perfil && !perfil.org.provisionada ? (
        <div className="cartao">
          <strong>Esta organização ainda não existe na base.</strong>
          <p className="suave">
            {perfil.aviso ?? 'Um administrador tem de a criar antes de se poder trabalhar.'}
          </p>
        </div>
      ) : null}

      <div className="cartao">
        <h2>Precisa de atenção</h2>
        {porRever === 0 && porPublicar.length === 0 ? (
          <p className="suave">Nada. Está tudo tratado.</p>
        ) : (
          <ul>
            {porRever > 0 ? (
              <li>
                <Link href="/painel/revisao">
                  {porRever === 1
                    ? '1 registo à espera de decisão'
                    : `${porRever} registos à espera de decisão`}
                </Link>
                <br />
                <span className="suave pequeno">
                  Houve um conflito de sincronização, ou a validação falhou e a revisão foi gravada
                  à mesma. Nenhum destes registos se perdeu.
                </span>
              </li>
            ) : null}
            {porPublicar.length > 0 ? (
              <li style={{ marginTop: porRever > 0 ? '0.75rem' : 0 }}>
                <Link href="/painel/formularios">
                  {porPublicar.length === 1
                    ? '1 formulário por publicar'
                    : `${porPublicar.length} formulários por publicar`}
                </Link>
                <br />
                <span className="suave pequeno">
                  Um formulário que nunca foi publicado não existe para a app, por mais desenhado
                  que esteja.
                </span>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="cartao">
        <h2>Formulários publicados</h2>
        {perfil?.formularios.length ? (
          <table className="tabela">
            <thead>
              <tr>
                <th>Formulário</th>
                <th>Versão</th>
              </tr>
            </thead>
            <tbody>
              {perfil.formularios
                .filter((f) => f.versao_corrente !== null)
                .map((f) => (
                  <tr key={f.form_id}>
                    <td>
                      <Link href={`/painel/formularios/${f.form_id}`}>{f.titulo.pt ?? f.key}</Link>
                    </td>
                    <td className="suave">v{f.versao_corrente}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p className="vazio-tabela">Ainda não há nenhum publicado.</p>
        )}
      </div>

      <div className="cartao">
        <h2>Projectos</h2>
        <p className="suave">
          {perfil?.projectos.length
            ? perfil.projectos.map((p) => p.name).join(' · ')
            : 'Nenhum. Os formulários pertencem a um projecto, e sem projectos não há onde os criar.'}
        </p>
      </div>
    </main>
  );
}
