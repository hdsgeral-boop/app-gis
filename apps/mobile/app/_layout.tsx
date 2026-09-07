import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { abrirBaseLocal } from '@/db/local';

/**
 * A base local abre antes de qualquer ecrã.
 *
 * Se falhar, a app pára aqui e diz porquê, em vez de deixar o técnico
 * preencher um formulário inteiro e só depois descobrir que não havia onde
 * gravar. Perder um registo de campo é o pior defeito possível.
 */
export default function Layout() {
  const [pronta, setPronta] = useState(false);
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    abrirBaseLocal()
      .then(() => setPronta(true))
      .catch((e: Error) => setErro(e.message));
  }, []);

  if (erro) {
    return (
      <View style={estilos.centro}>
        <Text style={estilos.titulo}>Não foi possível abrir a base local</Text>
        <Text style={estilos.suave}>{erro}</Text>
        <Text style={estilos.suave}>
          Sem base local não há onde gravar. Não continues sem resolver isto.
        </Text>
      </View>
    );
  }

  if (!pronta) {
    return (
      <View style={estilos.centro}>
        <ActivityIndicator />
        <Text style={estilos.suave}>a preparar a base local…</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerTitleStyle: { fontSize: 17 } }} />
    </>
  );
}

const estilos = StyleSheet.create({
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  titulo: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  suave: { color: '#5b6470', textAlign: 'center' },
});
