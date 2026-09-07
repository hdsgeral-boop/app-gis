import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { mapLayers, projects } from '@cvforms/db/schema';
import { z } from 'zod';
import type postgres from 'postgres';

import { ArmazenamentoService } from '../attachments/armazenamento.service.js';
import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { ENV, type Env } from '../config/env.js';
import { Papeis } from '../auth/roles.decorator.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import { uuidv7 } from '../lib/uuidv7.js';
import type { Principal } from '../auth/principal.js';

/**
 * Camadas de mapa (F8, ADR-0005).
 *
 * TRÊS DECISÕES QUE GOVERNAM ESTE FICHEIRO:
 *
 * 1. **O ficheiro não passa pela API.** Um PMTiles de uma província são 200 a
 *    500 MB. Sobe e desce directamente do armazenamento, com URL assinado, tal
 *    como os anexos (F9.3). A API só assina a autorização e guarda os
 *    metadados.
 * 2. **Nunca há mosaicos do Google guardados.** A restrição inegociável 1
 *    proíbe-o, e não é uma questão de esforço — são os termos da Google Maps
 *    Platform. Um estilo online é um tipo separado (`estilo_online`) e o que é
 *    online fica online.
 * 3. **Uma camada grande não se impõe a ninguém.** Só as marcadas com
 *    `auto_download` é que a app vai buscar sozinha, e só em Wi-Fi. As outras
 *    ficam à espera de o técnico as escolher.
 *
 * Ler é para toda a gente da organização — um técnico precisa da lista para
 * escolher o que descarrega. Escrever é só de administração.
 */

const criarCamada = z
  .object({
    nome: z.string().min(1).max(200),
    descricao: z.string().max(1000).optional(),
    tipo: z.enum(['pmtiles', 'estilo_online']),
    /** NULL = serve toda a organização. */
    projecto_id: z.string().uuid().optional(),
    /** Só para `estilo_online`. */
    style_url: z.string().url().optional(),
    /** `oeste,sul,este,norte` em WGS84. */
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    zoom_min: z.number().int().min(0).max(24).optional(),
    zoom_max: z.number().int().min(0).max(24).optional(),
    descarga_automatica: z.boolean().default(false),
    por_omissao: z.boolean().default(false),
  })
  .refine((v) => v.tipo !== 'estilo_online' || !!v.style_url, {
    message: 'um estilo online precisa de style_url',
    path: ['style_url'],
  });

const prepararUpload = z.object({
  /** SHA-256 do ficheiro, em hexadecimal. */
  hash: z.string().regex(/^[a-f0-9]{64}$/i, 'o hash tem de ser um SHA-256 em hexadecimal'),
  bytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024, 'acima de 2 GB, corta o mapa em áreas mais pequenas'),
});

