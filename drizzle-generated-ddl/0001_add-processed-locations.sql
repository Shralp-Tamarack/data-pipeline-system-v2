CREATE TABLE "processed"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_record_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"name" text NOT NULL,
	"business_type" text DEFAULT 'unclassified' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"raw_content_revision" integer NOT NULL,
	"processing_version" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_name_not_blank" CHECK (btrim("processed"."locations"."name") <> ''),
	CONSTRAINT "locations_business_type_valid" CHECK ("processed"."locations"."business_type" IN ('food_and_beverage', 'retail', 'unclassified'))
);
--> statement-breakpoint
ALTER TABLE "processed"."locations" ADD CONSTRAINT "locations_raw_record_id_toast_locations_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "raw"."toast_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed"."locations" ADD CONSTRAINT "locations_execution_id_pipeline_history_id_fk" FOREIGN KEY ("execution_id") REFERENCES "system"."pipeline_history"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_source_identity_idx" ON "processed"."locations" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "locations_raw_record_id_idx" ON "processed"."locations" USING btree ("raw_record_id");