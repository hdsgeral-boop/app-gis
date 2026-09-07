import { Fragment, useCallback, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Field } from '@cvforms/form-core';

import {
  CampoAnexo,
  CampoBooleano,
  CampoCalculado,
  CampoData,
  CampoEscolhaMultipla,
  CampoEscolhaUnica,
  CampoGeoponto,
  CampoNota,
  CampoNumero,
  CampoTexto,
  type CapturaDeAnexo,
  type FonteDeLocalizacao,
  type PropsDeCampo,
} from './campos';
import {
  acrescentarInstancia,
  eRelevante,
  errosPorSeccao,
  errosVisiveis,
  irParaSeccao,
  marcarTocado,
  moverInstancia,
  removerInstancia,
  rotulosDasInstancias,
  texto,
  valorEm,
  definirValor,
  type EstadoFormulario,
} from '@/forms/estado';

/**
 * O renderizador (F3).
 *
 * Pega numa definição em JSON e constrói o ecrã. Nunca foi compilado a pensar
 * em nenhum formulário concreto, e é isso que faz a plataforma ser uma
 * plataforma: publicar um formulário novo no painel não implica publicar uma
 * versão nova da app (ESPECIFICACAO §1).
 */

export interface PropsFormulario {
  estado: EstadoFormulario;
  aoMudarEstado(estado: EstadoFormulario): void;
  editavel?: boolean;
  fonteDeLocalizacao?: FonteDeLocalizacao;
  /**
   * Justificação escrita para um ponto acima do limiar (F7.8). Vive no ecrã e
   * não no estado do formulário porque não é uma resposta: é um dado sobre a
   * recolha, e fica na revisão, não no JSONB das respostas.
   */
  justificacaoDePrecisao?: string;
  aoJustificar?: (texto: string) => void;
  /** Abre a câmara e prepara o anexo (F9.1). Sem isto, o campo é só de leitura. */
  capturarAnexo?: CapturaDeAnexo;
}

