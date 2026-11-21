import {check, text, timestamp, uniqueIndex, uuid} from "drizzle-orm/pg-core";
import {and, eq, sql} from "drizzle-orm";
import {Refined_Schema} from "../system/system-schema.ts";
import {Processed_Toast_Locations, Processed_Toast_Orders} from "../toast/toast-schema.ts";

export const Refined_Food_And_Beverage_Outlets = Refined_Schema.table("food_and_beverage_outlets", {
  id : uuid("id").primaryKey().defaultRandom(),

  toast_location_id : text("toast_location_id"),
  infogenesis_location_id : text("infogenesis_location_id"),

  outlet_name : text("outlet_name").notNull(),

  created_at : timestamp("created_at", {withTimezone : true}).notNull().defaultNow(),
  updated_at : timestamp("updated_at", {withTimezone : true}).notNull().defaultNow()
}, table => [
  uniqueIndex("food_and_beverage_outlets_outlet_name_idx").on(table.outlet_name),
  uniqueIndex("food_and_beverage_outlets_toast_location_id_idx").on(table.toast_location_id),
  uniqueIndex("food_and_beverage_outlets_infogenesis_location_id_idx").on(table.infogenesis_location_id),
  check("food_and_beverage_outlets_outlet_name_not_blank", sql`btrim(${table.outlet_name}) <> ''`)
]);

export const Refined_Food_And_Beverage_Sales = Refined_Schema.view("food_and_beverage_sales").as(query_builder =>
  query_builder
    .select({
      outlet_id : sql<string>`${Refined_Food_And_Beverage_Outlets.id}`.as("outlet_id"),
      source_system : Processed_Toast_Orders.source_system,
      source_record_id : Processed_Toast_Orders.source_record_id,
      business_date : Processed_Toast_Orders.business_date,
      net_sales_amount : Processed_Toast_Orders.net_sales_amount,
      sale_created_at : sql<Date>`${Processed_Toast_Orders.source_created_at}`
        .mapWith(Processed_Toast_Orders.source_created_at)
        .as("sale_created_at")
    })
    .from(Processed_Toast_Orders)
    .innerJoin(Processed_Toast_Locations, eq(Processed_Toast_Orders.location_id, Processed_Toast_Locations.id))
    .innerJoin(
      Refined_Food_And_Beverage_Outlets,
      eq(Refined_Food_And_Beverage_Outlets.toast_location_id, Processed_Toast_Locations.source_record_id)
    )
    .where(and(
      eq(Processed_Toast_Orders.voided, false),
      eq(Processed_Toast_Orders.deleted, false),
      eq(Processed_Toast_Orders.excess_food, false),
      eq(Processed_Toast_Orders.created_in_test_mode, false)
    ))
);