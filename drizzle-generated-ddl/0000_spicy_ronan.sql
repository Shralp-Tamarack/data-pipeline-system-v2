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
ALTER TABLE "system"."pipeline_history" ADD CONSTRAINT "pipeline_history_pipeline_progress_id_pipeline_progress_id_fk" FOREIGN KEY ("pipeline_progress_id") REFERENCES "system"."pipeline_progress"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_execution_history_progress_started_at_idx" ON "system"."pipeline_history" USING btree ("pipeline_progress_id","started_at");