export function Formulario({
  estado,
  aoMudarEstado,
  editavel = true,
  fonteDeLocalizacao,
  justificacaoDePrecisao,
  aoJustificar,
  capturarAnexo,
}: PropsFormulario) {
  const seccao = estado.seccoes[estado.seccaoActual];
  const errosDeSeccao = useMemo(() => errosPorSeccao(estado), [estado.revisao]);

  const mudar = useCallback(
    (caminho: string, valor: unknown) => aoMudarEstado(definirValor(estado, caminho, valor)),
    [estado, aoMudarEstado],
  );
  const sair = useCallback(
    (caminho: string) => aoMudarEstado(marcarTocado(estado, caminho)),
    [estado, aoMudarEstado],
  );

  return (
    <View style={estilos.tudo}>
      {estado.seccoes.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={estilos.abas}
          contentContainerStyle={estilos.abasConteudo}
        >
          {estado.seccoes.map((s, i) => {
            const activa = i === estado.seccaoActual;
            const erros = errosDeSeccao[i] ?? 0;
            return (
              <Pressable
                key={s.id ?? `solta-${i}`}
                style={[estilos.aba, activa && estilos.abaActiva]}
                onPress={() => aoMudarEstado(irParaSeccao(estado, i))}
              >
                <Text style={[estilos.abaTexto, activa && estilos.abaTextoActivo]}>
                  {s.titulo}
                  {erros > 0 && estado.mostrarTodosOsErros ? ` (${erros})` : ''}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <ScrollView
        style={estilos.corpo}
        contentContainerStyle={estilos.corpoConteudo}
        keyboardShouldPersistTaps="handled"
      >
        <ListaDeCampos
          campos={seccao?.campos ?? []}
          prefixo=""
          estado={estado}
          aoMudarEstado={aoMudarEstado}
          editavel={editavel}
          mudar={mudar}
          sair={sair}
          {...(fonteDeLocalizacao ? { fonteDeLocalizacao } : {})}
          {...(justificacaoDePrecisao !== undefined ? { justificacaoDePrecisao } : {})}
          {...(aoJustificar ? { aoJustificar } : {})}
          {...(capturarAnexo ? { capturarAnexo } : {})}
        />
      </ScrollView>

      {estado.seccoes.length > 1 ? (
        <View style={estilos.rodape}>
          <Pressable
            style={[estilos.navegar, estado.seccaoActual === 0 && estilos.desactivado]}
            disabled={estado.seccaoActual === 0}
            onPress={() => aoMudarEstado(irParaSeccao(estado, estado.seccaoActual - 1))}
          >
            <Text style={estilos.navegarTexto}>anterior</Text>
          </Pressable>
          <Text style={estilos.contador}>
            {estado.seccaoActual + 1} / {estado.seccoes.length}
          </Text>
          <Pressable
            style={[
              estilos.navegar,
              estado.seccaoActual === estado.seccoes.length - 1 && estilos.desactivado,
            ]}
            disabled={estado.seccaoActual === estado.seccoes.length - 1}
            onPress={() => aoMudarEstado(irParaSeccao(estado, estado.seccaoActual + 1))}
          >
            <Text style={estilos.navegarTexto}>seguinte</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

interface PropsLista {
  campos: readonly Field[];
  /** Prefixo do caminho de instância: `` na raiz, `g_cont[0].` dentro. */
  prefixo: string;
  estado: EstadoFormulario;
  aoMudarEstado(estado: EstadoFormulario): void;
  editavel: boolean;
  mudar(caminho: string, valor: unknown): void;
  sair(caminho: string): void;
  fonteDeLocalizacao?: FonteDeLocalizacao;
  justificacaoDePrecisao?: string;
  aoJustificar?: (texto: string) => void;
  capturarAnexo?: CapturaDeAnexo;
}

function ListaDeCampos(props: PropsLista) {
  const { campos, prefixo, estado } = props;
  return (
    <>
      {campos.map((campo) => {
        const caminho = `${prefixo}${campo.id}`;
        // Um campo não relevante não é desenhado. O valor já foi limpo pelo
        // `form-core`, por isso não há aqui nenhuma decisão a tomar.
        if (!eRelevante(estado, caminho)) return null;

        if (campo.type === 'group') {
          return (
            <View key={caminho} style={estilos.grupo}>
              {campo.label ? (
                <Text style={estilos.tituloDeGrupo}>
                  {texto(campo.label, estado.idioma, campo.name)}
                </Text>
              ) : null}
              <ListaDeCampos {...props} campos={campo.fields} />
            </View>
          );
        }

        if (campo.type === 'repeat') {
          return <Repetivel key={caminho} {...props} campo={campo} caminho={caminho} />;
        }

        return <Campo key={caminho} {...props} campo={campo} caminho={caminho} />;
      })}
    </>
  );
}

/** O único sítio do sistema que decide o widget a partir do tipo do campo. */
function Campo(props: PropsLista & { campo: Field; caminho: string }) {
  const { campo, caminho, estado, editavel, mudar, sair, fonteDeLocalizacao } = props;
  const { justificacaoDePrecisao, aoJustificar, capturarAnexo } = props;

  const comuns: PropsDeCampo = {
    campo,
    caminho,
    estado,
    valor: valorEm(estado, caminho),
    erros: errosVisiveis(estado, caminho).map((e) => e.message),
    editavel: editavel && campo.readonly !== true && campo.type !== 'calculate',
    aoMudar: (valor) => mudar(caminho, valor),
    aoSair: () => sair(caminho),
  };

  switch (campo.type) {
    case 'note':
      return <CampoNota {...comuns} />;
    case 'text':
    case 'barcode':
      return <CampoTexto {...comuns} />;
    case 'integer':
    case 'decimal':
      return <CampoNumero {...comuns} />;
    case 'boolean':
      return <CampoBooleano {...comuns} />;
    case 'date':
    case 'time':
    case 'datetime':
      return <CampoData {...comuns} />;
    case 'select_one':
      return <CampoEscolhaUnica {...comuns} />;
    case 'select_multiple':
      return <CampoEscolhaMultipla {...comuns} />;
    case 'geopoint':
    case 'geotrace':
    case 'geoshape':
      return (
        <CampoGeoponto
          {...comuns}
          {...(fonteDeLocalizacao ? { fonte: fonteDeLocalizacao } : {})}
          {...(justificacaoDePrecisao !== undefined
            ? { justificacao: justificacaoDePrecisao }
            : {})}
          {...(aoJustificar ? { aoJustificar } : {})}
        />
      );
    case 'photo':
    case 'audio':
    case 'file':
    case 'signature':
      return <CampoAnexo {...comuns} {...(capturarAnexo ? { capturar: capturarAnexo } : {})} />;
    case 'calculate':
      return <CampoCalculado {...comuns} />;
    case 'reference':
      // A escolha de um registo de outro formulário precisa da lista local, que
      // é a F4. Até lá mostra-se o que está guardado em vez de um botão morto.
      return <CampoCalculado {...comuns} />;
    default:
      return null;
  }
}

function Repetivel(props: PropsLista & { campo: Field; caminho: string }) {
  const { campo, caminho, estado, aoMudarEstado, editavel } = props;
  if (campo.type !== 'repeat') return null;

  const instancias = valorEm(estado, caminho);
  const lista = Array.isArray(instancias) ? instancias : [];
  const rotulos = rotulosDasInstancias(estado, caminho);
  const noMaximo = campo.max !== undefined && lista.length >= campo.max;
  const noMinimo = campo.min !== undefined && lista.length <= campo.min;
  const errosDoRepetivel = errosVisiveis(estado, caminho).map((e) => e.message);

  return (
    <View style={estilos.repetivel}>
      <Text style={estilos.tituloDeGrupo}>
        {texto(campo.label, estado.idioma, campo.name)} ({lista.length})
      </Text>
      {errosDoRepetivel.map((m, i) => (
        <Text key={i} style={estilos.erroDeGrupo}>
          {m}
        </Text>
      ))}

      {lista.map((_, i) => (
        <Fragment key={`${caminho}[${i}]`}>
          <View style={estilos.instancia}>
            <View style={estilos.cabecalhoDaInstancia}>
              <Text style={estilos.rotuloDaInstancia}>{rotulos[i] ?? `${i + 1}`}</Text>
              {editavel ? (
                <View style={estilos.accoes}>
                  {i > 0 ? (
                    <Pressable
                      style={estilos.accao}
                      onPress={() => aoMudarEstado(moverInstancia(estado, caminho, i, i - 1))}
                    >
                      <Text style={estilos.accaoTexto}>↑</Text>
                    </Pressable>
                  ) : null}
                  {i < lista.length - 1 ? (
                    <Pressable
                      style={estilos.accao}
                      onPress={() => aoMudarEstado(moverInstancia(estado, caminho, i, i + 1))}
                    >
                      <Text style={estilos.accaoTexto}>↓</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={[estilos.accao, noMinimo && estilos.desactivado]}
                    disabled={noMinimo}
                    onPress={() => aoMudarEstado(removerInstancia(estado, caminho, i))}
                  >
                    <Text style={[estilos.accaoTexto, estilos.remover]}>remover</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
            <ListaDeCampos {...props} campos={campo.fields} prefixo={`${caminho}[${i}].`} />
          </View>
        </Fragment>
      ))}

      {editavel ? (
        <Pressable
          style={[estilos.acrescentar, noMaximo && estilos.desactivado]}
          disabled={noMaximo}
          onPress={() => aoMudarEstado(acrescentarInstancia(estado, caminho))}
        >
          <Text style={estilos.acrescentarTexto}>
            {noMaximo
              ? `máximo de ${campo.max} atingido`
              : `+ acrescentar ${texto(campo.label, estado.idioma, campo.name).toLowerCase()}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const estilos = StyleSheet.create({
  tudo: { flex: 1, backgroundColor: '#fff' },
  abas: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: '#e0e5ea' },
  abasConteudo: { paddingHorizontal: 12, gap: 8, paddingVertical: 8 },
  aba: {
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: '#f1f3f5',
  },
  abaActiva: { backgroundColor: '#0b6bcb' },
  abaTexto: { fontSize: 14, color: '#3c4652' },
  abaTextoActivo: { color: '#fff', fontWeight: '600' },
  corpo: { flex: 1 },
  corpoConteudo: { padding: 16, paddingBottom: 48 },
  grupo: { gap: 4, marginBottom: 8 },
  tituloDeGrupo: { fontSize: 16, fontWeight: '700', color: '#12181f', marginTop: 12 },
  erroDeGrupo: { color: '#b3261e', fontSize: 13 },
  repetivel: { gap: 8, marginVertical: 12 },
  instancia: {
    borderWidth: 1,
    borderColor: '#e0e5ea',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#fcfdfe',
  },
  cabecalhoDaInstancia: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rotuloDaInstancia: { fontWeight: '600', flexShrink: 1 },
  accoes: { flexDirection: 'row', gap: 6 },
  accao: {
    minHeight: 40,
    paddingHorizontal: 10,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#f1f3f5',
  },
  accaoTexto: { fontSize: 14, color: '#3c4652' },
  remover: { color: '#b3261e' },
  acrescentar: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#0b6bcb',
    borderRadius: 10,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acrescentarTexto: { color: '#0b6bcb', fontWeight: '600' },
  desactivado: { opacity: 0.4 },
  rodape: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e5ea',
    gap: 12,
  },
  navegar: {
    minHeight: 44,
    paddingHorizontal: 20,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#f1f3f5',
  },
  navegarTexto: { fontSize: 15, fontWeight: '600', color: '#3c4652' },
  contador: { color: '#5b6470' },
});
