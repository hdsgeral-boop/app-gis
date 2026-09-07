import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { isUuidV7 } from '@cvforms/form-core';
import type postgres from 'postgres';

import { ArmazenamentoService } from './armazenamento.service.js';
import { DB_CLIENT } from '../db/db.module.js';
import { FormsAccessService } from '../forms/forms-access.service.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import type { Principal } from '../auth/principal.js';

/**
 * Anexos (F9).
 *
 * Três decisões que governam este controlador:
 *
 * 1. **O ficheiro não passa pela API.** O telefone recebe um URL assinado e
 *    fala directamente com o armazenamento (F9.3). Uma foto de 2 MB por uma
 *    rede de campo demora minutos, e segurar essa ligação na API por cada foto
 *    de cada técnico deita-a abaixo.
 * 2. **A deduplicação é por hash do conteúdo** (F9.6). Se o ficheiro já lá
 *    está, não se envia outra vez — devolve-se «já existe» e o telefone marca
 *    o anexo como concluído sem gastar um byte de rede.
 * 3. **O registo sincroniza com fotos por subir.** Um anexo pendente nunca
 *    impede a revisão de subir: são filas separadas, e a dos anexos tem
 *    prioridade baixa (ESPECIFICACAO §10).
 */
const MIME_PERMITIDOS = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'application/pdf',
  'video/mp4',
]);

const presign = z.object({
  /** UUIDv7 gerado no telefone, como tudo o resto. */
  id: z.string().uuid(),
  record_id: z.string().uuid(),
  field_id: z.string().min(1).max(63),
  /** SHA-256 do conteúdo, em hexadecimal. É a chave da deduplicação. */
  hash: z.string().regex(/^[a-f0-9]{64}$/i, 'o hash tem de ser um SHA-256 em hexadecimal'),
  bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  mime_type: z.string().min(3).max(120),
});

const completo = z.object({
  /** Confirmado pelo cliente depois do upload. Serve para detectar corrupção. */
  bytes: z.number().int().positive().optional(),
});

