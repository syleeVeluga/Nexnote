CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_ai_policy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_folder_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_paths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"path" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"current_revision_id" uuid,
	"latest_published_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"base_revision_id" uuid,
	"actor_user_id" uuid,
	"model_run_id" uuid,
	"actor_type" text NOT NULL,
	"source" text NOT NULL,
	"content_md" text NOT NULL,
	"content_json" jsonb,
	"revision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_diffs" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"diff_md" text,
	"diff_ops_json" jsonb,
	"changed_blocks" integer
);
--> statement-breakpoint
CREATE TABLE "published_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"published_by_user_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"public_path" text NOT NULL,
	"title" text NOT NULL,
	"snapshot_md" text NOT NULL,
	"snapshot_html" text NOT NULL,
	"toc_json" jsonb,
	"is_live" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_id" uuid NOT NULL,
	"target_page_id" uuid,
	"proposed_revision_id" uuid,
	"model_run_id" uuid NOT NULL,
	"action" text NOT NULL,
	"proposed_page_title" text,
	"confidence" real NOT NULL,
	"rationale_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"api_token_id" uuid NOT NULL,
	"source_name" text NOT NULL,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"content_type" text NOT NULL,
	"title_hint" text,
	"raw_payload" jsonb NOT NULL,
	"normalized_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triple_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triple_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"span_start" integer NOT NULL,
	"span_end" integer NOT NULL,
	"excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_entity_id" uuid,
	"object_literal" text,
	"confidence" real NOT NULL,
	"source_page_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"extraction_model_run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triples_object_xor_check" CHECK (("triples"."object_entity_id" IS NOT NULL AND "triples"."object_literal" IS NULL) OR ("triples"."object_entity_id" IS NULL AND "triples"."object_literal" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"model_run_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model_name" text NOT NULL,
	"mode" text NOT NULL,
	"prompt_version" text NOT NULL,
	"token_input" integer,
	"token_output" integer,
	"latency_ms" integer,
	"status" text NOT NULL,
	"request_meta_json" jsonb,
	"response_meta_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_paths" ADD CONSTRAINT "page_paths_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_paths" ADD CONSTRAINT "page_paths_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_base_revision_id_page_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_diffs" ADD CONSTRAINT "revision_diffs_revision_id_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_snapshots" ADD CONSTRAINT "published_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_snapshots" ADD CONSTRAINT "published_snapshots_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_snapshots" ADD CONSTRAINT "published_snapshots_source_revision_id_page_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_snapshots" ADD CONSTRAINT "published_snapshots_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_decisions" ADD CONSTRAINT "ingestion_decisions_ingestion_id_ingestions_id_fk" FOREIGN KEY ("ingestion_id") REFERENCES "public"."ingestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_decisions" ADD CONSTRAINT "ingestion_decisions_target_page_id_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_decisions" ADD CONSTRAINT "ingestion_decisions_proposed_revision_id_page_revisions_id_fk" FOREIGN KEY ("proposed_revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_decisions" ADD CONSTRAINT "ingestion_decisions_model_run_id_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_api_token_id_api_tokens_id_fk" FOREIGN KEY ("api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triple_mentions" ADD CONSTRAINT "triple_mentions_triple_id_triples_id_fk" FOREIGN KEY ("triple_id") REFERENCES "public"."triples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triple_mentions" ADD CONSTRAINT "triple_mentions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triple_mentions" ADD CONSTRAINT "triple_mentions_revision_id_page_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_subject_entity_id_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_object_entity_id_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_source_page_id_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_source_revision_id_page_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."page_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triples" ADD CONSTRAINT "triples_extraction_model_run_id_model_runs_id_fk" FOREIGN KEY ("extraction_model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_model_run_id_model_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."model_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_runs" ADD CONSTRAINT "model_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_workspace_parent_slug_uk" ON "folders" USING btree ("workspace_id","parent_folder_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "page_paths_current_path_uk" ON "page_paths" USING btree ("workspace_id","path") WHERE "page_paths"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_workspace_folder_slug_uk" ON "pages" USING btree ("workspace_id","folder_id","slug");--> statement-breakpoint
CREATE INDEX "pages_workspace_folder_idx" ON "pages" USING btree ("workspace_id","folder_id","sort_order");--> statement-breakpoint
CREATE INDEX "page_revisions_page_created_idx" ON "page_revisions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "published_snapshots_page_live_uk" ON "published_snapshots" USING btree ("page_id") WHERE "published_snapshots"."is_live" = true;--> statement-breakpoint
CREATE INDEX "ingestion_decisions_ingestion_idx" ON "ingestion_decisions" USING btree ("ingestion_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestions_workspace_idempotency_uk" ON "ingestions" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ingestions_workspace_status_idx" ON "ingestions" USING btree ("workspace_id","status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_workspace_normalized_key_uk" ON "entities" USING btree ("workspace_id","normalized_key");--> statement-breakpoint
CREATE INDEX "triple_mentions_triple_idx" ON "triple_mentions" USING btree ("triple_id");--> statement-breakpoint
CREATE INDEX "triple_mentions_revision_idx" ON "triple_mentions" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "triples_workspace_subject_idx" ON "triples" USING btree ("workspace_id","subject_entity_id");--> statement-breakpoint
CREATE INDEX "triples_workspace_object_idx" ON "triples" USING btree ("workspace_id","object_entity_id");--> statement-breakpoint
CREATE INDEX "triples_source_page_idx" ON "triples" USING btree ("source_page_id");--> statement-breakpoint
CREATE INDEX "triples_source_revision_idx" ON "triples" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");