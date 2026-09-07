/**
 * Esquema físico do Consul Colect.
 *
 * A regra que governa este ficheiro: **publicar um formulário nunca altera o
 * esquema** (restrição inegociável 5). As respostas de todos os formulários,
 * de todos os projectos, de todas as organizações vivem numa só tabela
 * `record_revisions`, em JSONB. As colunas tipadas que o QGIS e o Power BI
 * consomem são VISTAS geradas ao publicar, não tabelas.
 *
 * Se alguma vez aparecer aqui uma tabela por formulário, o desenho falhou.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `geometry(Point,4326)` do PostGIS.
 *
 * Point e não Geography: o QGIS, o ArcGIS e o Power BI ligam-se a
 * `geometry(Point,4326)` sem cast nenhum, e o `geography` obrigava a
 * `::geometry` em todas as consultas de quem consome os dados. Distâncias em
 * metros fazem-se com `ST_DistanceSphere` ou reprojectando. Ver ADR-0009.
 */
const geometryPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Point,4326)';
  },
});

/** `geometry(Polygon,4326)`. Só os limites de uma camada de mapa a usam. */
const geometryPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Polygon,4326)';
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Enumerações
// ─────────────────────────────────────────────────────────────────────────────

export const recordStatus = pgEnum('record_status', [
  'rascunho',
  'submetido',
  'validado',
  'rejeitado',
  'needs_review',
]);

export const principalType = pgEnum('principal_type', ['user', 'role', 'team']);

export const gnssFixType = pgEnum('gnss_fix_type', [
  'single',
  'dgps',
  'float',
  'fixed',
  'has_ppp',
  'manual',
  'unknown',
]);

export const gnssSource = pgEnum('gnss_source', [
  'internal',
  'external_bt',
  'external_tcp',
  'manual',
]);

export const mapLayerKind = pgEnum('map_layer_kind', ['pmtiles', 'estilo_online']);

export const attachmentState = pgEnum('attachment_state', [
  'pendente',
  'a_subir',
  'concluido',
  'falhado',
]);

