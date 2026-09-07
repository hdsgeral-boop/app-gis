-- Extensões. Têm de existir antes de qualquer coluna geometry.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TYPE "public"."attachment_state" AS ENUM('pendente', 'a_subir', 'concluido', 'falhado');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('criar', 'actualizar', 'apagar', 'restaurar', 'publicar', 'arquivar', 'atribuir', 'exportar', 'entrar');--> statement-breakpoint
CREATE TYPE "public"."gnss_fix_type" AS ENUM('single', 'dgps', 'float', 'fixed', 'has_ppp', 'manual', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."gnss_source" AS ENUM('internal', 'external_bt', 'external_tcp', 'manual');--> statement-breakpoint
CREATE TYPE "public"."principal_type" AS ENUM('user', 'role', 'team');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('rascunho', 'submetido', 'validado', 'rejeitado', 'needs_review');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"revision_id" uuid,
	"field_id" text NOT NULL,
	"mime_type" text,
	"hash" text,
	"bytes" integer,
	"upload_state" "attachment_state" DEFAULT 'pendente' NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"principal_type" "principal_type" NOT NULL,
	"principal_id" uuid NOT NULL,
	"can_read" boolean DEFAULT true NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit_own" boolean DEFAULT false NOT NULL,
	"can_edit_all" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"scope_filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" jsonb NOT NULL,
	"current_version" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generated_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid,
	"schema_name" text NOT NULL,
	"view_name" text NOT NULL,
	"repeat_field_id" text,
	"kind" text DEFAULT 'view' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gps_fixes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"revision_id" uuid,
	"field_id" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"alt" double precision,
	"accuracy_m" real NOT NULL,
	"fix_type" "gnss_fix_type" NOT NULL,
	"source" "gnss_source" NOT NULL,
	"satellites" smallint,
	"pdop" real,
	"hdop" real,
	"receiver_model" text,
	"corrections_age_s" real,
	"collected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "organizations_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "record_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"form_version_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"author_id" uuid,
	"device_id" text,
	"base_revision_id" uuid,
	"client_created_at" timestamp with time zone,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accuracy_override_reason" text
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"current_revision_id" uuid,
	"geom" geometry(Point,4326),
	"status" "record_status" DEFAULT 'rascunho' NOT NULL,
	"created_by" uuid,
	"client_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"system" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"app_version" text,
	"platform" text,
	"known_form_versions" jsonb,
	"pending_uploads" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"display_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_revision_id_record_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."record_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_assignments" ADD CONSTRAINT "form_assignments_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_views" ADD CONSTRAINT "generated_views_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_views" ADD CONSTRAINT "generated_views_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_fixes" ADD CONSTRAINT "gps_fixes_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_fixes" ADD CONSTRAINT "gps_fixes_revision_id_record_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."record_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_record_idx" ON "attachments" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "attachments_state_idx" ON "attachments" USING btree ("upload_state");--> statement-breakpoint
CREATE INDEX "attachments_hash_idx" ON "attachments" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_log_org_at_idx" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_assignments_uk" ON "form_assignments" USING btree ("form_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "form_assignments_principal_idx" ON "form_assignments" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_uk" ON "form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE INDEX "form_versions_form_idx" ON "form_versions" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_project_key_uk" ON "forms" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "forms_org_idx" ON "forms" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generated_views_uk" ON "generated_views" USING btree ("schema_name","view_name");--> statement-breakpoint
CREATE INDEX "generated_views_form_idx" ON "generated_views" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "gps_fixes_record_idx" ON "gps_fixes" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "gps_fixes_revision_idx" ON "gps_fixes" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_key_uk" ON "projects" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_revisions_record_no_uk" ON "record_revisions" USING btree ("record_id","revision_no");--> statement-breakpoint
CREATE INDEX "record_revisions_record_idx" ON "record_revisions" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "record_revisions_base_idx" ON "record_revisions" USING btree ("base_revision_id");--> statement-breakpoint
CREATE INDEX "record_revisions_received_idx" ON "record_revisions" USING btree ("server_received_at");--> statement-breakpoint
CREATE INDEX "records_form_updated_idx" ON "records" USING btree ("form_id","updated_at");--> statement-breakpoint
CREATE INDEX "records_project_idx" ON "records" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "records_org_idx" ON "records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "records_status_idx" ON "records" USING btree ("form_id","status");--> statement-breakpoint
CREATE INDEX "records_created_by_idx" ON "records" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_key_uk" ON "roles" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "sync_state_user_idx" ON "sync_state" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_key_uk" ON "teams" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_subject_uk" ON "users" USING btree ("subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_username_uk" ON "users" USING btree ("org_id","username");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");