const confirmarUpload = z.object({
  bytes: z.number().int().positive().optional(),
  zoom_min: z.number().int().min(0).max(24).optional(),
  zoom_max: z.number().int().min(0).max(24).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

@Controller('mapas')
export class MapasController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql },
    @Inject(ENV) private readonly env: Env,
    private readonly armazenamento: ArmazenamentoService,
  ) {}

  /**
   * As camadas que este utilizador pode usar.
   *
   * Filtradas pelos projectos a que ele chega: um mapa do Uíge não tem que
   * ocupar 300 MB no telefone de quem trabalha em Luanda.
   */
  @Get('camadas')
  async listar(
    @UtilizadorActual() principal: Principal,
    @Query('projecto_id') projectoId?: string,
  ) {
    const linhas = await this.db
      .select()
      .from(mapLayers)
      .where(
        and(
          eq(mapLayers.orgId, principal.orgId),
          isNull(mapLayers.archivedAt),
          projectoId
            ? or(eq(mapLayers.projectId, projectoId), isNull(mapLayers.projectId))
            : undefined,
        ),
      );

    return {
      camadas: linhas.map((l) => ({
        id: l.id,
        nome: l.name,
        descricao: l.description,
        tipo: l.kind,
        projecto_id: l.projectId,
        bytes: l.bytes,
        sha256: l.sha256,
        zoom_min: l.minZoom,
        zoom_max: l.maxZoom,
        style_url: l.styleUrl,
        descarga_automatica: l.autoDownload,
        por_omissao: l.isDefault,
      })),
    };
  }

  /**
   * URL assinado para descarregar o ficheiro de uma camada.
   *
   * Válido por seis horas: um PMTiles de 300 MB por uma ligação de campo pode
   * levar uma noite, e obrigar a pedir outro URL a meio seria perder o que já
   * tinha descarregado.
   */
  @Get('camadas/:id/url')
  async url(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const camada = await this.exigirCamada(principal, id);
    if (camada.kind !== 'pmtiles' || !camada.storageKey) {
      throw new BadRequestException('esta camada não tem ficheiro para descarregar');
    }
    const assinado = this.armazenamento.paraDescarregar(camada.storageKey, 6 * 60 * 60, {
      balde: this.env.S3_BUCKET_MAPAS,
    });
    return {
      url: assinado.url,
      expira_em: assinado.expiraEm,
      bytes: camada.bytes,
      sha256: camada.sha256,
    };
  }

  // ── Administração ────────────────────────────────────────────────────────

  @Post('camadas')
  @Papeis('admin', 'gestor')
  async criar(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = criarCamada.parse(body);

    if (dados.projecto_id) {
      const [projecto] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, dados.projecto_id), eq(projects.orgId, principal.orgId)))
        .limit(1);
      if (!projecto) throw new BadRequestException('projecto inexistente nesta organização');
    }

    const id = uuidv7();
    // O `is_default` tem um índice único parcial: tirar o anterior antes de
    // pôr o novo evita um erro que, para quem carrega um mapa, não diz nada.
    if (dados.por_omissao) {
      await this.db
        .update(mapLayers)
        .set({ isDefault: false })
        .where(and(eq(mapLayers.orgId, principal.orgId), eq(mapLayers.isDefault, true)));
    }

    await this.holder.client`
      INSERT INTO map_layers (id, org_id, project_id, kind, name, description, style_url,
                              min_zoom, max_zoom, auto_download, is_default, created_by, bounds)
      VALUES (${id}, ${principal.orgId}, ${dados.projecto_id ?? null}, ${dados.tipo}::map_layer_kind,
              ${dados.nome}, ${dados.descricao ?? null}, ${dados.style_url ?? null},
              ${dados.zoom_min ?? null}, ${dados.zoom_max ?? null},
              ${dados.descarga_automatica}, ${dados.por_omissao}, ${principal.userId ?? null},
              ${caixaParaSql(dados.bbox)})
    `;

    return { id, tipo: dados.tipo };
  }

  /**
   * Prepara o upload de um `.pmtiles`.
   *
   * A chave deriva do hash do conteúdo: dois administradores que carreguem o
   * mesmo mapa não o guardam duas vezes, e voltar a carregar um ficheiro já lá
   * dentro não gasta rede nenhuma.
   */
  @Post('camadas/:id/upload')
  @Papeis('admin', 'gestor')
  async upload(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = prepararUpload.parse(body);
    const camada = await this.exigirCamada(principal, id);
    if (camada.kind !== 'pmtiles') {
      throw new BadRequestException('só uma camada `pmtiles` recebe ficheiro');
    }

    const chave = `${principal.orgId}/${dados.hash.toLowerCase()}.pmtiles`;
    const assinado = this.armazenamento.paraEnviar(chave, 'application/octet-stream', 6 * 60 * 60, {
      balde: this.env.S3_BUCKET_MAPAS,
    });

    // O metadado é escrito ANTES do upload, com o estado por confirmar. Se o
    // upload falhar a meio, fica uma linha a apontar para um ficheiro que não
    // existe — e é por isso que a app só usa camadas confirmadas (`bytes` não
    // nulo).
    await this.db
      .update(mapLayers)
      .set({ storageKey: chave, sha256: dados.hash.toLowerCase() })
      .where(eq(mapLayers.id, id));

    return {
      url: assinado.url,
      metodo: assinado.metodo,
      cabecalhos: assinado.cabecalhos,
      expira_em: assinado.expiraEm,
      chave,
    };
  }

  /** Confirma que o ficheiro subiu. Só depois disto a app o vai buscar. */
  @Post('camadas/:id/completo')
  @Papeis('admin', 'gestor')
  async completo(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = confirmarUpload.parse(body);
    await this.exigirCamada(principal, id);

    await this.holder.client`
      UPDATE map_layers
      SET bytes = COALESCE(${dados.bytes ?? null}, bytes),
          min_zoom = COALESCE(${dados.zoom_min ?? null}, min_zoom),
          max_zoom = COALESCE(${dados.zoom_max ?? null}, max_zoom),
          bounds = COALESCE(${caixaParaSql(dados.bbox)}, bounds)
      WHERE id = ${id}
    `;
    return { confirmado: true };
  }

  /**
   * Arquiva uma camada. Não apaga o ficheiro.
   *
   * O ficheiro pode estar em telefones que ainda não sincronizaram, e apagá-lo
   * do armazenamento não o tira de lá — só quebra quem o tentar descarregar a
   * seguir. Limpar o armazenamento é uma operação de manutenção separada.
   */
  @Delete('camadas/:id')
  @Papeis('admin', 'gestor')
  async arquivar(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirCamada(principal, id);
    await this.db
      .update(mapLayers)
      .set({ archivedAt: new Date(), isDefault: false })
      .where(eq(mapLayers.id, id));
    return { arquivada: true };
  }

  private async exigirCamada(principal: Principal, id: string) {
    const [camada] = await this.db
      .select()
      .from(mapLayers)
      .where(and(eq(mapLayers.id, id), eq(mapLayers.orgId, principal.orgId)))
      .limit(1);
    if (!camada) throw new NotFoundException('camada inexistente nesta organização');
    return camada;
  }
}

/**
 * `oeste,sul,este,norte` → um polígono do PostGIS, ou NULL.
 *
 * Escrito como texto WKT e não com `ST_MakeEnvelope` interpolado: os números
 * vêm validados pelo Zod, mas construir SQL com eles à mão é o género de coisa
 * que se copia para outro sítio onde já não vêm validados.
 */
function caixaParaSql(bbox: [number, number, number, number] | undefined): string | null {
  if (!bbox) return null;
  const [o, s, e, n] = bbox;
  if (o >= e || s >= n) throw new BadRequestException('bbox é oeste,sul,este,norte');
  return `SRID=4326;POLYGON((${o} ${s},${e} ${s},${e} ${n},${o} ${n},${o} ${s}))`;
}
