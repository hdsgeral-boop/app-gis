import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type {
  Choice,
  Field,
  GeopointValue,
  SelectMultipleField,
  SelectOneField,
} from '@cvforms/form-core';
import { evaluateBoolean, makeContext } from '@cvforms/form-core';

import { texto, type EstadoFormulario } from '@/forms/estado';

/**
 * Os widgets, um por família de tipo (F3.2 e F3.3).
 *
 * Nenhum destes componentes conhece nenhum formulário concreto: recebem um
 * campo e um valor e desenham-se a partir do tipo. É o que permite publicar um
 * formulário novo sem tocar em código móvel (restrição inegociável 6).
 */

export interface PropsDeCampo {
  campo: Field;
  caminho: string;
  valor: unknown;
  estado: EstadoFormulario;
  erros: string[];
  editavel: boolean;
  aoMudar(valor: unknown): void;
  aoSair(): void;
}

export function Rotulo({ campo, estado }: { campo: Field; estado: EstadoFormulario }) {
  const rotulo = texto(campo.label, estado.idioma, campo.name);
  const dica = campo.hint ? texto(campo.hint, estado.idioma, '') : undefined;
  return (
    <View style={estilos.cabecalho}>
      <Text style={estilos.rotulo}>
        {rotulo}
        {campo.required ? <Text style={estilos.obrigatorio}> *</Text> : null}
      </Text>
      {dica ? <Text style={estilos.dica}>{dica}</Text> : null}
    </View>
  );
}

export function Erros({ mensagens }: { mensagens: string[] }) {
  if (mensagens.length === 0) return null;
  return (
    <View style={estilos.erros}>
      {mensagens.map((m, i) => (
        <Text key={i} style={estilos.erro}>
          {m}
        </Text>
      ))}
    </View>
  );
}

// ── Texto, número, código de barras ─────────────────────────────────────────

export function CampoTexto(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, aoSair, erros } = props;
  const multilinha = campo.type === 'text' && campo.multiline === true;
  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={props.estado} />
      <TextInput
        style={[estilos.entrada, multilinha && estilos.entradaAlta, !editavel && estilos.bloqueada]}
        value={valor === null || valor === undefined ? '' : String(valor)}
        onChangeText={(t) => aoMudar(t === '' ? null : t)}
        onBlur={aoSair}
        editable={editavel}
        multiline={multilinha}
        maxLength={campo.type === 'text' ? campo.max_length : undefined}
        autoCapitalize={campo.type === 'barcode' ? 'characters' : 'sentences'}
        placeholder={campo.appearance === 'placeholder' ? campo.name : undefined}
      />
      <Erros mensagens={erros} />
    </View>
  );
}

export function CampoNumero(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, aoSair, erros } = props;
  const inteiro = campo.type === 'integer';
  // O texto que o técnico está a escrever vive à parte do valor: enquanto ele
  // escreve «-» ou «12,», não há número nenhum, e substituir-lhe o que escreveu
  // por um número «arranjado» a meio da escrita é a forma mais rápida de o
  // fazer desistir.
  const [emEdicao, setEmEdicao] = useState<string>();
  const mostrado = emEdicao ?? (valor === null || valor === undefined ? '' : String(valor));

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={props.estado} />
      <TextInput
        style={[estilos.entrada, !editavel && estilos.bloqueada]}
        value={mostrado}
        keyboardType={inteiro ? 'number-pad' : 'decimal-pad'}
        editable={editavel}
        onChangeText={(t) => {
          const limpo = t.replace(',', '.');
          setEmEdicao(limpo);
          if (limpo.trim() === '') return aoMudar(null);
          const numero = Number(limpo);
          if (Number.isFinite(numero)) aoMudar(inteiro ? Math.trunc(numero) : numero);
        }}
        onBlur={() => {
          setEmEdicao(undefined);
          aoSair();
        }}
      />
      <Erros mensagens={erros} />
    </View>
  );
}

