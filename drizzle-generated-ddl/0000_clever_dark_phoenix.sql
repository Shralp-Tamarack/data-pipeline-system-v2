CREATE SCHEMA "processed";
--> statement-breakpoint
CREATE SCHEMA "raw";
--> statement-breakpoint
CREATE SCHEMA "system";
--> statement-breakpoint
CREATE TYPE "system"."pipeline_execution_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'cancelled', 'abandoned');--> statement-breakpoint
CREATE TABLE "system"."pipeline_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_progress_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"status" "system"."pipeline_execution_status" DEFAULT 'running' NOT NULL,
	"ingestion_watermark_before" timestamp with time zone,
	"ingestion_watermark_after" timestamp with time zone,
	"error_summary" text,
	"records_loaded" integer DEFAULT 0 NOT NULL,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system"."pipeline_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_name" text NOT NULL,
	"ingestion_watermark" timestamp with time zone,
	"last_successful_ingestion_at" timestamp with time zone,
	"last_successful_processing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_progress_pipeline_name_unique" UNIQUE("pipeline_name")
);
--> statement-breakpoint
CREATE TABLE "raw"."toast_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"source_context" jsonb,
	"content" jsonb NOT NULL,
	"record_source" text DEFAULT 'toast_locations' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw"."toast_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"source_context" jsonb,
	"content" jsonb NOT NULL,
	"record_source" text DEFAULT 'toast_orders' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system"."pipeline_history" ADD CONSTRAINT "pipeline_history_pipeline_progress_id_pipeline_progress_id_fk" FOREIGN KEY ("pipeline_progress_id") REFERENCES "system"."pipeline_progress"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw"."toast_locations" ADD CONSTRAINT "toast_locations_execution_id_pipeline_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw"."toast_orders" ADD CONSTRAINT "toast_orders_execution_id_pipeline_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_execution_history_progress_started_at_idx" ON "system"."pipeline_history" USING btree ("pipeline_progress_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_locations_source_identity_idx" ON "raw"."toast_locations" USING btree ("record_source","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_locations_pending_processing_idx" ON "raw"."toast_locations" USING btree ("processed","id");--> statement-breakpoint
CREATE INDEX "toast_locations_execution_idx" ON "raw"."toast_locations" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_orders_source_identity_idx" ON "raw"."toast_orders" USING btree ("record_source","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_orders_pending_processing_idx" ON "raw"."toast_orders" USING btree ("processed","id");--> statement-breakpoint
CREATE INDEX "toast_orders_execution_idx" ON "raw"."toast_orders" USING btree ("execution_id");