import Link from 'next/link';

import { chamarApi } from '@/lib/api';
import { Mapas, type Camada, type Projecto } from './Mapas';

/**
 * Mapas offline (F8, ADR-0005).
 *
 * O que se administra aqui é o que o técnico vai ver por baixo dos pontos
 * quando não houver rede — que é a maior parte do tempo no terreno. Sem uma
 * camada offline, o mapa da app é um quadrado cinzento.
 */
export default async function MapasPage() {
  let camadas: Camada[] = [];
  let projectos: Projecto[] = [];
  let erro: string | undefined;

  try {
    const [c, perfil] = await Promise.all([
      chamarApi<{ camadas: Camada[] }>('/mapas/camadas'),
      chamarApi<{ projectos: Projecto[] }>('/me'),
    ]);
    camadas = c.camadas;
    projectos = perfil.projectos;
  } catch (e) {
    erro = (e as Error).message;
  }

  return (
    <main>
      <h1>Mapas</h1>
      <p className="suave">
        Os mosaicos que a app usa para desenhar o mapa sem rede. São ficheiros <code>.pmtiles</code>{' '}
        — um ficheiro só por área, que o telefone lê directamente sem precisar de servidor nenhum.
      </p>

      {erro ? <p className="erro">{erro}</p> : null}

      <Mapas camadas={camadas} projectos={projectos} />

      <div className="cartao">
        <h2>Como preparar um ficheiro</h2>
        <p className="suave">
          De um GeoPackage, shapefile ou GeoTIFF que já tenhas, com as ferramentas que vêm com o
          QGIS:
        </p>
        <pre className="bloco">
          {`# Vectorial (ruas, limites, cadastro)
ogr2ogr -f MVT mosaicos/ dados.gpkg -dsco MINZOOM=6 -dsco MAXZOOM=16
pmtiles convert mosaicos.mbtiles bengo.pmtiles

# Raster (ortofoto)
gdal2tiles.py --xyz -z 10-18 ortofoto.tif mosaicos/
pmtiles convert mosaicos.mbtiles bengo.pmtiles`}
        </pre>
        <p className="suave">
          O <code>pmtiles</code> é uma ferramenta de linha de comandos com um binário só, sem
          instalação. Corta a área ao que a brigada vai mesmo percorrer: cada zoom a mais
          quadruplica o tamanho, e um mapa de 2 GB não entra num telefone de campo.
        </p>
      </div>

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/painel">← Painel</Link>
      </p>
    </main>
  );
}
