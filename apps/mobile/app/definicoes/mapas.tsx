import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { uuidv7 } from '@cvforms/form-core';

import { abrirBaseLocal } from '@/db/local';
import {
  acrescentarCamadaManual,
  esquecerFicheiro,
  espacoOcupado,
  estaPronta,
  listarCamadas,
  type CamadaLocal,
} from '@/mapas/camadas';
import { descarregarCamada } from '@/mapas/descarga';
import { Seccao, Vazio, useEstilos } from '@/ui/componentes';
import { espaco, raio } from '@/ui/tema';

/**
 * Mapas offline (F8.2).
 *
 * OS DOIS CAMINHOS ESTÃO AQUI, e é de propósito:
 *
 *   - **Descarregar** o que o administrador carregou no painel. Fácil, mas
 *     custa rede: um mapa de uma província são 200 a 500 MB, e por rede móvel
 *     isso é dinheiro real do técnico ou da empresa. Daí o aviso do tamanho
 *     antes de começar, e não depois.
 *   - **Escolher um ficheiro** que já esteja no telefone — copiado por cabo,
 *     por cartão, ou recebido por WhatsApp. Não gasta um byte de rede, e é
 *     como uma brigada inteira fica com mapas numa manhã.
 *
 * O telefone trata os dois igual: o que interessa é o ficheiro estar cá.
 */
