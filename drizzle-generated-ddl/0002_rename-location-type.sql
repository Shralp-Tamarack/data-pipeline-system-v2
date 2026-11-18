ALTER TABLE "processed"."locations" RENAME COLUMN "business_type" TO "type";--> statement-breakpoint
ALTER TABLE "processed"."locations" DROP CONSTRAINT "locations_business_type_valid";--> statement-breakpoint
ALTER TABLE "processed"."locations" ADD CONSTRAINT "locations_type_valid" CHECK ("processed"."locations"."type" IN ('food_and_beverage', 'retail', 'unclassified'));