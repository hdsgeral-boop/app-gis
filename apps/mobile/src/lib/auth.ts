import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

import { config } from './config';

WebBrowser.maybeCompleteAuthSession();

const CHAVE_TOKENS = 'cvforms.tokens';

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Instante de expiração, em milissegundos desde a época. */
  expiraEm: number;
}

/**
 * Sessão no telefone.
 *
 * Os tokens ficam no SecureStore (Keystore no Android, Keychain no iOS) e
 * nunca em AsyncStorage: um telefone de campo perde-se, é emprestado e é
 * roubado, e o armazenamento normal é legível por qualquer app com root.
 *
 * O refresh token é de longa duração de propósito. Um técnico pode passar
 * semanas sem rede, e obrigá-lo a autenticar-se de novo no meio do mato para
 * poder continuar a gravar seria pior do que o risco que se evita — sobretudo
 * porque gravar não precisa de rede nenhuma.
 */
export function descoberta() {
  return {
    authorizationEndpoint: `${config.keycloakIssuer}/protocol/openid-connect/auth`,
    tokenEndpoint: `${config.keycloakIssuer}/protocol/openid-connect/token`,
    endSessionEndpoint: `${config.keycloakIssuer}/protocol/openid-connect/logout`,
  };
}

export function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: 'cvforms', path: 'auth' });
}

export async function guardarTokens(tokens: Tokens): Promise<void> {
  await SecureStore.setItemAsync(CHAVE_TOKENS, JSON.stringify(tokens));
}

export async function lerTokens(): Promise<Tokens | undefined> {
  const cru = await SecureStore.getItemAsync(CHAVE_TOKENS);
  if (!cru) return undefined;
  try {
    return JSON.parse(cru) as Tokens;
  } catch {
    // Guardado por uma versão anterior com outro formato. Apagar e pedir
    // autenticação de novo é melhor do que rebentar no arranque.
    await SecureStore.deleteItemAsync(CHAVE_TOKENS);
    return undefined;
  }
}

export async function esquecerTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(CHAVE_TOKENS);
}

/**
 * Renova o token de acesso.
 *
 * Sem rede, devolve os tokens que já tem. A app NÃO se bloqueia por não
 * conseguir renovar: gravar é local, e recusar trabalho por causa de um token
 * expirado seria perder recolha de campo por um problema de rede.
 */
export async function renovar(tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) return tokens;
  if (Date.now() < tokens.expiraEm - 60_000) return tokens;

  try {
    const resposta = await AuthSession.refreshAsync(
      { clientId: config.keycloakClientId, refreshToken: tokens.refreshToken },
      descoberta(),
    );
    const novos: Tokens = {
      accessToken: resposta.accessToken,
      refreshToken: resposta.refreshToken ?? tokens.refreshToken,
      expiraEm: Date.now() + (resposta.expiresIn ?? 300) * 1000,
    };
    await guardarTokens(novos);
    return novos;
  } catch {
    return tokens;
  }
}
