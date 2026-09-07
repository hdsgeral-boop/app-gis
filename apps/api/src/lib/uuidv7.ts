/**
 * Reexportado do `form-core` para a API não ter uma segunda implementação.
 * Todos os `id` do sistema são UUIDv7 (restrição inegociável 3): os do
 * telefone e os que nascem no painel.
 */
export { uuidv7, isUuidV7 } from '@cvforms/form-core';
