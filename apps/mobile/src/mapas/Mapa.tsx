import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';

import type { CamadaLocal } from './camadas';

/**
 * O mapa (F8, ADR-0005).
 *
 * MapLibre e não Google: a restrição inegociável 1 proíbe guardar mosaicos da
 * Google para uso offline, e um mapa que só funciona com rede não serve para
 * nada num levantamento no Bengo. O que se desenha por baixo é um PMTiles que
 * está no telefone — um ficheiro só, lido por intervalos de bytes, sem
 * servidor e sem uma segunda base de dados aberta.
 *
 * O QUE ESTE COMPONENTE FAZ QUANDO NÃO HÁ MAPA. Mostra os pontos sobre um
 * fundo neutro e diz que não há camada. Não tenta um mapa online: num sítio
 * sem rede, isso é um ecrã em branco a girar para sempre, e quem está lá
 * conclui que a app está avariada.
 */

// Sem serviço de mosaicos por omissão: o MapLibre tenta contactar um servidor
// de telemetria se isto não for desligado, e um telefone de campo não gasta
// bytes com telemetria.
MapLibreGL.setAccessToken(null);

export interface PontoNoMapa {
  id: string;
  lat: number;
  lon: number;
  /** Muda a cor: o que ainda não subiu tem de se distinguir de relance. */
  estado: 'rascunho' | 'submetido' | 'sincronizado' | 'needs_review';
  rotulo?: string;
}

export interface PropsMapa {
  camada: CamadaLocal | undefined;
  pontos: readonly PontoNoMapa[];
  /** Onde centrar. Sem isto, centra no primeiro ponto, e sem pontos em Luanda. */
  centro?: { lat: number; lon: number };
  zoom?: number;
  aoTocarNoPonto?: (id: string) => void;
  /** Ponto que está a ser recolhido agora, desenhado por cima de tudo. */
  posicaoActual?: { lat: number; lon: number; precisaoM: number } | undefined;
}

/** Baixa de Luanda. Só serve para o mapa não abrir no meio do Atlântico. */
const LUANDA = { lat: -8.8383, lon: 13.2344 };

const COR_POR_ESTADO: Record<PontoNoMapa['estado'], string> = {
  rascunho: '#8a5a00',
  submetido: '#10508a',
  sincronizado: '#1e7a3c',
  needs_review: '#b3261e',
};

export function Mapa({
  camada,
  pontos,
  centro,
  zoom = 14,
  aoTocarNoPonto,
  posicaoActual,
}: PropsMapa) {
  const alvo = centro ?? (pontos[0] ? { lat: pontos[0].lat, lon: pontos[0].lon } : LUANDA);

  /**
   * O estilo do MapLibre.
   *
   * Construído aqui e não guardado num ficheiro porque depende da camada
   * escolhida, que muda em execução. O `pmtiles://` é resolvido pelo MapLibre
   * nativo — não há servidor de mosaicos nenhum no meio.
   */
  const estilo = useMemo(() => {
    if (!camada) return undefined;
    if (camada.tipo === 'estilo_online') return camada.style_url ?? undefined;
    if (!camada.ficheiro_uri) return undefined;

    return JSON.stringify({
      version: 8,
      sources: {
        base: {
          type: 'raster',
          url: `pmtiles://${camada.ficheiro_uri}`,
          tileSize: 256,
          ...(camada.zoom_min !== null ? { minzoom: camada.zoom_min } : {}),
          ...(camada.zoom_max !== null ? { maxzoom: camada.zoom_max } : {}),
        },
      },
      layers: [
        // Um fundo por baixo do mosaico: onde o PMTiles não cobre, fica esta
        // cor em vez de preto. Preto lê-se como avaria; cinzento lê-se como
        // «não há mapa aqui».
        { id: 'fundo', type: 'background', paint: { 'background-color': '#e9ecef' } },
        { id: 'base', type: 'raster', source: 'base' },
      ],
    });
  }, [camada]);

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: pontos.map((p) => ({
        type: 'Feature' as const,
        id: p.id,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        properties: { id: p.id, estado: p.estado, cor: COR_POR_ESTADO[p.estado] },
      })),
    }),
    [pontos],
  );

  return (
    <View style={estilos.tudo}>
      <MapLibreGL.MapView
        style={estilos.mapa}
        mapStyle={estilo}
        logoEnabled={false}
        attributionEnabled={!!camada}
        compassEnabled
      >
        <MapLibreGL.Camera
          defaultSettings={{ centerCoordinate: [alvo.lon, alvo.lat], zoomLevel: zoom }}
        />

        <MapLibreGL.ShapeSource
          id="registos"
          shape={geojson}
          onPress={(e) => {
            const id = (e.features?.[0]?.properties as { id?: string } | undefined)?.id;
            if (id && aoTocarNoPonto) aoTocarNoPonto(id);
          }}
        >
          {/* Um círculo com contorno branco: sobre uma ortofoto escura, um
              ponto sem contorno desaparece. */}
          <MapLibreGL.CircleLayer
            id="registos-circulo"
            style={{
              circleRadius: 7,
              circleColor: ['get', 'cor'],
              circleStrokeWidth: 2,
              circleStrokeColor: '#ffffff',
            }}
          />
        </MapLibreGL.ShapeSource>

        {posicaoActual ? (
          <MapLibreGL.ShapeSource
            id="posicao"
            shape={{
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: [posicaoActual.lon, posicaoActual.lat],
              },
              properties: { precisao: posicaoActual.precisaoM },
            }}
          >
            {/* O halo é a precisão, à escala. É o que faz um técnico perceber
                que ±20 m não chega para posicionar um contador. */}
            <MapLibreGL.CircleLayer
              id="posicao-halo"
              style={{
                circleRadius: Math.max(8, Math.min(60, posicaoActual.precisaoM * 2)),
                circleColor: '#10508a',
                circleOpacity: 0.15,
              }}
            />
            <MapLibreGL.CircleLayer
              id="posicao-centro"
              style={{
                circleRadius: 6,
                circleColor: '#10508a',
                circleStrokeWidth: 2,
                circleStrokeColor: '#ffffff',
              }}
            />
          </MapLibreGL.ShapeSource>
        ) : null}
      </MapLibreGL.MapView>

      {!camada ? (
        <View style={estilos.aviso} pointerEvents="none">
          <Text style={estilos.avisoTexto}>
            Sem mapa offline. Os pontos aparecem na mesma; para veres o mapa por baixo, descarrega
            uma camada em Definições → Mapas.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  tudo: { flex: 1 },
  mapa: { flex: 1 },
  aviso: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: 'rgba(18,24,31,0.88)',
    borderRadius: 10,
    padding: 12,
  },
  avisoTexto: { color: '#fff', fontSize: 13, lineHeight: 18 },
});
