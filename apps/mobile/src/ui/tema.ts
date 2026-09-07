import { StyleSheet, useColorScheme } from 'react-native';

/**
 * O tema da app.
 *
 * SEGUE O SISTEMA, e é uma decisão sobre o terreno e não sobre gosto: um
 * técnico ao sol de Luanda às onze da manhã não lê um ecrã escuro, e às seis
 * da manhã dentro de um posto de transformação não quer um ecrã branco na
 * cara. Quem decide é o telefone, que é onde a pessoa já configurou isso uma
 * vez.
 *
 * AS CORES SÃO POUCAS DE PROPÓSITO. Sete tokens chegam para toda a app. Uma
 * paleta com quarenta tons é uma paleta que ninguém consegue manter coerente,
 * e num ecrã de 5 polegadas ao sol metade deles não se distinguem.
 *
 * O AZUL É O ÚNICO REALCE. É a cor do que se toca e do que se está a fazer.
 * O laranja e o vermelho estão reservados a duas coisas, e só a essas: a
 * precisão acima do limiar, e o que ainda não está seguro no servidor. Se
 * tudo grita, nada grita.
 */

export interface Tema {
  escuro: boolean;
  /** Fundo do ecrã. */
  fundo: string;
  /** Fundo de um cartão ou botão secundário, um degrau acima do fundo. */
  superficie: string;
  /** O mesmo, quando está a ser tocado. */
  superficiePressionada: string;
  texto: string;
  textoSuave: string;
  realce: string;
  /** Texto por cima do realce. */
  sobreRealce: string;
  borda: string;
  aviso: string;
  erro: string;
  ok: string;
}

const CLARO: Tema = {
  escuro: false,
  fundo: '#f4f6f8',
  superficie: '#ffffff',
  superficiePressionada: '#e8ecf0',
  texto: '#12181f',
  textoSuave: '#5b6470',
  realce: '#10508a',
  sobreRealce: '#ffffff',
  borda: '#d9dee4',
  aviso: '#8a5a00',
  erro: '#b3261e',
  ok: '#1e7a3c',
};

/**
 * O escuro não é o claro invertido.
 *
 * O fundo é quase preto com um toque de azul (`#0b1116`), como no KoboCollect:
 * um preto puro num ecrã OLED faz o texto branco «sangrar» nas bordas, e um
 * cinzento neutro parece sujo. O realce é mais claro do que no tema claro
 * porque um azul escuro sobre fundo escuro não tem contraste que chegue.
 */
const ESCURO: Tema = {
  escuro: true,
  fundo: '#0b1116',
  superficie: '#1a2027',
  superficiePressionada: '#242c35',
  texto: '#e9ecef',
  textoSuave: '#9aa3ae',
  realce: '#4db1f0',
  sobreRealce: '#08121a',
  borda: '#2a323b',
  aviso: '#e0a63a',
  erro: '#f2837a',
  ok: '#5ec27f',
};

export function useTema(): Tema {
  return useColorScheme() === 'dark' ? ESCURO : CLARO;
}

/** Para código que não é um componente e por isso não pode usar hooks. */
export function temaDe(escuro: boolean): Tema {
  return escuro ? ESCURO : CLARO;
}

/**
 * Espaçamentos.
 *
 * Múltiplos de 4. Um alvo de toque nunca abaixo de 48 px: é a recomendação do
 * Android e é o que separa um botão que se acerta com luvas de um que não.
 */
export const espaco = {
  xs: 4,
  s: 8,
  m: 12,
  l: 16,
  xl: 24,
  xxl: 32,
  /** Altura mínima de qualquer coisa que se toque. */
  toque: 48,
} as const;

export const raio = {
  /** Cartões e campos. */
  m: 12,
  /** Botões em cápsula, como no KoboCollect. */
  capsula: 28,
} as const;

/**
 * Estilos que aparecem em todos os ecrãs.
 *
 * Uma função e não um objecto porque dependem do tema, e recriar isto a cada
 * render de cada ecrã seria trabalho a mais num telefone de gama baixa — daí
 * o `useEstilos` fazer cache por tema.
 */
export function criarEstilosBase(t: Tema) {
  return StyleSheet.create({
    ecra: { flex: 1, backgroundColor: t.fundo },
    conteudo: { padding: espaco.l, gap: espaco.m },

    // ── Tipografia ────────────────────────────────────────────────────────
    titulo: { fontSize: 24, fontWeight: '700', color: t.texto },
    subtitulo: { fontSize: 17, fontWeight: '600', color: t.texto },
    corpo: { fontSize: 15, color: t.texto, lineHeight: 21 },
    suave: { fontSize: 13, color: t.textoSuave, lineHeight: 18 },
    mono: { fontFamily: 'monospace', fontSize: 14, color: t.texto },

    /** Cabeçalho de secção, a azul, como nas definições do KoboCollect. */
    seccao: {
      fontSize: 13,
      fontWeight: '600',
      color: t.realce,
      marginTop: espaco.l,
      marginBottom: espaco.xs,
    },

    // ── Botões em cápsula ─────────────────────────────────────────────────
    /**
     * O botão do menu principal. Alto, largo e redondo — é o que se toca com
     * luvas, de pé, com uma mão a segurar um receptor.
     */
    capsula: {
      minHeight: 56,
      borderRadius: raio.capsula,
      backgroundColor: t.superficie,
      paddingHorizontal: espaco.xl,
      flexDirection: 'row',
      alignItems: 'center',
      gap: espaco.l,
    },
    capsulaPrincipal: { backgroundColor: t.realce },
    capsulaTexto: { fontSize: 17, color: t.texto, fontWeight: '500' },
    capsulaTextoPrincipal: { color: t.sobreRealce, fontWeight: '600' },
    capsulaInactiva: { opacity: 0.45 },

    // ── Cartões e listas ──────────────────────────────────────────────────
    cartao: {
      backgroundColor: t.superficie,
      borderRadius: raio.m,
      padding: espaco.l,
      gap: espaco.s,
    },
    linhaDeLista: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: espaco.m,
      paddingVertical: espaco.m,
      paddingHorizontal: espaco.l,
      minHeight: espaco.toque + 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.borda,
    },

    // ── Estado vazio ──────────────────────────────────────────────────────
    /** Ícone grande, título a negrito, explicação por baixo. */
    vazio: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: espaco.xl,
      gap: espaco.m,
    },
    vazioIcone: { fontSize: 64, color: t.textoSuave, opacity: 0.5 },
    vazioTitulo: { fontSize: 17, fontWeight: '700', color: t.textoSuave, textAlign: 'center' },
    vazioTexto: { fontSize: 15, color: t.textoSuave, textAlign: 'center', lineHeight: 22 },

    // ── Campos ────────────────────────────────────────────────────────────
    entrada: {
      minHeight: espaco.toque,
      borderWidth: 1,
      borderColor: t.borda,
      borderRadius: raio.m,
      paddingHorizontal: espaco.m,
      paddingVertical: espaco.s + 2,
      fontSize: 16,
      color: t.texto,
      backgroundColor: t.superficie,
    },

    aviso: { color: t.aviso, fontSize: 13, fontWeight: '600' },
    erro: { color: t.erro, fontSize: 13 },
  });
}
