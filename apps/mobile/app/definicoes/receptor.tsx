import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { configuracaoDeGnss, definirGnss, fonteDeLocalizacaoActual } from '@/gnss/escolha';
import type { TipoDeFonte } from '@/gnss/escolha';
import { Seccao, useEstilos } from '@/ui/componentes';
import { espaco, raio } from '@/ui/tema';

/**
 * Que receptor usar (F7.1, F7.6).
 *
 * É a única definição que muda o que fica GRAVADO num registo, e por isso é a
 * única com ecrã próprio. O estado está sempre à vista e actualiza-se a cada
 * segundo: um técnico que não vê a precisão não sabe se o ponto que vai gravar
 * serve para alguma coisa (ESPECIFICACAO §11).
 *
 * O endereço do receptor está atrás de «avançado» de propósito. Noventa e nove
 * por cento dos Emlid respondem no valor por omissão, e um campo de IP à vista
 * é um campo que alguém acaba por mexer sem precisar.
 */
export default function Receptor() {
  const { tema, estilos } = useEstilos();
  const inicial = configuracaoDeGnss();

  const [tipo, setTipo] = useState<TipoDeFonte>(inicial.tipo);
  const [host, setHost] = useState(inicial.host ?? '192.168.42.1');
  const [porto, setPorto] = useState(String(inicial.porto ?? 9001));
  const [avancado, setAvancado] = useState(false);
  const [estado, setEstado] = useState('—');

  useEffect(() => {
    const relogio = setInterval(() => {
      try {
        const fonte = fonteDeLocalizacaoActual() as {
          estado?: () => {
            ligada: boolean;
            ultimaLeitura?: { accuracyM?: number; fixType: string };
          };
        };
        const agora = fonte.estado?.();
        const leitura = agora?.ultimaLeitura;
        setEstado(
          leitura?.accuracyM !== undefined
            ? `±${leitura.accuracyM.toFixed(2)} m · ${leitura.fixType}`
            : agora?.ligada
              ? 'ligado, à espera de posição'
              : 'sem ligação',
        );
      } catch {
        setEstado('—');
      }
    }, 1000);
    return () => clearInterval(relogio);
  }, [tipo]);

  function aplicar(novo: TipoDeFonte) {
    setTipo(novo);
    definirGnss(
      novo === 'tcp'
        ? { tipo: 'tcp', host: host.trim(), porto: Number(porto) || 9001 }
        : { tipo: 'interno' },
    );
  }

  const Opcao = ({
    valor,
    titulo,
    descricao,
    precisao,
  }: {
    valor: TipoDeFonte;
    titulo: string;
    descricao: string;
    precisao: string;
  }) => (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: tipo === valor }}
      onPress={() => aplicar(valor)}
      style={{
        borderWidth: tipo === valor ? 2 : 1,
        borderColor: tipo === valor ? tema.realce : tema.borda,
        borderRadius: raio.m,
        backgroundColor: tema.superficie,
        padding: espaco.l,
        gap: espaco.xs,
      }}
    >
      <Text style={[estilos.corpo, { fontWeight: '600' }]}>{titulo}</Text>
      <Text style={estilos.suave}>{descricao}</Text>
      <Text style={[estilos.suave, { color: tema.realce }]}>{precisao}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      style={estilos.ecra}
      contentContainerStyle={{ padding: espaco.l, gap: espaco.m, paddingBottom: espaco.xxl }}
    >
      <Stack.Screen options={{ title: 'Receptor' }} />

      <Text style={estilos.suave}>
        O que escolheres aqui fica gravado na origem de cada ponto, e é o que permite a quem usar os
        dados saber quanto pode confiar neles.
      </Text>

      <Opcao
        valor="interno"
        titulo="GPS do telefone"
        descricao="Sempre disponível, não precisa de mais nada."
        precisao="3 a 8 metros em céu aberto"
      />
      <Opcao
        valor="tcp"
        titulo="Receptor externo (Wi-Fi)"
        descricao="Emlid, Trimble ou equivalente. Liga primeiro o telefone ao Wi-Fi do receptor."
        precisao="2 cm a 50 cm"
      />

      <View style={[estilos.cartao, { marginTop: espaco.s }]}>
        <Text style={estilos.suave}>Estado agora</Text>
        <Text style={estilos.mono}>{estado}</Text>
      </View>

      {tipo === 'tcp' ? (
        <>
          <Pressable onPress={() => setAvancado(!avancado)}>
            <Text style={[estilos.suave, { color: tema.realce }]}>
              {avancado ? '▾' : '▸'} endereço do receptor
            </Text>
          </Pressable>
          {avancado ? (
            <View style={estilos.cartao}>
              <Seccao>Só mexe nisto se o receptor não for encontrado</Seccao>
              <TextInput
                style={estilos.entrada}
                value={host}
                onChangeText={setHost}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                onBlur={() => aplicar('tcp')}
              />
              <TextInput
                style={estilos.entrada}
                value={porto}
                onChangeText={setPorto}
                keyboardType="number-pad"
                onBlur={() => aplicar('tcp')}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