export function CampoBooleano(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, erros } = props;
  return (
    <View style={[estilos.campo, estilos.linha]}>
      <View style={estilos.expandir}>
        <Rotulo campo={campo} estado={props.estado} />
        <Erros mensagens={erros} />
      </View>
      <Switch
        value={valor === true}
        disabled={!editavel}
        onValueChange={(v) => {
          aoMudar(v);
          props.aoSair();
        }}
      />
    </View>
  );
}

// ── Datas ───────────────────────────────────────────────────────────────────

/**
 * Data, hora e instante.
 *
 * Sem selector nativo por enquanto: acrescentá-lo obriga a uma dependência
 * nativa e a um dev build novo. Há um botão «hoje»/«agora», que é o que cobre
 * a esmagadora maioria dos preenchimentos em campo, e o formato é validado
 * pelo `form-core` como qualquer outro campo. Ver PLANO.md, dívida da F3.
 */
export function CampoData(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, aoSair, erros } = props;
  const tipo = campo.type;

  const agora = (): string => {
    const d = new Date();
    if (tipo === 'date') return d.toISOString().slice(0, 10);
    if (tipo === 'time') return d.toISOString().slice(11, 16);
    return d.toISOString();
  };
  const exemplo =
    tipo === 'date' ? 'AAAA-MM-DD' : tipo === 'time' ? 'HH:MM' : 'AAAA-MM-DDTHH:MM:SSZ';

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={props.estado} />
      <View style={estilos.linha}>
        <TextInput
          style={[estilos.entrada, estilos.expandir, !editavel && estilos.bloqueada]}
          value={valor === null || valor === undefined ? '' : String(valor)}
          onChangeText={(t) => aoMudar(t === '' ? null : t)}
          onBlur={aoSair}
          editable={editavel}
          placeholder={exemplo}
          autoCapitalize="none"
        />
        {editavel ? (
          <Pressable
            style={estilos.botaoPequeno}
            onPress={() => {
              aoMudar(agora());
              aoSair();
            }}
          >
            <Text style={estilos.botaoPequenoTexto}>{tipo === 'time' ? 'agora' : 'hoje'}</Text>
          </Pressable>
        ) : null}
      </View>
      <Erros mensagens={erros} />
    </View>
  );
}

// ── Escolhas ────────────────────────────────────────────────────────────────

/**
 * Opções visíveis de uma lista.
 *
 * Uma opção com `relevant` só aparece quando a expressão for verdadeira — é
 * assim que se fazem as cascatas (província → município) sem código nenhum
 * específico do formulário.
 */
function opcoesVisiveis(
  estado: EstadoFormulario,
  campo: SelectOneField | SelectMultipleField,
): Choice[] {
  const lista = estado.definicao.choice_lists?.[campo.choices_ref] ?? [];
  const ctx = makeContext(estado.dados, estado.agora ? { now: estado.agora } : {});
  return lista.filter((opcao) => !opcao.relevant || evaluateBoolean(opcao.relevant, ctx));
}

