import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { collectFields, type FormDefinition, type GeopointValue } from '@cvforms/form-core';

import { Formulario } from '@/componentes/Formulario';
import type { FonteDeLocalizacao } from '@/componentes/campos';
import { capturarFotografia } from '@/anexos/capturar';
import { fonteDeLocalizacaoActual } from '@/gnss/escolha';
import { abrirBaseLocal } from '@/db/local';
import { gravarRegisto, submeter } from '@/dados/registos';
import { lerSessao } from '@/dados/sessao';
import { lerDefinicao, lerDefinicaoCorrente } from '@/forms/definicoes';
import {
  GravadorDeRascunho,
  abrirRascunho,
  apagarRascunho,
  prepararRascunhos,
} from '@/forms/rascunhos';
import {
  criarEstado,
  estaValido,
  mostrarTodosOsErros,
  texto,
  valorEm,
  type EstadoFormulario,
} from '@/forms/estado';

/**
 * Ecrã de preenchimento (F3).
 *
 * Recebe um `formId`, lê a definição do SQLite e constrói o ecrã. Não sabe
 * nada sobre nenhum formulário concreto — publicar um formulário novo no
 * painel não implica publicar uma versão nova da app.
 *
 * O rascunho é gravado a cada alteração, com atraso curto, e à força sempre
 * que a app pode morrer: ao ir para segundo plano e ao sair do ecrã. Matar a
 * app a meio não pode perder nada (F3.9).
 */
