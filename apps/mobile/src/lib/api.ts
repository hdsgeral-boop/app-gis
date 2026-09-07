import type { FormDefinition } from '@cvforms/form-core';

import { config } from './config';
import type { ClienteDeFormularios, FormularioRemoto } from '@/forms/definicoes';

/**
 * Cliente da API.
 *
 * Só é usado para TRAZER coisas: definições, manifestos, listas. Gravar nunca
 * passa por aqui — a app escreve sempre primeiro no SQLite local (restrição
 * inegociável 2), e a subida é do PowerSync a partir da F5.
 *
 * Falhar aqui nunca é fatal: um técnico sem rede tem de continuar a trabalhar
 * com o que já descarregou.
 */

export class ErroDaApi extends Error {
  constructor(
    message: string,
    readonly estado: number,
  ) {
    super(message);
  }
}

async function pedir<T>(caminho: string, token: string, sinal?: AbortSignal): Promise<T> {
  const resposta = await fetch(`${config.apiUrl}${caminho}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    ...(sinal ? { signal: sinal } : {}),
  });
  if (!resposta.ok) {
    throw new ErroDaApi(`${caminho} respondeu ${resposta.status}`, resposta.status);
  }
  return (await resposta.json()) as T;
}

export function clienteDeFormularios(token: string): ClienteDeFormularios {
  return {
    async listar() {
      const resposta = await pedir<{ formularios: FormularioRemoto[] }>('/forms', token);
      return resposta.formularios;
    },
    async definicao(formId, versao) {
      const resposta = await pedir<{ hash: string; definicao: FormDefinition }>(
        `/forms/${formId}/versions/${versao}`,
        token,
      );
      return { hash: resposta.hash, definicao: resposta.definicao };
    },
  };
}

export interface PerfilRemoto {
  username: string;
  user_id?: string;
  org: { id: string; name?: string; provisionada: boolean };
  papeis: string[];
  projectos: Array<{ id: string; key: string; name: string }>;
  formularios: Array<{ form_id: string; key: string; titulo: Record<string, string> }>;
}

export function lerPerfil(token: string): Promise<PerfilRemoto> {
  return pedir<PerfilRemoto>('/me', token);
}