export function CampoEscolhaUnica(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, erros, estado } = props;
  // O `useMemo` vem antes do desvio de propósito: um hook chamado só às vezes
  // parte o React, e a regra não abre excepções nem para um `return null`.
  const opcoes = useMemo(
    () => (campo.type === 'select_one' ? opcoesVisiveis(estado, campo) : []),
    [estado.revisao, campo.id],
  );
  if (campo.type !== 'select_one') return null;
  const foraDaLista =
    campo.allow_other === true &&
    typeof valor === 'string' &&
    valor !== '' &&
    !opcoes.some((o) => o.value === valor);

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={estado} />
      <View style={campo.appearance === 'horizontal' ? estilos.opcoesHorizontais : undefined}>
        {opcoes.map((opcao) => {
          const escolhida = valor === opcao.value;
          return (
            <Pressable
              key={opcao.value}
              style={[estilos.opcao, escolhida && estilos.opcaoEscolhida]}
              disabled={!editavel}
              onPress={() => {
                // Tocar na opção já escolhida limpa-a: sem isto, um técnico que
                // se engane num campo não obrigatório não tem como voltar atrás.
                aoMudar(escolhida ? null : opcao.value);
                props.aoSair();
              }}
            >
              <Text style={[estilos.opcaoTexto, escolhida && estilos.opcaoTextoEscolhido]}>
                {texto(opcao.label, estado.idioma, opcao.value)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {campo.allow_other ? (
        <TextInput
          style={estilos.entrada}
          placeholder="outro…"
          value={foraDaLista ? String(valor) : ''}
          editable={editavel}
          onChangeText={(t) => aoMudar(t === '' ? null : t)}
          onBlur={props.aoSair}
        />
      ) : null}
      <Erros mensagens={erros} />
    </View>
  );
}

export function CampoEscolhaMultipla(props: PropsDeCampo) {
  const { campo, valor, editavel, aoMudar, erros, estado } = props;
  const opcoes = useMemo(
    () => (campo.type === 'select_multiple' ? opcoesVisiveis(estado, campo) : []),
    [estado.revisao, campo.id],
  );
  if (campo.type !== 'select_multiple') return null;
  const escolhidas = Array.isArray(valor) ? (valor as string[]) : [];

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={estado} />
      <View style={campo.appearance === 'horizontal' ? estilos.opcoesHorizontais : undefined}>
        {opcoes.map((opcao) => {
          const escolhida = escolhidas.includes(opcao.value);
          return (
            <Pressable
              key={opcao.value}
              style={[estilos.opcao, escolhida && estilos.opcaoEscolhida]}
              disabled={!editavel}
              onPress={() => {
                const proximas = escolhida
                  ? escolhidas.filter((v) => v !== opcao.value)
                  : [...escolhidas, opcao.value];
                aoMudar(proximas);
                props.aoSair();
              }}
            >
              <Text style={[estilos.opcaoTexto, escolhida && estilos.opcaoTextoEscolhido]}>
                {escolhida ? '☑ ' : '☐ '}
                {texto(opcao.label, estado.idioma, opcao.value)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Erros mensagens={erros} />
    </View>
  );
}

// ── Geometria ───────────────────────────────────────────────────────────────

/**
 * Fonte de um ponto. A implementação com GNSS a sério — GPS interno, NMEA
 * sobre TCP, receptor externo — é a F7; esta abstracção existe já para o
 * renderizador não ter de mudar quando ela chegar (PLANO.md F7.1).
 */
export interface FonteDeLocalizacao {
  nome: string;
  obter(): Promise<GeopointValue>;
}

export function CampoGeoponto(
  props: PropsDeCampo & {
    fonte?: FonteDeLocalizacao;
    /** Justificação já escrita para este registo, se houver (F7.8). */
    justificacao?: string;
    aoJustificar?: (texto: string) => void;
  },
) {
  const { campo, valor, editavel, aoMudar, erros, estado, fonte } = props;
  const [aLer, setALer] = useState(false);
  const [falha, setFalha] = useState<string>();
  const ponto = (valor ?? null) as GeopointValue | null;

  const limiar =
    (campo.type === 'geopoint' ? campo.max_accuracy_m : undefined) ??
    estado.definicao.settings?.max_accuracy_m;
  const acimaDoLimiar = !!ponto && limiar !== undefined && ponto.accuracy_m > limiar;

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={estado} />
      {ponto ? (
        <View style={estilos.caixa}>
          <Text style={estilos.mono}>
            {ponto.lat.toFixed(6)}, {ponto.lon.toFixed(6)}
          </Text>
          {/* A precisão e a origem estão sempre à vista (ESPECIFICACAO §11). */}
          <Text style={[estilos.dica, acimaDoLimiar && estilos.avisoForte]}>
            ±{ponto.accuracy_m.toFixed(2)} m · {ponto.fix_type} · {ponto.source}
            {acimaDoLimiar ? `  (acima do limiar de ${limiar} m)` : ''}
          </Text>
        </View>
      ) : (
        <Text style={estilos.dica}>ainda sem posição</Text>
      )}

      {editavel && fonte ? (
        <Pressable
          style={estilos.botao}
          disabled={aLer}
          onPress={async () => {
            setALer(true);
            setFalha(undefined);
            try {
              aoMudar(await fonte.obter());
              props.aoSair();
            } catch (e) {
              setFalha(e instanceof Error ? e.message : String(e));
            } finally {
              setALer(false);
            }
          }}
        >
          <Text style={estilos.botaoTexto}>
            {aLer ? 'a obter posição…' : `obter posição (${fonte.nome})`}
          </Text>
        </Pressable>
      ) : null}
      {!fonte ? <Text style={estilos.dica}>sem fonte de localização configurada</Text> : null}
      {falha ? <Text style={estilos.erro}>{falha}</Text> : null}

      {/*
        F7.8 — acima do limiar, grava-se com justificação escrita.
        Nunca se recusa a gravação: mandar o técnico embora sem o registo é o
        pior desfecho possível. O que se pede é que fique escrito porquê, e é
        isso que o relatório de qualidade da F10.5 vai ler.
      */}
      {acimaDoLimiar && editavel && props.aoJustificar ? (
        <View style={estilos.caixa}>
          <Text style={estilos.avisoForte}>
            Precisão de {ponto!.accuracy_m.toFixed(2)} m, acima do limiar de {limiar} m. Podes
            gravar, mas escreve porquê.
          </Text>
          <TextInput
            style={estilos.entrada}
            multiline
            value={props.justificacao ?? ''}
            onChangeText={props.aoJustificar}
            onBlur={props.aoSair}
            placeholder="ex.: sem céu aberto, junto ao muro do PT"
            editable={editavel}
          />
        </View>
      ) : null}

      <Erros mensagens={erros} />
    </View>
  );
}

// ── Nota, calculado, anexos ────────────────────────────────────────────────

export function CampoNota({ campo, estado }: PropsDeCampo) {
  return (
    <View style={estilos.nota}>
      <Text style={estilos.notaTexto}>{texto(campo.label, estado.idioma, '')}</Text>
    </View>
  );
}

export function CampoCalculado(props: PropsDeCampo) {
  const { campo, valor, estado } = props;
  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={estado} />
      <View style={estilos.caixa}>
        <Text style={estilos.mono}>
          {valor === null || valor === undefined ? '—' : String(valor)}
        </Text>
      </View>
      <Erros mensagens={props.erros} />
    </View>
  );
}

/**
 * Anexos. A captura, o redimensionamento e a fila de upload são a F9; aqui
 * mostra-se o que já está preso ao registo e diz-se o que falta, em vez de um
 * botão que não faz nada.
 */
/**
 * Um anexo já preparado e pronto a entrar na fila.
 *
 * O que fica no valor do campo é o `id` do anexo, e não o caminho do ficheiro:
 * o caminho local muda quando o Android limpa a cache, e o `id` é o que o
 * servidor conhece.
 */
export interface CapturaDeAnexo {
  (campo: Field): Promise<{ id: string; uri: string; bytes: number } | undefined>;
}

export function CampoAnexo(props: PropsDeCampo & { capturar?: CapturaDeAnexo }) {
  const { campo, valor, estado, editavel, aoMudar, capturar } = props;
  const [aTirar, setATirar] = useState(false);
  const [falha, setFalha] = useState<string>();

  const ids = Array.isArray(valor) ? (valor as string[]) : valor ? [valor as string] : [];
  const limite = campo.type === 'photo' ? (campo.max_count ?? 0) : 0;
  const noMaximo = limite > 0 && ids.length >= limite;

  return (
    <View style={estilos.campo}>
      <Rotulo campo={campo} estado={estado} />

      {ids.length === 0 ? (
        <Text style={estilos.dica}>sem anexos</Text>
      ) : (
        <View style={estilos.caixa}>
          {ids.map((id, i) => (
            <View key={id} style={estilos.linhaDeAnexo}>
              <Text style={estilos.mono}>
                {i + 1}. {id.slice(0, 8)}
              </Text>
              {editavel ? (
                <Pressable onPress={() => aoMudar(ids.filter((outro) => outro !== id))} hitSlop={8}>
                  <Text style={estilos.remover}>remover</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {editavel && capturar ? (
        <Pressable
          style={[estilos.botao, (aTirar || noMaximo) && estilos.botaoInactivo]}
          disabled={aTirar || noMaximo}
          onPress={async () => {
            setATirar(true);
            setFalha(undefined);
            try {
              const anexo = await capturar(campo);
              // `undefined` é o técnico ter cancelado. Cancelar não é um erro e
              // não deve aparecer como um.
              if (anexo) aoMudar([...ids, anexo.id]);
            } catch (e) {
              setFalha(e instanceof Error ? e.message : String(e));
            } finally {
              setATirar(false);
            }
          }}
        >
          <Text style={estilos.botaoTexto}>
            {aTirar ? 'a preparar…' : noMaximo ? `máximo de ${limite}` : 'tirar fotografia'}
          </Text>
        </Pressable>
      ) : null}

      {!capturar ? <Text style={estilos.dica}>captura não disponível neste ecrã</Text> : null}
      {falha ? <Text style={estilos.erro}>{falha}</Text> : null}
      <Erros mensagens={props.erros} />
    </View>
  );
}

export const estilos = StyleSheet.create({
  campo: { gap: 6, paddingVertical: 10 },
  linhaDeAnexo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  remover: { color: '#b3261e', fontSize: 13 },
  botaoInactivo: { opacity: 0.5 },
  cabecalho: { gap: 2 },
  rotulo: { fontSize: 15, fontWeight: '600', color: '#12181f' },
  obrigatorio: { color: '#b3261e' },
  dica: { fontSize: 13, color: '#5b6470' },
  avisoForte: { color: '#8a5a00', fontWeight: '600' },
  entrada: {
    borderWidth: 1,
    borderColor: '#c7ced6',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
    minHeight: 44,
  },
  entradaAlta: { minHeight: 96, textAlignVertical: 'top' },
  bloqueada: { backgroundColor: '#f1f3f5', color: '#5b6470' },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  expandir: { flex: 1 },
  erros: { gap: 2 },
  erro: { color: '#b3261e', fontSize: 13 },
  opcoesHorizontais: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcao: {
    borderWidth: 1,
    borderColor: '#c7ced6',
    borderRadius: 8,
    paddingHorizontal: 12,
    // 44 pontos de altura mínima: é o alvo de toque que uma mão com luvas
    // acerta num telefone de gama baixa ao sol.
    minHeight: 44,
    justifyContent: 'center',
    marginVertical: 3,
    backgroundColor: '#fff',
  },
  opcaoEscolhida: { borderColor: '#0b6bcb', backgroundColor: '#e8f1fc' },
  opcaoTexto: { fontSize: 16, color: '#12181f' },
  opcaoTextoEscolhido: { fontWeight: '600', color: '#0b4f8a' },
  caixa: {
    borderWidth: 1,
    borderColor: '#e0e5ea',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#f7f9fb',
    gap: 4,
  },
  mono: { fontSize: 15, fontVariant: ['tabular-nums'] },
  nota: {
    backgroundColor: '#fff8e1',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  notaTexto: { fontSize: 15, color: '#4a3c00' },
  botao: {
    backgroundColor: '#0b6bcb',
    borderRadius: 8,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  botaoTexto: { color: '#fff', fontSize: 16, fontWeight: '600' },
  botaoPequeno: {
    borderWidth: 1,
    borderColor: '#0b6bcb',
    borderRadius: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  botaoPequenoTexto: { color: '#0b6bcb', fontWeight: '600' },
});
