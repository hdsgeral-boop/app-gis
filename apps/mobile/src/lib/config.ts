import Constants from 'expo-constants';

/**
 * Configuração da app.
 *
 * Vem de variáveis EXPO_PUBLIC_*, que ficam embutidas no pacote. Por isso só
 * entra aqui o que pode ser público: URLs de serviços e o id do cliente OIDC.
 * Nenhum segredo (restrição inegociável 9) — um cliente público com PKCE não
 * precisa de nenhum.
 */
function ler(nome: string, omissao: string): string {
  const doProcesso = process.env[nome];
  if (doProcesso) return doProcesso;
  const extra = Constants.expoConfig?.extra as Record<string, string> | undefined;
  return extra?.[nome] ?? omissao;
}

export const config = {
  apiUrl: ler('EXPO_PUBLIC_API_URL', 'http://10.0.2.2:4000'),
  keycloakIssuer: ler('EXPO_PUBLIC_KEYCLOAK_ISSUER', 'http://10.0.2.2:8080/realms/cvforms'),
  keycloakClientId: ler('EXPO_PUBLIC_KEYCLOAK_CLIENT_ID', 'cvforms-mobile'),
  powersyncUrl: ler('EXPO_PUBLIC_POWERSYNC_URL', 'http://10.0.2.2:8090'),
};
