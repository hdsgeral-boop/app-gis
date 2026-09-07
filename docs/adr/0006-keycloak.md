# ADR-0006 — Keycloak como fornecedor de identidade

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

Três clientes (app móvel, painel, integrações) precisam de autenticar contra o
mesmo sistema, com papéis, e com uma forma de revogar o acesso de alguém que
funcione em todo o lado ao mesmo tempo.

## Decisão

**Keycloak**, auto-hospedado. A API valida os JWT contra o JWKS do realm; o
painel usa o mesmo `access_token`; a app móvel usa PKCE com um cliente público.
O token leva `sub`, `org_id` e `realm_access.roles`.

A tabela `users` é um **espelho** do Keycloak: existe para que as chaves
estrangeiras tenham a quem apontar e para que uma listagem não tenha de chamar
o Keycloak por cada linha. A verdade da identidade está no Keycloak.

## Alternativas rejeitadas

**Autenticação própria, com senhas na nossa base.** Rejeitada por sermos três
pessoas: guardar senhas bem feito (hashing, rotação, reposição, bloqueio por
tentativas, 2FA quando o cliente pedir) é um projecto inteiro, e falhar nisso
tem consequências que não conseguimos absorver.

**Auth0 / Clerk / serviço gerido.** Rejeitada por custo por utilizador activo e
por dependência externa. Um cliente institucional angolano pode ainda exigir
que a identidade fique dentro da sua infraestrutura, e com o Keycloak isso é
uma decisão de instalação, não uma migração.

**Ory Hydra/Kratos.** Mais modular e mais leve, mas obriga a montar mais peças.
O Keycloak traz a consola de administração pronta, e isso importa: quem gere
utilizadores não é programador.

## Consequências

**Ganhamos:** uma só identidade em todo o sistema, e um só sítio onde revogar
o acesso de alguém; papéis geridos numa consola que um administrador consegue
usar; nenhuma senha na nossa base.

**Pagamos:**

- O Keycloak é pesado. Consome memória a sério e é o serviço mais complexo do
  compose.
- A configuração do realm é um ficheiro JSON grande e frágil
  (`infra/docker/keycloak/cvforms-realm.json`). Alterá-lo à mão na consola e
  esquecer de o exportar é uma forma garantida de perder configuração.
- O `org_id` é um atributo de utilizador mapeado para um claim. Se alguém criar
  um utilizador sem esse atributo, o token é recusado pela API — de propósito:
  sem organização não há isolamento possível. Mas a mensagem de erro tem de
  ajudar, porque isto vai acontecer.
- Há uma tolerância de relógio deliberada nos tokens
  (`JWT_CLOCK_TOLERANCE_S`, 120s por omissão), porque os telefones de campo
  desacertam. O custo é uma janela curta em que um token acabado de expirar
  ainda é aceite.
