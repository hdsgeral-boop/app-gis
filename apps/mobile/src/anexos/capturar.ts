import { uuidv7, type Field } from '@cvforms/form-core';

import type { BaseLocal } from '../forms/definicoes';
import { prepararFotografia } from './imagem';
import { hashDoFicheiro, manipuladorNativo, tirarFotografia } from './manipulador';

/**
 * Da câmara até à fila de anexos (F9.1 + F9.2).
 *
 * A ORDEM AQUI NÃO É ARBITRÁRIA, e é a parte que interessa perceber:
 *
 *   1. tirar a fotografia;
 *   2. **reduzir** para o `max_dimension_px` do formulário;
 *   3. calcular o hash **do que ficou** — é o conteúdo que vai subir, e é por
 *      ele que o servidor deduplica (F9.6);
 *   4. gravar a linha no SQLite local.
 *
 * Fazer o hash antes de reduzir daria um hash de um ficheiro que nunca vai
 * existir no servidor, e a deduplicação passava a nunca acertar. Reduzir
 * depois de gravar deixaria a fila com o ficheiro grande até alguém reparar.
 *
 * O anexo é gravado com `record_id`, mesmo que o registo ainda seja um
 * rascunho por gravar: a app escreve sempre primeiro no SQLite local
 * (restrição inegociável 2), e uma foto que só existisse em memória
 * desaparecia se a bateria acabasse enquanto o técnico escrevia o resto.
 */

export interface AnexoCapturado {
  id: string;
  uri: string;
  bytes: number;
  hash: string;
}

export async function capturarFotografia(
  db: BaseLocal,
  recordId: string,
  campo: Field,
): Promise<AnexoCapturado | undefined> {
  const foto = await tirarFotografia();
  if (!foto) return undefined;

  const maxDimensao = campo.type === 'photo' ? campo.max_dimension_px : undefined;
  const pronta = await prepararFotografia(foto.uri, maxDimensao, manipuladorNativo);
  const hash = await hashDoFicheiro(pronta.uri);

  const id = uuidv7();
  await db.runAsync(
    `INSERT INTO attachments (id, record_id, field_id, local_uri, mime_type, bytes, hash,
                              upload_state, created_at)
     VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?, 'pendente', ?)`,
    [id, recordId, campo.id, pronta.uri, pronta.bytes, hash, new Date().toISOString()],
  );

  return { id, uri: pronta.uri, bytes: pronta.bytes, hash };
}