export const auditAction = pgEnum('audit_action', [
  'criar',
  'actualizar',
  'apagar',
  'restaurar',
  'publicar',
  'arquivar',
  'atribuir',
  'exportar',
  'entrar',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Organização e identidade
// ─────────────────────────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

/** Espelho do Keycloak. A verdade da identidade está lá, não aqui. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    /** `sub` do JWT do Keycloak. */
    subject: text('subject').notNull(),
    username: text('username').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    active: boolean('active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_subject_uk').on(t.subject),
    uniqueIndex('users_org_username_uk').on(t.orgId, t.username),
    index('users_org_idx').on(t.orgId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Papéis do sistema não podem ser apagados pelo administrador. */
    system: boolean('system').notNull().default(false),
  },
  (t) => [uniqueIndex('roles_org_key_uk').on(t.orgId, t.key)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('teams_org_key_uk').on(t.orgId, t.key)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('projects_org_key_uk').on(t.orgId, t.key),
    index('projects_org_idx').on(t.orgId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Formulários
// ─────────────────────────────────────────────────────────────────────────────

/** Identidade estável do formulário. A definição vive nas versões. */
export const forms = pgTable(
  'forms',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** Editável. Dá nome às vistas geradas; nunca é chave de dados. */
    key: text('key').notNull(),
    title: jsonb('title').notNull(),
    /** Número da versão publicada corrente. NULL enquanto só houver rascunhos. */
    currentVersion: integer('current_version'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Arquivar apaga as vistas. Nunca apaga um único registo. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Id do campo cuja resposta define o âmbito de um registo (F6.4). NULL = o
     * formulário não tem âmbito. É um `id` de campo e nunca um nome de coluna:
     * renomear a pergunta não pode partir o isolamento.
     */
    scopeFieldId: text('scope_field_id'),
  },
  (t) => [
    uniqueIndex('forms_project_key_uk').on(t.projectId, t.key),
    index('forms_org_idx').on(t.orgId),
  ],
);

/**
 * Uma versão publicada. IMUTÁVEL — garantido por trigger, não por convenção.
 * `published_at` NULL significa rascunho, e só o rascunho pode ser alterado.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: uuid('id').primaryKey(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    /** SHA-256 da definição canonicalizada. A app usa-o para saber se mudou. */
    hash: text('hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_versions_form_version_uk').on(t.formId, t.version),
    index('form_versions_form_idx').on(t.formId),
  ],
);

/**
 * Quem vê o quê. Ninguém vê um formulário que não lhe foi atribuído — a app
 * nem sequer descarrega a definição (ESPECIFICACAO.md §2).
 */
export const formAssignments = pgTable(
  'form_assignments',
  {
    id: uuid('id').primaryKey(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    principalType: principalType('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    canRead: boolean('can_read').notNull().default(true),
    canCreate: boolean('can_create').notNull().default(false),
    canEditOwn: boolean('can_edit_own').notNull().default(false),
    canEditAll: boolean('can_edit_all').notNull().default(false),
    canDelete: boolean('can_delete').notNull().default(false),
    /** Restringe o âmbito dos registos visíveis (ex.: por município). */
    scopeFilter: jsonb('scope_filter'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_assignments_uk').on(t.formId, t.principalType, t.principalId),
    index('form_assignments_principal_idx').on(t.principalType, t.principalId),
  ],
);

/**
 * Acesso já resolvido: uma linha por (utilizador, formulário).
 *
 * DERIVADA de `form_assignments` + `team_members` + `user_roles`, e mantida
 * por trigger (migração 0003). Nunca se escreve aqui à mão.
 *
 * Existe porque as regras de sincronização do PowerSync não aceitam
 * subconsultas nem junções: sem esta tabela, «quem vê o quê» não é exprimível
 * numa parameter query. Serve também as políticas RLS e o `/me`.
 */
export const formAccess = pgTable(
  'form_access',
  {
    /** Chave de substituição: o PowerSync exige `id` em tudo o que sincroniza. */
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    canRead: boolean('can_read').notNull().default(false),
    canCreate: boolean('can_create').notNull().default(false),
    canEditOwn: boolean('can_edit_own').notNull().default(false),
    canEditAll: boolean('can_edit_all').notNull().default(false),
    canDelete: boolean('can_delete').notNull().default(false),
    /** NULL = sem restrição de âmbito. Array vazio = não vê registo nenhum. */
    scopeValues: text('scope_values').array(),
  },
  (t) => [
    uniqueIndex('form_access_user_form_uk').on(t.userId, t.formId),
    index('form_access_form_idx').on(t.formId),
  ],
);

/**
 * Um valor de âmbito por linha, derivado de `form_access.scope_values`.
 *
 * Existe pela mesma razão que `form_access`: as parameter queries do PowerSync
 * não percorrem arrays. Sem esta tabela o filtro de âmbito valeria na API e no
 * RLS e não valeria na descida para o telefone — que é o caminho por onde os
 * registos chegam ao técnico.
 */
export const formAccessScopes = pgTable(
  'form_access_scopes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    scopeValue: text('scope_value').notNull(),
  },
  (t) => [
    uniqueIndex('form_access_scopes_uk').on(t.userId, t.formId, t.scopeValue),
    index('form_access_scopes_user_idx').on(t.userId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Registos e revisões
// ─────────────────────────────────────────────────────────────────────────────

export const records = pgTable(
  'records',
  {
    /** UUIDv7 gerado no cliente (restrição inegociável 3). */
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id),
    /** A versão com que o registo foi criado. Reabrir usa esta, não a corrente. */
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => formVersions.id),
    currentRevisionId: uuid('current_revision_id'),
    geom: geometryPoint('geom'),
    status: recordStatus('status').notNull().default('rascunho'),
    createdBy: uuid('created_by').references(() => users.id),
    /** Relógio do dispositivo. NUNCA usado para ordenar (ver ESPECIFICACAO §13.8). */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete com tombstone. Nunca há DELETE (restrição inegociável 4). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id),
    /** Desnormalizado da revisão corrente por trigger. Ver migração 0005. */
    scopeValue: text('scope_value'),
  },
  (t) => [
    index('records_form_updated_idx').on(t.formId, t.updatedAt),
    index('records_form_scope_idx').on(t.formId, t.scopeValue),
    index('records_project_idx').on(t.projectId),
    index('records_org_idx').on(t.orgId),
    index('records_status_idx').on(t.formId, t.status),
    index('records_created_by_idx').on(t.createdBy),
  ],
);

/**
 * APPEND-ONLY. Garantido por trigger (restrição inegociável 4).
 * `data` está indexado por `id` de campo — nunca por `name`.
 */
export const recordRevisions = pgTable(
  'record_revisions',
  {
    id: uuid('id').primaryKey(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    /**
     * Redundante — deriva do registo — e mantido por trigger. Existe porque as
     * data queries do PowerSync não aceitam subconsultas: sem ele não há forma
     * de filtrar as revisões pelo formulário do bucket.
     */
    formId: uuid('form_id'),
    revisionNo: integer('revision_no').notNull(),
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => formVersions.id),
    data: jsonb('data').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    deviceId: text('device_id'),
    /** A revisão sobre a qual esta foi construída. NULL na primeira. */
    baseRevisionId: uuid('base_revision_id'),
    /** Relógio do dispositivo, informativo. */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }),
    /** Relógio do servidor. É este que ordena. */
    serverReceivedAt: timestamp('server_received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Justificação escrita quando se gravou acima do limiar de precisão. */
    accuracyOverrideReason: text('accuracy_override_reason'),
    /**
     * Âmbito desta revisão, tirado dos seus próprios dados por trigger. É
     * intrínseco e imutável — nunca obriga a tocar numa revisão já gravada.
     */
    scopeValue: text('scope_value'),
  },
  (t) => [
    uniqueIndex('record_revisions_record_no_uk').on(t.recordId, t.revisionNo),
    index('record_revisions_record_idx').on(t.recordId),
    index('record_revisions_base_idx').on(t.baseRevisionId),
    index('record_revisions_received_idx').on(t.serverReceivedAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Anexos, GNSS, auditoria, sincronização
// ─────────────────────────────────────────────────────────────────────────────

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    /** Como em `record_revisions`: redundante, mantido por trigger, e é o que
     * torna a regra de sincronização exprimível. */
    formId: uuid('form_id'),
    revisionId: uuid('revision_id').references(() => recordRevisions.id),
    /** `id` do campo photo/audio/file/signature que gerou este anexo. */
    fieldId: text('field_id').notNull(),
    mimeType: text('mime_type'),
    /** SHA-256 do conteúdo. Deduplica e detecta uploads corrompidos. */
    hash: text('hash'),
    bytes: integer('bytes'),
    uploadState: attachmentState('upload_state').notNull().default('pendente'),
    storageKey: text('storage_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    /** Herdado da revisão que o gerou, por trigger. Ver migração 0005. */
    scopeValue: text('scope_value'),
  },
  (t) => [
    index('attachments_record_idx').on(t.recordId),
    index('attachments_state_idx').on(t.uploadState),
    index('attachments_hash_idx').on(t.hash),
  ],
);

/**
 * Metadados de cada fixo GNSS guardado. Todo o ponto leva `accuracy_m`,
 * `fix_type` e `source` (restrição inegociável 8) — por isso são NOT NULL.
 */
export const gpsFixes = pgTable(
  'gps_fixes',
  {
    id: uuid('id').primaryKey(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    revisionId: uuid('revision_id').references(() => recordRevisions.id),
    fieldId: text('field_id').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    alt: doublePrecision('alt'),
    accuracyM: real('accuracy_m').notNull(),
    fixType: gnssFixType('fix_type').notNull(),
    source: gnssSource('source').notNull(),
    satellites: smallint('satellites'),
    pdop: real('pdop'),
    hdop: real('hdop'),
    receiverModel: text('receiver_model'),
    correctionsAgeS: real('corrections_age_s'),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
  },
  (t) => [
    index('gps_fixes_record_idx').on(t.recordId),
    index('gps_fixes_revision_idx').on(t.revisionId),
  ],
);

/** APPEND-ONLY, garantido por trigger. Nunca leva dados pessoais no payload. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    actorId: uuid('actor_id'),
    action: auditAction('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    /** Só metadados: contagens, ids, versões. Nunca o conteúdo das respostas. */
    metadata: jsonb('metadata'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_at_idx').on(t.orgId, t.at),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const syncState = pgTable(
  'sync_state',
  {
    deviceId: text('device_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    orgId: uuid('org_id').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    appVersion: text('app_version'),
    platform: text('platform'),
    /** Versões de formulário que o dispositivo tem em cache, por form_id. */
    knownFormVersions: jsonb('known_form_versions'),
    pendingUploads: integer('pending_uploads').notNull().default(0),
  },
  (t) => [index('sync_state_user_idx').on(t.userId)],
);

/**
 * Registo das vistas geradas ao publicar. É o que permite ao pipeline de
 * arquivo saber exactamente o que apagar, sem adivinhar por nome.
 */
export const generatedViews = pgTable(
  'generated_views',
  {
    id: uuid('id').primaryKey(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    formVersionId: uuid('form_version_id').references(() => formVersions.id, {
      onDelete: 'cascade',
    }),
    schemaName: text('schema_name').notNull(),
    viewName: text('view_name').notNull(),
    /** `null` na vista raiz; `id` do repeat na vista-filha. */
    repeatFieldId: text('repeat_field_id'),
    /** `view` ou `matview`, para a materialização da §3.3. */
    kind: text('kind').notNull().default('view'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('generated_views_uk').on(t.schemaName, t.viewName),
    index('generated_views_form_idx').on(t.formId),
  ],
);

/** Torna `POST` repetível em rede má sem duplicar registos. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
  },
  (t) => [index('idempotency_keys_expiry_idx').on(t.expiresAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Mapas (F8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Camadas de mapa: mosaicos PMTiles para offline, estilos MapLibre para online.
 *
 * O ficheiro NÃO está aqui — está no armazenamento de objectos, e o telefone
 * vai buscá-lo directamente com um URL assinado. É a mesma decisão da F9.3:
 * 300 MB a atravessar a API seguram a ligação durante minutos.
 *
 * Nunca há mosaicos do Google guardados: a restrição inegociável 1 proíbe-o, e
 * é por isso que `estilo_online` existe como tipo separado — o que é online
 * fica online.
 */
export const mapLayers = pgTable(
  'map_layers',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** NULL = serve toda a organização. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: mapLayerKind('kind').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Chave no armazenamento. NULL num `estilo_online`. */
    storageKey: text('storage_key'),
    /** URL do estilo MapLibre. NULL num `pmtiles`. */
    styleUrl: text('style_url'),
    bytes: bigint('bytes', { mode: 'number' }),
    /** SHA-256 do ficheiro. É como a app sabe que já o tem. */
    sha256: text('sha256'),
    bounds: geometryPolygon('bounds'),
    minZoom: smallint('min_zoom'),
    maxZoom: smallint('max_zoom'),
    /** Descarregada sozinha quando houver Wi-Fi. */
    autoDownload: boolean('auto_download').notNull().default(false),
    /** A que se mostra por baixo de tudo. Só uma por organização. */
    isDefault: boolean('is_default').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('map_layers_org_idx').on(t.orgId), index('map_layers_project_idx').on(t.projectId)],
);
