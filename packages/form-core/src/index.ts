/**
 * @cvforms/form-core — o coração da plataforma.
 *
 * Todas as regras de formulário do Consul Colect vivem aqui, uma só vez, e correm
 * iguais em apps/api, apps/admin e apps/mobile. Se uma regra for implementada
 * duas vezes, vai divergir (ESPECIFICACAO.md §9).
 *
 * O que está aqui, e o porquê de estar tudo no mesmo sítio:
 *   - o formato (tipos + JSON Schema), que é o contrato entre as três apps;
 *   - o validador semântico da definição (ciclos, ids duplicados, referências);
 *   - o avaliador de expressões em AST, sem eval;
 *   - a execução (relevância, cálculos por ordem topológica);
 *   - o validador de respostas;
 *   - o diff entre versões;
 *   - a ponte XLSForm.
 * Ver PLANO.md.
 */

export * from './types/index.js';
export * from './schema/index.js';
export { walkFields, collectFields, findField, fieldPathById } from './walk.js';
export type { FieldVisit } from './walk.js';
export * from './uuid.js';
export * from './refs.js';
export * from './operators.js';
export * from './geo.js';
export * from './index-form.js';
export * from './evaluate.js';
export * from './dependencies.js';
export * from './runtime.js';
export * from './validate-definition.js';
export * from './validate-answers.js';
export * from './form-state.js';
export * from './infer-type.js';
export * from './diff.js';
export * from './gnss/nmea.js';
export * from './gnss/provedor.js';
export * from './xlsform/index.js';
