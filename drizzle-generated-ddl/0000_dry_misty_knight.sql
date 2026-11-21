CREATE SCHEMA "processed";
--> statement-breakpoint
CREATE SCHEMA "raw";
--> statement-breakpoint
CREATE SCHEMA "system";
--> statement-breakpoint
CREATE TYPE "system"."pipeline_execution_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'cancelled', 'abandoned');--> statement-breakpoint
CREATE TABLE "system"."pipeline_operation_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_state_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"status" "system"."pipeline_execution_status" DEFAULT 'running' NOT NULL,
	"ingestion_watermark_before" timestamp with time zone,
	"ingestion_watermark_after" timestamp with time zone,
	"error_summary" text,
	"records_read" integer,
	"records_loaded" integer DEFAULT 0 NOT NULL,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system"."pipeline_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_name" text NOT NULL,
	"ingestion_watermark" timestamp with time zone,
	"last_successful_ingestion_at" timestamp with time zone,
	"last_successful_processing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_state_pipeline_name_unique" UNIQUE("pipeline_name")
);
--> statement-breakpoint
CREATE TABLE "processed"."toast_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_record_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"voided" boolean NOT NULL,
	"source_created_at" timestamp with time zone NOT NULL,
	"source_modified_at" timestamp with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"raw_content_revision" integer NOT NULL,
	"processing_version" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed"."toast_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_record_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'unclassified' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"raw_content_revision" integer NOT NULL,
	"processing_version" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "toast_locations_name_not_blank" CHECK (btrim("processed"."toast_locations"."name") <> ''),
	CONSTRAINT "toast_locations_type_valid" CHECK ("processed"."toast_locations"."type" IN ('food_and_beverage', 'retail', 'unclassified'))
);
--> statement-breakpoint
CREATE TABLE "processed"."toast_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_record_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"business_date" date NOT NULL,
	"voided" boolean NOT NULL,
	"excess_food" boolean NOT NULL,
	"created_in_test_mode" boolean NOT NULL,
	"source_created_at" timestamp with time zone NOT NULL,
	"source_modified_at" timestamp with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"raw_content_revision" integer NOT NULL,
	"processing_version" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "system"."pipeline_operation_history" ADD CONSTRAINT "pipeline_operation_history_pipeline_state_id_pipeline_state_id_fk" FOREIGN KEY ("pipeline_state_id") REFERENCES "system"."pipeline_state"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_checks" ADD CONSTRAINT "toast_checks_raw_record_id_toast_orders_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "raw"."toast_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_checks" ADD CONSTRAINT "toast_checks_order_id_toast_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "processed"."toast_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_checks" ADD CONSTRAINT "toast_checks_execution_id_pipeline_operation_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_operation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_locations" ADD CONSTRAINT "toast_locations_raw_record_id_toast_locations_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "raw"."toast_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_locations" ADD CONSTRAINT "toast_locations_execution_id_pipeline_operation_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_operation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD CONSTRAINT "toast_orders_raw_record_id_toast_orders_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "raw"."toast_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD CONSTRAINT "toast_orders_location_id_toast_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "processed"."toast_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD CONSTRAINT "toast_orders_execution_id_pipeline_operation_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_operation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw"."toast_locations" ADD CONSTRAINT "toast_locations_execution_id_pipeline_operation_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_operation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw"."toast_orders" ADD CONSTRAINT "toast_orders_execution_id_pipeline_operation_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_operation_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_operation_history_state_started_at_idx" ON "system"."pipeline_operation_history" USING btree ("pipeline_state_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_checks_source_identity_idx" ON "processed"."toast_checks" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_checks_order_id_idx" ON "processed"."toast_checks" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "toast_checks_raw_record_id_idx" ON "processed"."toast_checks" USING btree ("raw_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_locations_source_identity_idx" ON "processed"."toast_locations" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_locations_raw_record_id_idx" ON "processed"."toast_locations" USING btree ("raw_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_orders_source_identity_idx" ON "processed"."toast_orders" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_orders_raw_record_id_idx" ON "processed"."toast_orders" USING btree ("raw_record_id");--> statement-breakpoint
CREATE INDEX "toast_orders_location_business_date_idx" ON "processed"."toast_orders" USING btree ("location_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_locations_source_identity_idx" ON "raw"."toast_locations" USING btree ("record_source","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_locations_pending_processing_idx" ON "raw"."toast_locations" USING btree ("processed","id");--> statement-breakpoint
CREATE INDEX "toast_locations_execution_idx" ON "raw"."toast_locations" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toast_orders_source_identity_idx" ON "raw"."toast_orders" USING btree ("record_source","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_orders_pending_processing_idx" ON "raw"."toast_orders" USING btree ("processed","id");--> statement-breakpoint
CREATE INDEX "toast_orders_execution_idx" ON "raw"."toast_orders" USING btree ("execution_id");