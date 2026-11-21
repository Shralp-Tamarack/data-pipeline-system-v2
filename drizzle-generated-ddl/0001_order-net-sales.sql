ALTER TABLE "processed"."toast_checks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "processed"."toast_checks" CASCADE;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD COLUMN "net_sales_amount" numeric(14, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD COLUMN "check_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "processed"."toast_orders" ADD CONSTRAINT "toast_orders_check_count_not_negative" CHECK ("processed"."toast_orders"."check_count" >= 0);