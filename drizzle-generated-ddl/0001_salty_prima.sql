CREATE SCHEMA "raw";
--> statement-breakpoint
CREATE TABLE "raw"."toast_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"record_source" text DEFAULT 'toast_orders' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw"."toast_orders" ADD CONSTRAINT "toast_orders_execution_id_pipeline_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "toast_orders_source_identity_idx" ON "raw"."toast_orders" USING btree ("record_source","source_record_id");--> statement-breakpoint
CREATE INDEX "toast_orders_pending_processing_idx" ON "raw"."toast_orders" USING btree ("processed","id");--> statement-breakpoint
CREATE INDEX "toast_orders_execution_idx" ON "raw"."toast_orders" USING btree ("execution_id");