import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { collectFields, evaluate, makeContext, type FormDefinition } from '@cvforms/form-core';

import { abrirBaseLocal } from '@/db/local';
import { lerDefinicaoCorrente } from '@/forms/definicoes';
import { listarRegistos, type LinhaDaListagem } from '@/dados/registos';

/**
 * Lista dos registos de um formulário (F4.3 e F4.4).
 *
 * Virtualizada e paginada: 30 000 registos locais são normais num cadastro, e
 * carregá-los todos para a memória de um Android de gama baixa enche-a. A
 * procura usa os campos marcados como `searchable` na definição — nunca uma
 * lista de campos escrita à mão no código.
 */
const PAGINA = 40;

export default function Registos() {
  const { formId } = useLocalSearchParams<{ formId: string }>();
  const router = useRouter();

  const [definicao, setDefinicao] = useState<FormDefinition>();
  const [linhas, setLinhas] = useState<LinhaDaListagem[]>([]);
  const [procura, setProcura] = useState('');
  const [fim, setFim] = useState(false);
  const [aCarregar, setACarregar] = useState(false);

  const camposDeProcura = useMemo(
    () =>
      definicao
        ? collectFields(definicao)
            .filter((v) => v.field.searchable === true && v.repeatScope === undefined)
            .map((v) => v.field.id)
        : [],
    [definicao],
  );

  const carregar = useCallback(
    async (deslocamento: number, texto: string) => {
      if (aCarregar) return;
      setACarregar(true);
      try {
        const db = await abrirBaseLocal();
        const pagina = await listarRegistos(db, {
          formId,
          limite: PAGINA,
          deslocamento,
          ...(texto.trim() ? { procura: texto, camposDeProcura } : {}),
        });
        setLinhas((anteriores) => (deslocamento === 0 ? pagina : [...anteriores, ...pagina]));
        setFim(pagina.length < PAGINA);
      } finally {
        setACarregar(false);
      }
    },
    [formId, camposDeProcura, aCarregar],
  );

  useEffect(() => {
    void (async () => {
      const db = await abrirBaseLocal();
      setDefinicao(await lerDefinicaoCorrente(db, formId));
    })();
  }, [formId]);

  useEffect(() => {
    void carregar(0, procura);
    // A procura volta sempre ao início da lista.
  }, [procura, definicao]);

  const rotuloDe = useCallback(
    (linha: LinhaDaListagem): string => {
      const expressao = definicao?.settings?.record_label;
      if (!expressao) return linha.id.slice(0, 8);
      const valor = evaluate(expressao, makeContext(linha.dados));
      return valor === null || valor === undefined || valor === ''
        ? linha.id.slice(0, 8)
        : String(valor);
    },
    [definicao],
  );

  return (
    <View style={estilos.tudo}>
      <Stack.Screen options={{ title: definicao?.title?.pt ?? 'Registos' }} />
      {camposDeProcura.length > 0 ? (
        <TextInput
          style={estilos.procura}
          value={procura}
          onChangeText={setProcura}
          placeholder="procurar…"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      <FlatList
        data={linhas}
        keyExtractor={(l) => l.id}
        // A virtualização não é opcional com este volume de dados.
        initialNumToRender={20}
        windowSize={7}
        removeClippedSubviews
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (!fim && !aCarregar) void carregar(linhas.length, procura);
        }}
        ListEmptyComponent={
          <View style={estilos.centro}>
            <Text style={estilos.suave}>
              {procura ? 'Nada encontrado.' : 'Ainda não há registos recolhidos.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={estilos.linha}
            onPress={() => router.push(`/formulario/${formId}?recordId=${item.id}`)}
          >
            <View style={estilos.expandir}>
              <Text style={estilos.titulo}>{rotuloDe(item)}</Text>
              <Text style={estilos.suave}>
                {item.status} · {item.updated_at.slice(0, 16).replace('T', ' ')}
              </Text>
            </View>
            {/* Distinguir «gravado no telefone» de «seguro no servidor» é a
                informação mais importante desta lista para um técnico. */}
            <Text style={item.synced ? estilos.sincronizado : estilos.porSincronizar}>
              {item.synced ? '✓' : '↑'}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const estilos = StyleSheet.create({
  tudo: { flex: 1, backgroundColor: '#fff' },
  centro: { padding: 32, alignItems: 'center' },
  suave: { color: '#5b6470' },
  procura: {
    margin: 12,
    borderWidth: 1,
    borderColor: '#c7ced6',
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    fontSize: 16,
  },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eef1f4',
  },
  expandir: { flex: 1, gap: 2 },
  titulo: { fontSize: 16, fontWeight: '600' },
  sincronizado: { color: '#1a7f37', fontSize: 18 },
  porSincronizar: { color: '#8a5a00', fontSize: 18 },
});
