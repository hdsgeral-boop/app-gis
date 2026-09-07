/** Quem está a fazer o pedido, depois de o JWT ter sido verificado. */
export interface Principal {
  /** `sub` do Keycloak. */
  subject: string;
  username: string;
  email: string | undefined;
  displayName: string | undefined;
  /** Vem do claim `org_id`. Sem ele o utilizador não pertence a lado nenhum. */
  orgId: string;
  /** Papéis do realm do Keycloak. */
  roles: string[];
  /** `id` interno na tabela `users`, resolvido no primeiro pedido. */
  userId: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
