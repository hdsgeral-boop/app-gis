import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { abrirBaseLocal } from '@/db/local';
import { listarRegistos } from '@/dados/registos';
import { camadaDeFundo, type CamadaLocal } from '@/mapas/camadas';
import { Mapa, type PontoNoMapa } from '@/mapas/Mapa';
import { useEstilos } from '@/ui/componentes';
import { espaco } from '@/ui/tema';

/**
 * O mapa dos registos recolhidos (F8.3, F8.4).
 *
 * O QUE ESTE ECRÃ RESOLVE. Num levantamento de cadastro, a pergunta mais
 * frequente não é «onde estou» — é «já passei aqui?». Uma lista de códigos não
 * responde a isso; um mapa com os pontos responde num segundo.
 *
 * As cores dizem o estado: o que ainda não subiu tem de se distinguir de
 * relance do que já está seguro no servidor.
 */
export default function EcraDeMapa() {
  const router = useRouter();
  const { tema, estilos } = useEstilos();

  const [pontos, setPontos] = useState<PontoNoMapa[]>([]);
  const [camada, setCamada] = useState<CamadaLocal>();
  const [ocupado, setOcupado] = useState(true);

  const carregar = useCallback(async () => {
    const db = await abrirBaseLocal();
    setCamada(await camadaDeFundo(db));

    // Só os que têm posição. Um registo sem ponto não desaparece — está na
    // lista — mas não tem onde ser desenhado.
    const linhas = await listarRegistos(db, { limite: 500 });
    setPontos(
      linhas
        .filter((l) => l.lat !== null && l.lon !== null)
        .map((l) => ({
          id: l.id,
          lat: l.lat!,
          lon: l.lon!,
          estado:
            l.status === 'needs_review'
              ? ('needs_review' as const)
              : l.status === 'rascunho'
                ? ('rascunho' as const)
                : l.synced
                  ? ('sincronizado' as const)
                  : ('submetido' as const),
        })),
    );
  }, []);

  useEffect(() => {
    void carregar().finally(() => setOcupado(false));
  }, [carregar]);

  if (ocupado) {
    return (
      <View style={[estilos.ecra, { alignItems: 'center', justifyContent: 'center' }]}>
        <Stack.Screen options={{ title: 'Mapa' }} />
        <ActivityIndicator color={tema.realce} />
      </View>
    );
  }

  return (
    <View style={estilos.ecra}>
      <Stack.Screen options={{ title: 'Mapa' }} />

      <Mapa
        camada={camada}
        pontos={pontos}
        aoTocarNoPonto={(id) => {
          const ponto = pontos.find((p) => p.id === id);
          if (!ponto) return;
          // Abrir o registo directamente do mapa é a F8.4: o técnico vê um
          // ponto que lhe parece errado e corrige-o sem passar pela lista.
          void abrirRegisto(id, router);
        }}
      />

      {/* A legenda em baixo, discreta. Sem ela, as cores são um enigma. */}
      <View
        style={{
          position: 'absolute',
          top: espaco.m,
          left: espaco.m,
          backgroundColor: tema.escuro ? 'rgba(11,17,22,0.85)' : 'rgba(255,255,255,0.9)',
          borderRadius: 10,
          padding: espaco.s,
          gap: 2,
        }}
        pointerEvents="none"
      >
        <Legenda cor="#8a5a00" texto="rascunho" />
        <Legenda cor="#10508a" texto="por enviar" />
        <Legenda cor="#1e7a3c" texto="no servidor" />
        <Legenda cor="#b3261e" texto="por rever" />
      </View>
    </View>
  );
}

function Legenda({ cor, texto }: { cor: string; texto: string }) {
  const { estilos } = useEstilos();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: cor }} />
      <Text style={estilos.suave}>{texto}</Text>
    </View>
  );
}

async function abrirRegisto(id: string, router: ReturnType<typeof useRouter>) {
  const db = await abrirBaseLocal();
  const linha = await db.getFirstAsync<{ form_id: string }>(
    `SELECT form_id FROM records WHERE id = ?`,
    [id],
  );
  if (!linha) return;
  router.push({
    pathname: '/formulario/[formId]',
    params: { formId: linha.form_id, recordId: id },
  });
}
