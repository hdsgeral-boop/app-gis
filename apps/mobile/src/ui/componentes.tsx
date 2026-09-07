import { useMemo } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { criarEstilosBase, espaco, useTema } from './tema';

/**
 * As peças de que todos os ecrãs são feitos.
 *
 * Existem para o layout ser decidido NUMA VEZ e não em cada ecrã. Antes disto,
 * cada ficheiro tinha o seu `StyleSheet.create` com os seus tons de cinzento,
 * e mudar uma cor era procurar por todo o lado — que é como uma app fica com
 * quatro azuis diferentes.
 *
 * Os ícones são texto (emoji e símbolos). É deliberado: uma biblioteca de
 * ícones são 2 a 4 MB no pacote, e o que se ganha num ecrã de 5 polegadas ao
 * sol não compensa — o que ali se lê é o tamanho e o contraste, não o desenho.
 */

export function useEstilos() {
  const tema = useTema();
  const estilos = useMemo(() => criarEstilosBase(tema), [tema]);
  return { tema, estilos };
}

/**
 * O botão do menu principal, em cápsula.
 *
 * `principal` pinta-o de azul: só um por ecrã, o que a pessoa vem fazer.
 * `contador` é o número à direita — quantos rascunhos, quantos por enviar. Um
 * técnico que vê «3» ao lado de «Por enviar» sabe o que tem em mãos sem tocar
 * em nada.
 */
export function BotaoCapsula({
  icone,
  texto,
  contador,
  principal = false,
  desactivado = false,
  aoTocar,
  estilo,
}: {
  icone: string;
  texto: string;
  contador?: number;
  principal?: boolean;
  desactivado?: boolean;
  aoTocar?: () => void;
  estilo?: StyleProp<ViewStyle>;
}) {
  const { tema, estilos } = useEstilos();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={contador !== undefined ? `${texto}, ${contador}` : texto}
      disabled={desactivado || !aoTocar}
      onPress={aoTocar}
      style={({ pressed }) => [
        estilos.capsula,
        principal && estilos.capsulaPrincipal,
        desactivado && estilos.capsulaInactiva,
        pressed && !principal && { backgroundColor: tema.superficiePressionada },
        pressed && principal && { opacity: 0.85 },
        estilo,
      ]}
    >
      <Text style={[estilos.capsulaTexto, principal && estilos.capsulaTextoPrincipal]}>
        {icone}
      </Text>
      <Text
        style={[estilos.capsulaTexto, principal && estilos.capsulaTextoPrincipal, { flex: 1 }]}
        numberOfLines={1}
      >
        {texto}
      </Text>
      {contador !== undefined && contador > 0 ? (
        <View
          style={{
            minWidth: 28,
            paddingHorizontal: espaco.s,
            paddingVertical: 2,
            borderRadius: 14,
            backgroundColor: principal ? tema.sobreRealce : tema.realce,
            alignItems: 'center',
          }}
        >
          <Text
            style={{
              color: principal ? tema.realce : tema.sobreRealce,
              fontWeight: '700',
              fontSize: 13,
            }}
          >
            {contador}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Uma linha de definições: ícone, título, e o valor actual por baixo.
 *
 * O valor por baixo é o que torna estes ecrãs úteis sem se tocar em nada — é
 * como o KoboCollect mostra «Fonte: Google» sem obrigar a abrir.
 */
export function LinhaDeDefinicao({
  icone,
  titulo,
  valor,
  aoTocar,
  perigo = false,
}: {
  icone: string;
  titulo: string;
  valor?: string;
  aoTocar?: () => void;
  perigo?: boolean;
}) {
  const { tema, estilos } = useEstilos();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!aoTocar}
      onPress={aoTocar}
      style={({ pressed }) => [
        estilos.linhaDeLista,
        pressed && { backgroundColor: tema.superficiePressionada },
      ]}
    >
      <Text style={{ fontSize: 22, width: 30, textAlign: 'center' }}>{icone}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[estilos.corpo, { fontWeight: '600' }, perigo && { color: tema.erro }]}>
          {titulo}
        </Text>
        {valor ? <Text style={estilos.suave}>{valor}</Text> : null}
      </View>
      {aoTocar ? <Text style={{ color: tema.textoSuave, fontSize: 20 }}>›</Text> : null}
    </Pressable>
  );
}

/** Cabeçalho de secção, a azul. */
export function Seccao({ children }: { children: string }) {
  const { estilos } = useEstilos();
  return <Text style={estilos.seccao}>{children.toUpperCase()}</Text>;
}

/**
 * O que se mostra quando não há nada.
 *
 * Ícone grande e esbatido, título a negrito, e uma frase que diz **o que fazer
 * para deixar de estar vazio**. Um ecrã vazio sem explicação lê-se como avaria.
 */
export function Vazio({ icone, titulo, texto }: { icone: string; titulo: string; texto: string }) {
  const { estilos } = useEstilos();
  return (
    <View style={estilos.vazio}>
      <Text style={estilos.vazioIcone}>{icone}</Text>
      <Text style={estilos.vazioTitulo}>{titulo}</Text>
      <Text style={estilos.vazioTexto}>{texto}</Text>
    </View>
  );
}

/**
 * A marca de estado de um registo.
 *
 * A cor e o símbolo dizem a mesma coisa duas vezes, de propósito: um técnico
 * com daltonismo — e são 8 % dos homens — não distingue o laranja do verde.
 */
export function MarcaDeEstado({
  estado,
}: {
  estado: 'rascunho' | 'por_enviar' | 'enviado' | 'needs_review';
}) {
  const { tema } = useEstilos();
  const mapa = {
    rascunho: { simbolo: '✎', cor: tema.textoSuave, rotulo: 'rascunho' },
    por_enviar: { simbolo: '⏳', cor: tema.aviso, rotulo: 'à espera de rede' },
    enviado: { simbolo: '✓', cor: tema.ok, rotulo: 'no servidor' },
    needs_review: { simbolo: '⚠', cor: tema.erro, rotulo: 'precisa de revisão' },
  } as const;
  const { simbolo, cor, rotulo } = mapa[estado];
  return (
    <Text accessibilityLabel={rotulo} style={{ color: cor, fontSize: 18, fontWeight: '700' }}>
      {simbolo}
    </Text>
  );
}
