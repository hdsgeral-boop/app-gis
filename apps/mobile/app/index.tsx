import * as AuthSession from 'expo-auth-session';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { config } from '@/lib/config';
import {
  descoberta,
  esquecerTokens,
  guardarTokens,
  lerTokens,
  redirectUri,
  renovar,
  type Tokens,
} from '@/lib/auth';
import { resumoLocal, type ResumoLocal } from '@/db/local';
import { BotaoCapsula, useEstilos } from '@/ui/componentes';
import { espaco } from '@/ui/tema';

interface Perfil {
  username: string;
  nome?: string | null;
  org: { id: string; name?: string; provisionada: boolean };
  papeis: string[];
  formularios: { form_id: string; key: string; titulo: Record<string, string> }[];
}

/**
 * O menu principal.
 *
 * A ESTRUTURA É A DO KOBOCOLLECT, e não por gosto: um técnico que já usou
 * KoboCollect — e em Angola muitos usaram — reconhece isto ao segundo. Uma
 * acção por botão, botões altos e redondos, e o que se vem fazer em primeiro
 * lugar, a azul.
 *
 * O QUE MUDA EM RELAÇÃO AO KOBO, e é deliberado:
 *
 *   - **Não há ecrã de servidor.** O KoboCollect pede URL, utilizador e senha,
 *     e mostra-os. Aqui o servidor vem no pacote e o técnico nunca o vê: o que
 *     ele tem de saber é o utilizador e a senha, e mais nada. Uma pessoa a
 *     escrever um URL num telefone ao sol é uma pessoa a escrever mal um URL.
 *   - **Os contadores estão nos botões.** «Por enviar 3» diz num relance o que
 *     no Kobo obriga a entrar. É o número que interessa a alguém ao fim do dia.
 */
