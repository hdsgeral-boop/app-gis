import { chamarApi } from '@/lib/api';

interface Formulario {
  id: string;
  key: string;
  titulo: Record<string, string>;
  versao_corrente: number | null;
}

/**
 * Exportações (F10.1 a F10.5).
 *
 * Os links apontam para o proxy `/api/cvforms/...` e não para a API
 * directamente: é ele que junta o token do lado do servidor. Um link para a
 * API a partir do browser não levava autenticação nenhuma e dava 401.
 *
 * Cada descarga fica no registo de auditoria. Saber quem levou os dados para
 * fora é metade do que torna um cadastro auditável — e é a razão de não haver
 * aqui um botão de «exportar tudo de uma vez».
 */
export default async function Exportacoes() {
  let formularios: Formulario[] = [];
  let erro: string | undefined;

  try {
    const lista = await chamarApi<{ formularios: Formulario[] }>('/admin/forms');
    formularios = lista.formularios.filter((f) => f.versao_corrente !== null);
  } catch (e) {
    erro = (e as Error).message;
  }

  return (
    <main>
      <div className="marca-fita" />
      <h1>Exportações</h1>
      <p className="suave">
        Os dados saem das vistas geradas, com os rótulos das perguntas e não com os identificadores
        internos. O CSV abre no Excel português com dois cliques; o GeoJSON abre no QGIS.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      {formularios.length === 0 ? (
        <div className="cartao">
          <p className="vazio-tabela">
            Não há formulários publicados. Só depois de publicar é que há vistas de onde exportar.
          </p>
        </div>
      ) : (
        <div className="cartao">
          <table className="tabela">
            <thead>
              <tr>
                <th>Formulário</th>
                <th>Dados</th>
                <th>Anexos</th>
                <th>Qualidade</th>
              </tr>
            </thead>
            <tbody>
              {formularios.map((f) => (
                <tr key={f.id}>
                  <td>
                    <strong>{f.titulo.pt ?? f.key}</strong>
                    <br />
                    <span className="suave pequeno">v{f.versao_corrente}</span>
                  </td>
                  <td>
                    <a href={`/api/cvforms/admin/exports/${f.id}?format=csv`}>CSV</a>
                    {' · '}
                    <a href={`/api/cvforms/admin/exports/${f.id}?format=geojson`}>GeoJSON</a>
                  </td>
                  <td>
                    <a href={`/api/cvforms/admin/exports/${f.id}/anexos?format=sh`}>guião</a>
                    {' · '}
                    <a href={`/api/cvforms/admin/exports/${f.id}/anexos?format=csv`}>manifesto</a>
                  </td>
                  <td>
                    <a href={`/api/cvforms/admin/exports/${f.id}/qualidade`}>relatório</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cartao">
        <h2>Os anexos não vêm num ZIP</h2>
        <p className="suave">
          Um formulário com um ano de trabalho tem gigabytes de fotografias. Passá-las pelo servidor
          para as embrulhar deitava-o abaixo — e é a mesma razão pela qual o telefone também as
          envia directamente. O que sai é um guião que as vai buscar:
        </p>
        <pre className="bloco">{`sh descarregar-<formulario>.sh`}</pre>
        <p className="suave">
          Fica uma pasta <code>anexos/&lt;record_id&gt;/</code> ao lado do CSV, e é pelo{' '}
          <code>record_id</code> que se ligam. Os URLs do guião expiram; se der erro de autorização,
          gera a exportação outra vez.
        </p>
      </div>

      <div className="cartao">
        <h2>GeoPackage e Excel</h2>
        <p className="suave">
          Não têm botão, e é deliberado. O GPKG sai do GeoJSON com uma linha de <code>ogr2ogr</code>
          , que já vem com o QGIS; pôr GDAL no servidor só para isso não se paga. O CSV sai com BOM
          e ponto e vírgula, que é o que o Excel português abre directamente — um XLSX a sério
          obrigaria a mais uma dependência para o mesmo resultado.
        </p>
        <pre className="bloco">{`ogr2ogr -f GPKG dados.gpkg dados.geojson`}</pre>
      </div>
    </main>
  );
}