@Controller('attachments')
export class AttachmentsController {
  constructor(
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql },
    private readonly armazenamento: ArmazenamentoService,
    private readonly acesso: FormsAccessService,
  ) {}

  private get sql(): postgres.Sql {
    return this.holder.client;
  }

  /**
   * Autoriza o upload de um anexo — ou diz que ele já lá está.
   */
  @Post('presign')
  async presign(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = presign.parse(body);
    if (!isUuidV7(dados.id)) {
      throw new BadRequestException('o id do anexo tem de ser um UUIDv7 gerado no cliente');
    }
    if (!MIME_PERMITIDOS.has(dados.mime_type)) {
      throw new BadRequestException(
        `tipo ${dados.mime_type} não aceite; ver MIME_PERMITIDOS em attachments.controller.ts`,
      );
    }

    const registo = await this.registo(dados.record_id, principal);
    const chave = this.armazenamento.chave(
      principal.orgId,
      dados.hash,
      extensaoDe(dados.mime_type),
    );

    // F9.6: o mesmo conteúdo, noutro registo ou noutro campo, já está lá.
    const [jaExiste] = await this.sql<Array<{ storage_key: string }>>`
      SELECT storage_key FROM attachments
      WHERE hash = ${dados.hash.toLowerCase()} AND upload_state = 'concluido'
        AND storage_key IS NOT NULL
      LIMIT 1
    `;

    await this.sql`
      INSERT INTO attachments (id, record_id, form_id, field_id, mime_type, hash, bytes,
                               upload_state, storage_key, uploaded_at)
      VALUES (${dados.id}, ${dados.record_id}, ${registo.form_id}, ${dados.field_id},
              ${dados.mime_type}, ${dados.hash.toLowerCase()}, ${dados.bytes},
              ${jaExiste ? 'concluido' : 'pendente'}, ${jaExiste?.storage_key ?? chave},
              -- Texto com cast, e não um Date: o driver perde o tipo de um
              -- Date passado como parâmetro e rebenta com um
              -- ERR_INVALID_ARG_TYPE que não aponta para nada.
              ${jaExiste ? new Date().toISOString() : null}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        field_id = EXCLUDED.field_id, mime_type = EXCLUDED.mime_type,
        hash = EXCLUDED.hash, bytes = EXCLUDED.bytes
    `;

    if (jaExiste) {
      // Nem um byte de rede. É a diferença entre subir 30 fotos e subir 3.
      return { id: dados.id, ja_existe: true, storage_key: jaExiste.storage_key, upload: null };
    }

    return {
      id: dados.id,
      ja_existe: false,
      storage_key: chave,
      upload: this.armazenamento.paraEnviar(chave, dados.mime_type),
    };
  }

  /** O cliente confirma que o upload terminou. */
  @Post(':id/complete')
  async completar(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = completo.parse(body ?? {});
    const anexo = await this.anexo(id, principal);

    if (dados.bytes !== undefined && anexo.bytes !== null && dados.bytes !== anexo.bytes) {
      // O tamanho não bater significa upload truncado. Marcar como concluído
      // deixaria um ficheiro partido preso a um registo, e ninguém daria por
      // isso até tentar abri-lo.
      await this.sql`UPDATE attachments SET upload_state = 'falhado' WHERE id = ${id}`;
      throw new BadRequestException(
        `o ficheiro enviado tem ${dados.bytes} bytes e o anunciado tinha ${anexo.bytes}: upload truncado`,
      );
    }

    await this.sql`
      UPDATE attachments SET upload_state = 'concluido', uploaded_at = now()
      WHERE id = ${id} AND upload_state <> 'concluido'
    `;
    return { id, estado: 'concluido' };
  }

  /** URL temporário para ver ou descarregar o anexo. */
  @Get(':id/url')
  async url(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const anexo = await this.anexo(id, principal);
    if (anexo.upload_state !== 'concluido' || !anexo.storage_key) {
      throw new NotFoundException('o anexo ainda não subiu');
    }
    return this.armazenamento.paraDescarregar(anexo.storage_key);
  }

  /** O que falta subir de um registo. É o que a app mostra ao técnico. */
  @Get('pendentes/:recordId')
  async pendentes(@UtilizadorActual() principal: Principal, @Param('recordId') recordId: string) {
    await this.registo(recordId, principal);
    const linhas = await this.sql`
      SELECT id, field_id, mime_type, bytes, upload_state, hash
      FROM attachments WHERE record_id = ${recordId} AND upload_state <> 'concluido'
      ORDER BY created_at
    `;
    return { pendentes: linhas };
  }

  private async registo(recordId: string, principal: Principal) {
    const [linha] = await this.sql<Array<{ form_id: string; created_by: string | null }>>`
      SELECT form_id, created_by FROM records
      WHERE id = ${recordId} AND org_id = ${principal.orgId} AND deleted_at IS NULL
    `;
    if (!linha) throw new NotFoundException('registo inexistente');

    const permissoes = await this.acesso.permissoes(principal, linha.form_id);
    const proprio = linha.created_by === principal.userId;
    // ADR-0011: quem recolheu continua a poder subir os anexos do que recolheu.
    if (!permissoes && !proprio) {
      throw new ForbiddenException('sem acesso a este registo');
    }
    return linha;
  }

  private async anexo(id: string, principal: Principal) {
    const [linha] = await this.sql<
      Array<{
        id: string;
        record_id: string;
        bytes: number | null;
        upload_state: string;
        storage_key: string | null;
      }>
    >`SELECT id, record_id, bytes, upload_state, storage_key FROM attachments WHERE id = ${id}`;
    if (!linha) throw new NotFoundException('anexo inexistente');
    await this.registo(linha.record_id, principal);
    return linha;
  }
}

/**
 * Extensão a partir do tipo MIME.
 *
 * Não se usa a extensão que o cliente manda: um ficheiro chamado `.jpg` que na
 * verdade é outra coisa é a forma mais antiga de enganar um armazenamento.
 */
function extensaoDe(mime: string): string {
  const mapa: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
  };
  return mapa[mime] ?? '';
}
