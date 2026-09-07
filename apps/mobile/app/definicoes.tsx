import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { abrirBaseLocal, resumoLocal, type ResumoLocal } from '@/db/local';
import { configuracaoDeGnss, fonteDeLocalizacaoActual } from '@/gnss/escolha';
import { camadasDisponiveis, espacoOcupado } from '@/mapas/camadas';
import { LinhaDeDefinicao, Seccao, useEstilos } from '@/ui/componentes';
import { espaco } from '@/ui/tema';

/**
 * Definições (F7.1, F7.6, F8).
 *
 * A ESTRUTURA É A DO KOBOCOLLECT — ícone, título, e o valor actual por baixo —
 * porque é o que deixa perceber o estado sem tocar em nada. «Receptor: GPS do
 * telefone» diz tudo o que é preciso; abrir só é necessário para mudar.
 *
 * O QUE NÃO ESTÁ AQUI, e é a diferença que interessa: **não há ecrã de
 * servidor**. O KoboCollect mostra URL, utilizador e senha; aqui o servidor vem
 * no pacote e o técnico nunca o vê. Uma pessoa a escrever um URL num telefone
 * ao sol é uma pessoa a escrever mal um URL — e o suporte que isso gera custa
 * mais do que a flexibilidade que dá.
 */
export default function Definicoes() {
  const router = useRouter();
  const { tema, estilos } = useEstilos();

  const [gnss, setGnss] = useState(configuracaoDeGnss());
  const [estadoGnss, setEstadoGnss] = useState('—');
  const [mapas, setMapas] = useState({ quantas: 0, bytes: 0 });
  const [resumo, setResumo] = useState<ResumoLocal>();

  useEffect(() => {
    void (async () => {
      const db = await abrirBaseLocal();
      const prontas = await camadasDisponiveis(db);
      setMapas({ quantas: prontas.length, bytes: await espacoOcupado(db) });
      setResumo(await resumoLocal());
    })();
  }, []);

  // Um segundo é o ritmo a que um receptor GNSS debita. Mais depressa não
  // mostra nada de novo e gasta bateria.
  useEffect(() => {
    const relogio = setInterval(() => {
      setGnss(configuracaoDeGnss());
      try {
        const fonte = fonteDeLocalizacaoActual() as {
          estado?: () => {
            ligada: boolean;
            ultimaLeitura?: { accuracyM?: number; fixType: string };
          };
        };
        const agora = fonte.estado?.();
        const leitura = agora?.ultimaLeitura;
        setEstadoGnss(
          leitura?.accuracyM !== undefined
            ? `±${leitura.accuracyM.toFixed(2)} m · ${leitura.fixType}`
            : agora?.ligada
              ? 'ligado, à espera de posição'
              : 'sem posição',
        );
      } catch {
        setEstadoGnss('—');
      }
    }, 1000);
    return () => clearInterval(relogio);
  }, []);

  return (
    <ScrollView style={estilos.ecra} contentContainerStyle={{ paddingBottom: espaco.xxl }}>
      <Stack.Screen options={{ title: 'Definições' }} />

      <View style={{ paddingHorizontal: espaco.l }}>
        <Seccao>Recolha</Seccao>
      </View>

      <LinhaDeDefinicao
        icone="📡"
        titulo="Receptor de posição"
        valor={`${gnss.tipo === 'tcp' ? 'Receptor externo' : 'GPS do telefone'} · ${estadoGnss}`}
        aoTocar={() => router.push('/definicoes/receptor')}
      />

      <View style={{ paddingHorizontal: espaco.l }}>
        <Seccao>Mapas</Seccao>
      </View>

      <LinhaDeDefinicao
        icone="🗺"
        titulo="Mapas offline"
        valor={
          mapas.quantas === 0
            ? 'nenhum — o mapa fica em branco sem rede'
            : `${mapas.quantas} camada(s) · ${(mapas.bytes / 1_048_576).toFixed(0)} MB`
        }
        aoTocar={() => router.push('/definicoes/mapas')}
      />

      <View style={{ paddingHorizontal: espaco.l }}>
        <Seccao>Este telefone</Seccao>
      </View>

      <LinhaDeDefinicao
        icone="💾"
        titulo="Base local"
        valor={
          resumo
            ? `${resumo.registos} registo(s) · ${resumo.porSincronizar} por enviar`
            : 'a contar…'
        }
      />
      <LinhaDeDefinicao
        icone="📋"
        titulo="Formulários descarregados"
        valor={resumo ? String(resumo.formularios) : '—'}
      />

      {/* O aviso que interessa mais do que todas as definições juntas. */}
      {resumo && resumo.porSincronizar + resumo.anexosPendentes > 0 ? (
        <View
          style={[
            estilos.cartao,
            { margin: espaco.l, borderLeftWidth: 4, borderLeftColor: tema.aviso },
          ]}
        >
          <Text style={estilos.aviso}>
            Há {resumo.porSincronizar + resumo.anexosPendentes} coisas por enviar.
          </Text>
          <Text style={estilos.suave}>
            Enquanto isto não estiver a zero, esse trabalho só existe neste telefone. Não o
            entregues nem desinstales a app.
          </Text>
        </View>
      ) : null}

      <Text style={[estilos.suave, { textAlign: 'center', marginTop: espaco.l }]}>
        Consul Colect
      </Text>
    </ScrollView>
  );
}