export default function Inicio() {
  const router = useRouter();
  const { tema, estilos } = useEstilos();

  const [tokens, setTokens] = useState<Tokens>();
  const [perfil, setPerfil] = useState<Perfil>();
  const [resumo, setResumo] = useState<ResumoLocal>();
  const [ocupado, setOcupado] = useState(true);
  const [aActualizar, setAActualizar] = useState(false);
  const [erro, setErro] = useState<string>();

  const [pedido, , entrar] = AuthSession.useAuthRequest(
    {
      clientId: config.keycloakClientId,
      redirectUri: redirectUri(),
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      usePKCE: true,
    },
    descoberta(),
  );

  const buscarPerfil = useCallback(async (t: Tokens) => {
    try {
      const resposta = await fetch(`${config.apiUrl}/me`, {
        headers: { authorization: `Bearer ${t.accessToken}` },
      });
      if (!resposta.ok) throw new Error(`a API respondeu ${resposta.status}`);
      setPerfil((await resposta.json()) as Perfil);
      setErro(undefined);
    } catch {
      // Sem rede a app trabalha na mesma. O perfil é conveniência, e dizer
      // «erro» a quem está a trabalhar offline seria mentir sobre o estado.
      setErro(undefined);
    }
  }, []);

  const carregar = useCallback(async () => {
    setResumo(await resumoLocal());
    const guardados = await lerTokens();
    if (!guardados) {
      setTokens(undefined);
      setPerfil(undefined);
      return;
    }
    const frescos = await renovar(guardados);
    setTokens(frescos);
    await buscarPerfil(frescos);
  }, [buscarPerfil]);

  useEffect(() => {
    void carregar().finally(() => setOcupado(false));
  }, [carregar]);

  const autenticar = useCallback(async () => {
    setErro(undefined);
    const resultado = await entrar();
    if (resultado?.type !== 'success' || !pedido?.codeVerifier) {
      if (resultado?.type === 'error') setErro('Não foi possível entrar. Tenta outra vez.');
      return;
    }
    try {
      const troca = await AuthSession.exchangeCodeAsync(
        {
          clientId: config.keycloakClientId,
          code: resultado.params.code!,
          redirectUri: redirectUri(),
          extraParams: { code_verifier: pedido.codeVerifier },
        },
        descoberta(),
      );
      const novos: Tokens = {
        accessToken: troca.accessToken,
        refreshToken: troca.refreshToken,
        expiraEm: Date.now() + (troca.expiresIn ?? 300) * 1000,
      };
      await guardarTokens(novos);
      setTokens(novos);
      await buscarPerfil(novos);
    } catch {
      setErro('Não foi possível entrar. Confirma o utilizador e a senha.');
    }
  }, [entrar, pedido, buscarPerfil]);

  const sair = useCallback(async () => {
    await esquecerTokens();
    setTokens(undefined);
    setPerfil(undefined);
  }, []);

  if (ocupado) {
    return (
      <View style={[estilos.ecra, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={tema.realce} />
      </View>
    );
  }

  const porEnviar = (resumo?.porSincronizar ?? 0) + (resumo?.anexosPendentes ?? 0);

  return (
    <ScrollView
      style={estilos.ecra}
      contentContainerStyle={{ padding: espaco.l, gap: espaco.m, paddingBottom: espaco.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={aActualizar}
          tintColor={tema.realce}
          onRefresh={() => {
            setAActualizar(true);
            void carregar().finally(() => setAActualizar(false));
          }}
        />
      }
    >
      <Stack.Screen options={{ headerShown: false }} />

      {/* Cabeçalho: quem sou, e nada mais. O nome da organização substitui o
          URL do servidor que o KoboCollect mostra aqui — é o que identifica o
          trabalho sem obrigar ninguém a saber o que é um URL. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: espaco.m,
          paddingVertical: espaco.s,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={estilos.titulo} numberOfLines={1}>
            {perfil?.org.name ?? 'Consul Colect'}
          </Text>
          <Text style={estilos.suave} numberOfLines={1}>
            {tokens ? (perfil?.nome ?? perfil?.username ?? 'sessão iniciada') : 'sem sessão'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tokens ? 'terminar sessão' : 'entrar'}
          onPress={() => void (tokens ? sair() : autenticar())}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: pressed ? tema.superficiePressionada : tema.superficie,
            alignItems: 'center',
            justifyContent: 'center',
          })}
        >
          <Text style={{ fontSize: 18, color: tema.realce, fontWeight: '700' }}>
            {(perfil?.username ?? '?').slice(0, 1).toUpperCase()}
          </Text>
        </Pressable>
      </View>

      {erro ? <Text style={estilos.erro}>{erro}</Text> : null}

      {!tokens ? (
        <View style={[estilos.cartao, { marginBottom: espaco.s }]}>
          <Text style={estilos.subtitulo}>Entra uma vez</Text>
          <Text style={estilos.suave}>
            Precisas de rede só desta vez. Depois disso trabalhas dias inteiros sem rede nenhuma.
          </Text>
        </View>
      ) : null}

      <BotaoCapsula
        icone="＋"
        texto="Preencher novo formulário"
        principal
        desactivado={!tokens && (resumo?.formularios ?? 0) === 0}
        aoTocar={() => (tokens ? router.push('/formularios') : void autenticar())}
      />

      <BotaoCapsula
        icone="✎"
        texto="Rascunhos"
        contador={resumo?.rascunhos ?? 0}
        aoTocar={() => router.push('/registos/rascunhos')}
      />

      <BotaoCapsula
        icone="➤"
        texto="Por enviar"
        contador={porEnviar}
        aoTocar={() => router.push('/registos/por-enviar')}
      />

      <BotaoCapsula icone="✓" texto="Enviados" aoTocar={() => router.push('/registos/enviados')} />

      <BotaoCapsula icone="🗺" texto="Mapa" aoTocar={() => router.push('/mapa')} />

      <BotaoCapsula icone="⚙" texto="Definições" aoTocar={() => router.push('/definicoes')} />

      {/* O que está por sincronizar é a única coisa que pode fazer perder
          trabalho. Fica em baixo, mas fica sempre à vista. */}
      {porEnviar > 0 ? (
        <Text style={[estilos.suave, { textAlign: 'center', marginTop: espaco.m }]}>
          {porEnviar === 1 ? 'Há 1 coisa por enviar.' : `Há ${porEnviar} coisas por enviar.`} A app
          envia sozinha quando apanhar rede. Não desinstales até isto ficar a zero.
        </Text>
      ) : (
        <Text style={[estilos.suave, { textAlign: 'center', marginTop: espaco.m }]}>
          Está tudo enviado. Gravar nunca precisa de rede.
        </Text>
      )}
    </ScrollView>
  );
}
