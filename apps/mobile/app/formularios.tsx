import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { abrirBaseLocal } from '@/db/local';
import { clienteDeFormularios } from '@/lib/api';
import { guardarSessao } from '@/dados/sessao';
import { lerPerfil } from '@/lib/api';
import { lerTokens } from '@/lib/auth';
import { contarRegistos } from '@/dados/registos';
import {
  listarFormulariosLocais,
  sincronizarDefinicoes,
  type FormularioLocal,
} from '@/forms/definicoes';

/**
 * Os formulários que este telefone tem.
 *
 * Lê sempre do SQLite primeiro e só depois tenta a rede: com rede fraca, o
 * ecrã aparece imediatamente com o que já está descarregado, e a
 * sincronização acontece por cima. Um ecrã que só mostra alguma coisa depois
 * de a rede responder é um ecrã inútil no mato.
 */
export default function Formularios() {
  const router = useRouter();
  const [formularios, setFormularios] = useState<FormularioLocal[]>([]);
  const [contagens, setContagens] = useState<Record<string, number>>({});
  const [aCarregar, setACarregar] = useState(true);
  const [aSincronizar, setASincronizar] = useState(false);
  const [aviso, setAviso] = useState<string>();

  const carregarLocal = useCallback(async () => {
    const db = await abrirBaseLocal();
    const locais = await listarFormulariosLocais(db);
    setFormularios(locais);
    const totais: Record<string, number> = {};
    for (const f of locais) totais[f.id] = await contarRegistos(db, f.id);
    setContagens(totais);
    setACarregar(false);
  }, []);

  const sincronizar = useCallback(async () => {
    setASincronizar(true);
    setAviso(undefined);
    try {
      const tokens = await lerTokens();
      if (!tokens) {
        setAviso('sem sessão: entra outra vez para sincronizar');
        return;
      }
      const db = await abrirBaseLocal();
      const perfil = await lerPerfil(tokens.accessToken);
      await guardarSessao(db, {
        orgId: perfil.org.id,
        ...(perfil.user_id ? { userId: perfil.user_id } : {}),
        username: perfil.username,
      });
      const resultado = await sincronizarDefinicoes(db, clienteDeFormularios(tokens.accessToken));
      if (resultado.falhadas.length > 0) {
        setAviso(`${resultado.falhadas.length} definição(ões) não desceram; tenta outra vez`);
      }
      await carregarLocal();
    } catch (e) {
      // Falhar a sincronizar não é fatal: continua-se a trabalhar com o que já
      // está no telefone.
      setAviso(`sem rede ou servidor indisponível (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setASincronizar(false);
    }
  }, [carregarLocal]);

  useEffect(() => {
    void carregarLocal();
  }, [carregarLocal]);

  if (aCarregar) {
    return (
      <View style={estilos.centro}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={estilos.tudo}>
      <Stack.Screen options={{ title: 'Formulários' }} />
      {aviso ? <Text style={estilos.aviso}>{aviso}</Text> : null}
      <FlatList
        data={formularios}
        keyExtractor={(f) => f.id}
        refreshControl={
          <RefreshControl refreshing={aSincronizar} onRefresh={() => void sincronizar()} />
        }
        ListEmptyComponent={
          <View style={estilos.centro}>
            <Text style={estilos.suave}>
              Ainda não há formulários neste telefone. Puxa para baixo para sincronizar.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[estilos.cartao, item.arquivado && estilos.arquivado]}>
            <View style={estilos.expandir}>
              <Text style={estilos.titulo}>{item.titulo['pt'] ?? item.key}</Text>
              <Text style={estilos.suave}>
                versão {item.versao ?? '—'} · {contagens[item.id] ?? 0} registo(s)
                {item.arquivado ? ' · já não está atribuído' : ''}
              </Text>
            </View>
            <View style={estilos.accoes}>
              <Pressable
                style={estilos.secundario}
                onPress={() => router.push(`/registos/${item.id}`)}
              >
                <Text style={estilos.secundarioTexto}>ver</Text>
              </Pressable>
              {item.pode_criar && !item.arquivado ? (
                <Pressable
                  style={estilos.principal}
                  onPress={() => router.push(`/formulario/${item.id}`)}
                >
                  <Text style={estilos.principalTexto}>recolher</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const estilos = StyleSheet.create({
  tudo: { flex: 1, backgroundColor: '#fff' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  aviso: { backgroundColor: '#fff8e1', color: '#4a3c00', padding: 12 },
  cartao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eef1f4',
  },
  arquivado: { opacity: 0.55 },
  expandir: { flex: 1, gap: 2 },
  titulo: { fontSize: 16, fontWeight: '600' },
  suave: { color: '#5b6470', textAlign: 'center' },
  accoes: { flexDirection: 'row', gap: 8 },
  secundario: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c7ced6',
  },
  secundarioTexto: { color: '#3c4652', fontWeight: '600' },
  principal: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#0b6bcb',
  },
  principalTexto: { color: '#fff', fontWeight: '700' },
});
