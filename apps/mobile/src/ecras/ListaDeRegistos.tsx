import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { abrirBaseLocal } from '@/db/local';
import { listarRegistos, type LinhaDaListagem } from '@/dados/registos';
import {
  camposPesquisaveis,
  listarFormulariosLocais,
  type FormularioLocal,
} from '@/forms/definicoes';
import { MarcaDeEstado, Vazio, useEstilos } from '@/ui/componentes';
import { espaco } from '@/ui/tema';

/**
 * A lista de registos, filtrada por estado.
 *
 * Um componente para os três ecrãs — Rascunhos, Por enviar, Enviados — porque
 * são o mesmo ecrã com um filtro diferente. Três ficheiros quase iguais é
 * três sítios onde a procura passa a funcionar de maneira diferente.
 *
 * A PROCURA está sempre à cabeça. É a operação que um técnico faz mais vezes
 * por dia — «já registei este contador?» — e é a que decide se ele repete uma
 * visita ou não.
 */

export type FiltroDeEcra = 'rascunhos' | 'por_enviar' | 'enviados';

const CONFIG: Record<
  FiltroDeEcra,
  { titulo: string; icone: string; vazioTitulo: string; vazioTexto: string }
> = {
  rascunhos: {
    titulo: 'Rascunhos',
    icone: '✎',
    vazioTitulo: 'Não há rascunhos',
    vazioTexto: 'O que guardares sem submeter aparece aqui, e fica à tua espera.',
  },
  por_enviar: {
    titulo: 'Por enviar',
    icone: '➤',
    vazioTitulo: 'Não há nada por enviar',
    vazioTexto: 'Está tudo no servidor. Podes entregar o telefone com segurança.',
  },
  enviados: {
    titulo: 'Enviados',
    icone: '✓',
    vazioTitulo: 'Ainda não enviaste nada',
    vazioTexto: 'Os registos que chegarem ao servidor aparecem aqui.',
  },
};

export function ListaDeRegistos({ filtro }: { filtro: FiltroDeEcra }) {
  const router = useRouter();
  const { tema, estilos } = useEstilos();
  const config = CONFIG[filtro];

  const [linhas, setLinhas] = useState<LinhaDaListagem[]>([]);
  const [formularios, setFormularios] = useState<FormularioLocal[]>([]);
  const [procura, setProcura] = useState('');
  const [ocupado, setOcupado] = useState(true);

  const carregar = useCallback(async () => {
    const db = await abrirBaseLocal();
    const locais = await listarFormulariosLocais(db);
    setFormularios(locais);

    // Os campos pesquisáveis vêm das definições, nunca de uma lista escrita à
    // mão: acrescentar um `searchable` no painel passa a indexar sem tocar em
    // código móvel.
    const camposDeProcura = await camposPesquisaveis(db);

    const todas = await listarRegistos(db, {
      ...(procura.trim() ? { procura: procura.trim(), camposDeProcura } : {}),
      limite: 200,
    });

    setLinhas(
      todas.filter((l) => {
        if (filtro === 'rascunhos') return l.status === 'rascunho';
        if (filtro === 'por_enviar') return !l.synced && l.status !== 'rascunho';
        return l.synced;
      }),
    );
  }, [filtro, procura]);

  useEffect(() => {
    setOcupado(true);
    void carregar().finally(() => setOcupado(false));
  }, [carregar]);

  const titulo = (formId: string) =>
    formularios.find((f) => f.id === formId)?.titulo?.pt ?? 'formulário';

  return (
    <View style={estilos.ecra}>
      <Stack.Screen options={{ title: config.titulo }} />

      <View style={{ padding: espaco.l, paddingBottom: espaco.s }}>
        <TextInput
          style={estilos.entrada}
          value={procura}
          onChangeText={setProcura}
          placeholder="Procurar por código ou nome"
          placeholderTextColor={tema.textoSuave}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {ocupado ? (
        <View style={{ padding: espaco.xl }}>
          <ActivityIndicator color={tema.realce} />
        </View>
      ) : linhas.length === 0 ? (
        <Vazio
          icone={config.icone}
          titulo={procura ? 'Nada encontrado' : config.vazioTitulo}
          texto={
            procura
              ? 'Nenhum registo tem esse código. Se sabes que existe, pode ter sido recolhido antes de esse campo passar a ser pesquisável — avisa quem administra.'
              : config.vazioTexto
          }
        />
      ) : (
        <FlatList
          data={linhas}
          keyExtractor={(l) => l.id}
          // Sem isto, 30 000 registos num Android de gama baixa enchem a
          // memória antes de o primeiro aparecer.
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item }) => (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/formulario/[formId]',
                  params: { formId: item.form_id, recordId: item.id },
                })
              }
              style={({ pressed }) => [
                estilos.linhaDeLista,
                pressed && { backgroundColor: tema.superficiePressionada },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[estilos.corpo, { fontWeight: '600' }]} numberOfLines={1}>
                  {rotuloDoRegisto(item)}
                </Text>
                <Text style={estilos.suave} numberOfLines={1}>
                  {titulo(item.form_id)} · {quando(item.updated_at)}
                </Text>
              </View>
              <MarcaDeEstado
                estado={
                  item.status === 'needs_review'
                    ? 'needs_review'
                    : item.status === 'rascunho'
                      ? 'rascunho'
                      : item.synced
                        ? 'enviado'
                        : 'por_enviar'
                }
              />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

/**
 * O que se lê na lista.
 *
 * A primeira resposta de texto que o registo tiver — normalmente o código ou o
 * nome do local. Sem isso, o `id` truncado: feio, mas identifica. Mostrar o
 * `id` inteiro seria uma linha de 36 caracteres que não cabe.
 */
function rotuloDoRegisto(linha: LinhaDaListagem): string {
  for (const valor of Object.values(linha.dados)) {
    if (typeof valor === 'string' && valor.trim()) return valor.trim();
    if (typeof valor === 'number') return String(valor);
  }
  return `registo ${linha.id.slice(0, 8)}`;
}

/**
 * «hoje às 14:32», «ontem», ou a data.
 *
 * Um carimbo ISO não diz nada a quem está no terreno. O que interessa é se foi
 * hoje.
 */
function quando(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const mesmoDia = data.toDateString() === agora.toDateString();
  if (mesmoDia) {
    return `hoje às ${data.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const ontem = new Date(agora);
  ontem.setDate(agora.getDate() - 1);
  if (data.toDateString() === ontem.toDateString()) return 'ontem';
  return data.toLocaleDateString('pt-PT');
}
