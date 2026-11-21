CREATE SCHEMA "refined";
--> statement-breakpoint
CREATE TABLE "refined"."food_and_beverage_outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"toast_location_id" text,
	"infogenesis_location_id" text,
	"outlet_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_and_beverage_outlets_outlet_name_not_blank" CHECK (btrim("refined"."food_and_beverage_outlets"."outlet_name") <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "food_and_beverage_outlets_outlet_name_idx" ON "refined"."food_and_beverage_outlets" USING btree ("outlet_name");--> statement-breakpoint
CREATE UNIQUE INDEX "food_and_beverage_outlets_toast_location_id_idx" ON "refined"."food_and_beverage_outlets" USING btree ("toast_location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "food_and_beverage_outlets_infogenesis_location_id_idx" ON "refined"."food_and_beverage_outlets" USING btree ("infogenesis_location_id");--> statement-breakpoint
CREATE VIEW "refined"."food_and_beverage_sales" AS (select "refined"."food_and_beverage_outlets"."id" as "outlet_id", "processed"."toast_orders"."source_system", "processed"."toast_orders"."source_record_id", "processed"."toast_orders"."business_date", "processed"."toast_orders"."net_sales_amount", "processed"."toast_orders"."source_created_at" as "sale_created_at" from "processed"."toast_orders" inner join "processed"."toast_locations" on "processed"."toast_orders"."location_id" = "processed"."toast_locations"."id" inner join "refined"."food_and_beverage_outlets" on "refined"."food_and_beverage_outlets"."toast_location_id" = "processed"."toast_locations"."source_record_id" where ("processed"."toast_orders"."voided" = false and "processed"."toast_orders"."deleted" = false and "processed"."toast_orders"."excess_food" = false and "processed"."toast_orders"."created_in_test_mode" = false));