/**
 * A máquina de estado do formulário vive no `form-core`, e não aqui.
 *
 * Tem dois consumidores — este renderizador e a pré-visualização do construtor
 * no painel — e uma segunda implementação faria com que o que o administrador
 * vê ao desenhar deixasse de ser o que o técnico vê em campo.
 *
 * Este ficheiro existe só para os ecrãs continuarem a importar de `@/forms/estado`.
 */
export * from '@cvforms/form-core';