export default function MapasOffline() {
  const { tema, estilos } = useEstilos();

  const [camadas, setCamadas] = useState<CamadaLocal[]>([]);
  const [ocupado, setOcupado] = useState(true);
  const [aDescarregar, setADescarregar] = useState<string>();
  const [progresso, setProgresso] = useState(0);
  const [total, setTotal] = useState(0);

  const carregar = useCallback(async () => {
    const db = await abrirBaseLocal();
    setCamadas(await listarCamadas(db));
    setTotal(await espacoOcupado(db));
  }, []);

  useEffect(() => {
    void carregar().finally(() => setOcupado(false));
  }, [carregar]);

  async function descarregar(camada: CamadaLocal) {
    const mb = camada.bytes ? Math.round(camada.bytes / 1_048_576) : 0;
    // O aviso do tamanho vem ANTES, e com o número. «Isto pode gastar dados» é
    // um aviso que ninguém lê; «isto são 340 MB» é uma decisão.
    Alert.alert(
      camada.nome,
      mb
        ? `São ${mb} MB. Por rede móvel isso custa dinheiro — se puderes, espera por Wi-Fi.`
        : 'Descarregar este mapa?',
      [
        { text: 'Agora não', style: 'cancel' },
        {
          text: 'Descarregar',
          onPress: () => {
            setADescarregar(camada.id);
            setProgresso(0);
            void descarregarCamada(camada, (feito, esperado) =>
              setProgresso(esperado ? feito / esperado : 0),
            )
              .then(() => carregar())
              .catch((e: Error) => Alert.alert('Não foi possível descarregar', e.message))
              .finally(() => setADescarregar(undefined));
          },
        },
      ],
    );
  }

  async function escolherFicheiro() {
    const escolha = await DocumentPicker.getDocumentAsync({
      // Os PMTiles não têm um MIME registado; filtrar por tipo esconderia o
      // ficheiro e o técnico concluiria que ele não está lá.
      type: '*/*',
      copyToCacheDirectory: false,
    });
    if (escolha.canceled) return;
    const ficheiro = escolha.assets[0];
    if (!ficheiro) return;

    if (!ficheiro.name.toLowerCase().endsWith('.pmtiles')) {
      Alert.alert(
        'Não é um mapa',
        'O ficheiro tem de terminar em .pmtiles. Pede o ficheiro certo a quem administra.',
      );
      return;
    }

    const db = await abrirBaseLocal();
    await acrescentarCamadaManual(db, {
      id: uuidv7(),
      nome: ficheiro.name.replace(/\.pmtiles$/i, ''),
      uri: ficheiro.uri,
      bytes: ficheiro.size ?? 0,
    });
    await carregar();
  }

  const prontas = camadas.filter(estaPronta);
  const disponiveis = camadas.filter((c) => !estaPronta(c) && c.tipo === 'pmtiles');

  return (
    <ScrollView style={estilos.ecra} contentContainerStyle={{ paddingBottom: espaco.xxl }}>
      <Stack.Screen options={{ title: 'Mapas offline' }} />

      <View style={{ padding: espaco.l, gap: espaco.s }}>
        <Text style={estilos.suave}>
          Sem um mapa offline, o ecrã do mapa mostra os teus pontos sobre cinzento. Com um, vês as
          ruas e os limites mesmo sem rede nenhuma.
        </Text>
        {total > 0 ? (
          <Text style={estilos.suave}>
            Os mapas ocupam {(total / 1_048_576).toFixed(0)} MB neste telefone.
          </Text>
        ) : null}
      </View>

      {ocupado ? (
        <View style={{ padding: espaco.xl }}>
          <ActivityIndicator color={tema.realce} />
        </View>
      ) : null}

      {!ocupado && camadas.length === 0 ? (
        <Vazio
          icone="🗺"
          titulo="Ainda não há mapas"
          texto="Quando quem administra carregar um mapa, ele aparece aqui. Também podes escolher um ficheiro .pmtiles que já tenhas no telefone."
        />
      ) : null}

      {prontas.length ? (
        <>
          <View style={{ paddingHorizontal: espaco.l }}>
            <Seccao>No telefone</Seccao>
          </View>
          {prontas.map((c) => (
            <View key={c.id} style={estilos.linhaDeLista}>
              <Text style={{ fontSize: 22, width: 30, textAlign: 'center' }}>
                {c.tipo === 'estilo_online' ? '🌐' : '🗺'}
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[estilos.corpo, { fontWeight: '600' }]}>{c.nome}</Text>
                <Text style={estilos.suave}>
                  {c.tipo === 'estilo_online'
                    ? 'só funciona com rede'
                    : `${((c.bytes_locais ?? 0) / 1_048_576).toFixed(0)} MB${c.origem === 'manual' ? ' · do telefone' : ''}`}
                </Text>
              </View>
              {c.tipo === 'pmtiles' ? (
                <Pressable
                  onPress={() =>
                    Alert.alert(
                      'Apagar o mapa?',
                      'Liberta espaço. Podes voltar a descarregá-lo com rede.',
                      [
                        { text: 'Não', style: 'cancel' },
                        {
                          text: 'Apagar',
                          style: 'destructive',
                          onPress: () =>
                            void abrirBaseLocal()
                              .then((db) => esquecerFicheiro(db, c.id))
                              .then(() => carregar()),
                        },
                      ],
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={{ color: tema.erro, fontSize: 13 }}>apagar</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </>
      ) : null}

      {disponiveis.length ? (
        <>
          <View style={{ paddingHorizontal: espaco.l }}>
            <Seccao>Para descarregar</Seccao>
          </View>
          {disponiveis.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => void descarregar(c)}
              disabled={aDescarregar !== undefined}
              style={({ pressed }) => [
                estilos.linhaDeLista,
                pressed && { backgroundColor: tema.superficiePressionada },
              ]}
            >
              <Text style={{ fontSize: 22, width: 30, textAlign: 'center' }}>⬇</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[estilos.corpo, { fontWeight: '600' }]}>{c.nome}</Text>
                <Text style={estilos.suave}>
                  {aDescarregar === c.id
                    ? `a descarregar… ${Math.round(progresso * 100)}%`
                    : c.bytes
                      ? `${(c.bytes / 1_048_576).toFixed(0)} MB`
                      : 'tamanho desconhecido'}
                </Text>
              </View>
            </Pressable>
          ))}
        </>
      ) : null}

      <View style={{ padding: espaco.l }}>
        <Pressable
          onPress={() => void escolherFicheiro()}
          style={({ pressed }) => [
            estilos.capsula,
            { justifyContent: 'center' },
            pressed && { backgroundColor: tema.superficiePressionada },
          ]}
        >
          <Text style={estilos.capsulaTexto}>📂 Escolher um ficheiro do telefone</Text>
        </Pressable>
        <Text style={[estilos.suave, { marginTop: espaco.s }]}>
          Um ficheiro <Text style={estilos.mono}>.pmtiles</Text> que já tenhas — copiado por cabo,
          por cartão, ou recebido de um colega. Não gasta rede nenhuma.
        </Text>
      </View>

      <View style={{ paddingHorizontal: espaco.l, marginTop: espaco.m }}>
        <View
          style={{
            backgroundColor: tema.superficie,
            borderRadius: raio.m,
            padding: espaco.l,
            gap: espaco.xs,
          }}
        >
          <Text style={[estilos.corpo, { fontWeight: '600' }]}>Porque é que não há Google</Text>
          <Text style={estilos.suave}>
            Os termos do Google Maps não deixam guardar mapas no telefone para usar sem rede. Estes
            mapas são nossos, e por isso funcionam onde não há rede nenhuma — que é onde interessa.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