export default function EcraDeFormulario() {
  const { formId, recordId, versao } = useLocalSearchParams<{
    formId: string;
    recordId?: string;
    versao?: string;
  }>();
  const router = useRouter();

  const [estado, setEstado] = useState<EstadoFormulario>();
  const [erro, setErro] = useState<string>();
  const [aGravar, setAGravar] = useState(false);
  /**
   * Justificação de um ponto acima do limiar (F7.8). Não é uma resposta — não
   * entra no JSONB dos dados —, é um dado sobre a recolha, e fica na revisão.
   */
  const [justificacao, setJustificacao] = useState('');
  const gravador = useRef<GravadorDeRascunho | undefined>(undefined);
  const idDoRegisto = useRef<string | undefined>(undefined);
  const contexto = useRef<
    | {
        definicao: FormDefinition;
        formVersionId: string;
        orgId: string;
        projectId: string;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const db = await abrirBaseLocal();
        await prepararRascunhos(db);

        const definicao = versao
          ? await lerDefinicao(db, formId, Number(versao))
          : await lerDefinicaoCorrente(db, formId);
        if (!definicao) {
          throw new Error(
            'a definição deste formulário ainda não está no telefone; sincroniza com rede',
          );
        }

        // Sem organização não se grava: um registo que não sabe a que
        // organização pertence é pior do que um registo que não existe.
        const sessao = await lerSessao(db);
        if (!sessao) {
          throw new Error('ainda não há sessão guardada neste telefone; entra com rede uma vez');
        }
        const formulario = await db.getFirstAsync<{ project_id: string }>(
          'SELECT project_id FROM forms WHERE id = ?',
          [formId],
        );
        if (!formulario) {
          throw new Error('este formulário ainda não foi sincronizado para o telefone');
        }

        const rascunho = await abrirRascunho(db, {
          formId,
          formVersionId: `${formId}:${definicao.version}`,
          formVersion: definicao.version,
          ...(recordId ? { recordId } : {}),
        });

        if (!vivo) return;
        contexto.current = {
          definicao,
          formVersionId: rascunho.form_version_id,
          orgId: sessao.orgId,
          projectId: formulario.project_id,
        };
        idDoRegisto.current = rascunho.record_id;
        gravador.current = new GravadorDeRascunho(db, rascunho.record_id);
        setEstado(criarEstado(definicao, rascunho.dados, { seccaoActual: rascunho.seccao_actual }));
      } catch (e) {
        if (vivo) setErro(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      vivo = false;
      // Sair do ecrã grava o que estiver pendente. Nunca se sai com trabalho
      // por gravar.
      void gravador.current?.gravarJa();
    };
  }, [formId, recordId, versao]);

  // Ir para segundo plano é o momento em que o Android mata apps sem avisar.
  useEffect(() => {
    const inscricao = AppState.addEventListener('change', (estadoDaApp) => {
      if (estadoDaApp !== 'active') void gravador.current?.gravarJa();
    });
    return () => inscricao.remove();
  }, []);

  const aoMudarEstado = useCallback((proximo: EstadoFormulario) => {
    setEstado(proximo);
    gravador.current?.agendar(proximo.dados, proximo.seccaoActual);
  }, []);

  const guardar = useCallback(
    async (submeterTambem: boolean) => {
      const actual = estado;
      const ctx = contexto.current;
      const record = idDoRegisto.current;
      if (!actual || !ctx || !record) return;

      if (submeterTambem && !estaValido(actual)) {
        setEstado(mostrarTodosOsErros(actual));
        Alert.alert(
          'Faltam respostas',
          'Há campos por corrigir. Estão assinalados a vermelho nas secções.',
        );
        return;
      }

      setAGravar(true);
      try {
        const db = await abrirBaseLocal();
        await gravador.current?.gravarJa();

        const geometria = geometriaDe(actual, ctx.definicao);
        // Os campos pesquisáveis vêm da definição, nunca de uma lista escrita
        // à mão: acrescentar um `searchable` no painel passa a indexar sem
        // tocar em código móvel.
        const camposDeProcura = collectFields(ctx.definicao)
          .filter((v) => v.field.searchable === true && v.repeatScope === undefined)
          .map((v) => v.field.id);

        await gravarRegisto(db, {
          recordId: record,
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          formId,
          formVersionId: ctx.formVersionId,
          dados: actual.dados,
          camposDeProcura,
          ...(geometria ? { geometria } : {}),
          ...(justificacao.trim() ? { justificacaoDePrecisao: justificacao.trim() } : {}),
        });
        if (submeterTambem) {
          await submeter(db, record);
          // O rascunho deixa de fazer sentido: o que interessa passou a ser a
          // revisão, que é imutável e vai subir.
          await apagarRascunho(db, record);
        }
        router.back();
      } catch (e) {
        Alert.alert('Não foi possível gravar', e instanceof Error ? e.message : String(e));
      } finally {
        setAGravar(false);
      }
    },
    [estado, formId, router, justificacao],
  );

  if (erro) {
    return (
      <View style={estilos.centro}>
        <Text style={estilos.titulo}>Não foi possível abrir o formulário</Text>
        <Text style={estilos.suave}>{erro}</Text>
      </View>
    );
  }

  if (!estado) {
    return (
      <View style={estilos.centro}>
        <ActivityIndicator />
        <Text style={estilos.suave}>a preparar o formulário…</Text>
      </View>
    );
  }

  return (
    <View style={estilos.tudo}>
      <Stack.Screen
        options={{ title: texto(estado.definicao.title, estado.idioma, 'Formulário') }}
      />
      <Formulario
        estado={estado}
        aoMudarEstado={aoMudarEstado}
        fonteDeLocalizacao={fonteParaOEcra()}
        justificacaoDePrecisao={justificacao}
        aoJustificar={setJustificacao}
        capturarAnexo={async (campo) => {
          const db = await abrirBaseLocal();
          // O anexo entra no SQLite com o mesmo `id` com que o registo vai ser
          // gravado, antes de o registo existir. É de propósito: uma foto que
          // só existisse em memória desaparecia se a bateria acabasse a meio
          // (restrição inegociável 2).
          const alvo = idDoRegisto.current;
          if (!alvo) throw new Error('o rascunho ainda não abriu; tenta outra vez');
          const anexo = await capturarFotografia(db, alvo, campo);
          return anexo ? { id: anexo.id, uri: anexo.uri, bytes: anexo.bytes } : undefined;
        }}
      />
      <View style={estilos.barra}>
        <Pressable style={estilos.secundario} disabled={aGravar} onPress={() => guardar(false)}>
          <Text style={estilos.secundarioTexto}>guardar rascunho</Text>
        </Pressable>
        <Pressable style={estilos.principal} disabled={aGravar} onPress={() => guardar(true)}>
          <Text style={estilos.principalTexto}>{aGravar ? 'a gravar…' : 'submeter'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Coordenada que alimenta o mapa, tirada do campo indicado em `settings`. */
function geometriaDe(
  estado: EstadoFormulario,
  definicao: FormDefinition,
): { lat: number; lon: number } | undefined {
  const campo = definicao.settings?.geometry_field;
  if (!campo) return undefined;
  const valor = valorEm(estado, campo) as GeopointValue | null;
  if (!valor || typeof valor.lat !== 'number' || typeof valor.lon !== 'number') return undefined;
  return { lat: valor.lat, lon: valor.lon };
}

/**
 * A fonte de localização configurada, embrulhada para o renderizador.
 *
 * O renderizador só quer um `obter()`. Qual é o receptor por trás — o GPS do
 * telefone ou um Emlid por TCP — é uma definição do técnico, e trocar de um
 * para o outro não toca em código de formulário nenhum (F7.1).
 */
function fonteParaOEcra(): FonteDeLocalizacao {
  const fonte = fonteDeLocalizacaoActual();
  return {
    nome: fonte.descricao,
    async obter(): Promise<GeopointValue> {
      return fonte.obter();
    },
  };
}

const estilos = StyleSheet.create({
  tudo: { flex: 1, backgroundColor: '#fff' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  titulo: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  suave: { color: '#5b6470', textAlign: 'center' },
  barra: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e5ea',
  },
  secundario: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0b6bcb',
  },
  secundarioTexto: { color: '#0b6bcb', fontWeight: '600', fontSize: 15 },
  principal: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#0b6bcb',
  },
  principalTexto: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
