import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { formAccess, forms } from '@cvforms/db/schema';

import { DB, type Db } from '../db/db.module.js';
import type { Principal } from '../auth/principal.js';

/**
 * «Ninguém vê um formulário que não lhe foi atribuído» (ESPECIFICACAO §2).
 *
 * A regra é aplicada em três camadas — esta API, as sync rules do PowerSync e
 * as políticas RLS — e as três lêem A MESMA TABELA: `form_access`, que é a
 * materialização das atribuições directas, por equipa e por papel, mantida por
 * trigger (migração 0003).
 *
 * É essa a razão de ela existir. Enquanto cada camada resolvia as atribuições
 * à sua maneira, três implementações da mesma regra iam divergir — e a forma
 * de dar por isso seria um técnico ver na app um formulário que a API lhe
 * recusa, ou pior, o contrário.
 */

export interface FormularioAtribuido {
  form_id: string;
  key: string;
  titulo: unknown;
  projecto_id: string;
  versao_corrente: number | null;
  pode_ler: boolean;
  pode_criar: boolean;
  pode_editar_proprios: boolean;
  pode_editar_todos: boolean;
  pode_apagar: boolean;
}

@Injectable()
export class FormsAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Formulários a que o utilizador tem acesso, com as permissões efectivas.
   *
   * Onde duas atribuições se sobrepõem — uma directa e outra pela equipa — a
   * mais permissiva ganha. É a semântica que as pessoas esperam quando alguém
   * é acrescentado a uma equipa, e a alternativa (a mais restritiva ganhar)
   * produziria o efeito absurdo de entrar numa equipa tirar acesso.
   */
  async formulariosDe(userId: string): Promise<FormularioAtribuido[]> {
    return this.db
      .select({
        form_id: forms.id,
        key: forms.key,
        titulo: forms.title,
        projecto_id: forms.projectId,
        versao_corrente: forms.currentVersion,
        pode_ler: formAccess.canRead,
        pode_criar: formAccess.canCreate,
        pode_editar_proprios: formAccess.canEditOwn,
        pode_editar_todos: formAccess.canEditAll,
        pode_apagar: formAccess.canDelete,
      })
      .from(formAccess)
      .innerJoin(forms, eq(forms.id, formAccess.formId))
      .where(
        and(eq(formAccess.userId, userId), eq(formAccess.canRead, true), isNull(forms.archivedAt)),
      );
  }

  /** Permissões sobre um formulário, ou `undefined` se não tiver acesso. */
  async permissoes(principal: Principal, formId: string): Promise<FormularioAtribuido | undefined> {
    if (!principal.userId) return undefined;
    const todos = await this.formulariosDe(principal.userId);
    return todos.find((f) => f.form_id === formId);
  }

  /**
   * `form_id` visíveis a partir da organização, para validar campos
   * `reference` ao publicar (FORM-SPEC §8 regra 6).
   */
  async formIdsDaOrganizacao(orgId: string): Promise<string[]> {
    const linhas = await this.db
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.orgId, orgId), isNull(forms.archivedAt)));
    return linhas.map((l) => l.id);
  }
}
