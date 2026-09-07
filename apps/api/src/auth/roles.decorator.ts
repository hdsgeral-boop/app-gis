import { SetMetadata } from '@nestjs/common';

export const PAPEIS = 'cvforms:papeis';

/**
 * Exige um dos papéis do realm. Vale como primeira linha: a segunda são as
 * atribuições por formulário, e a terceira serão as políticas RLS da F6.
 * Um papel sozinho nunca chega — `admin` não é permissão para ver dados de
 * campo de outra organização.
 */
export const Papeis = (...papeis: string[]) => SetMetadata(PAPEIS, papeis);
