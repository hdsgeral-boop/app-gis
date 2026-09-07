import { SetMetadata } from '@nestjs/common';

export const PUBLICO = 'cvforms:publico';

/**
 * Marca uma rota como aberta. O guarda é global: por omissão, tudo exige
 * autenticação. Uma rota só fica pública se alguém o escrever explicitamente
 * — esquecer-se do decorador fecha a rota, nunca a abre.
 */
export const Publico = () => SetMetadata(PUBLICO, true);
