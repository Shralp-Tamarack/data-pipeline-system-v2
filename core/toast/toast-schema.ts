import {sql} from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  numeric
} from "drizzle-orm/pg-core";
import {
  create_processed_columns,
  create_raw_table,
  Processed_Schema
} from "../system/system-schema.ts";

export const toast_source_system_name = "toast";

export const toast_locations_pipeline_name =
  `${toast_source_system_name}_locations`;

export const Raw_Toast_Locations = create_raw_table(
  toast_locations_pipeline_name
);

export const toast_orders_pipeline_name =
  `${toast_source_system_name}_orders`;

export const Raw_Toast_Orders = create_raw_table(
  toast_orders_pipeline_name
);

export type Location_Type =
  | "food_and_beverage"
  | "retail"
  | "unclassified";

const processed_location_columns = create_processed_columns(Raw_Toast_Locations);

export const Processed_Toast_Locations = Processed_Schema.table("toast_locations", {
  ...processed_location_columns.identity_columns,

  name : text("name").notNull(),
  type : text("type")
    .$type<Location_Type>()
    .notNull()
    .default("unclassified"),

  ...processed_location_columns.metadata_columns
}, table => [
  uniqueIndex("toast_locations_source_identity_idx")
    .on(table.source_system, table.source_record_id),
  index("toast_locations_raw_record_id_idx").on(table.raw_record_id),
  check("toast_locations_name_not_blank", sql`btrim(${table.name}) <> ''`),
  check(
    "toast_locations_type_valid",
    sql`${table.type} IN ('food_and_beverage', 'retail', 'unclassified')`
  )
]);

const processed_order_columns = create_processed_columns(Raw_Toast_Orders);

export const Processed_Toast_Orders = Processed_Schema.table("toast_orders", {
  id : processed_order_columns.identity_columns.id,
  raw_record_id : processed_order_columns.identity_columns.raw_record_id,
  location_id : uuid("location_id")
    .notNull()
    .references(() => Processed_Toast_Locations.id, {onDelete : "restrict"}),

  source_system : processed_order_columns.identity_columns.source_system,
  source_record_id : processed_order_columns.identity_columns.source_record_id,

  business_date : date("business_date", {mode : "string"}).notNull(),
  voided : boolean("voided").notNull(),
  excess_food : boolean("excess_food").notNull(),
  created_in_test_mode : boolean("created_in_test_mode").notNull(),
  net_sales_amount : numeric("net_sales_amount", {precision : 14, scale : 2})
    .notNull(),
  check_count : integer("check_count").notNull(),

  source_created_at : timestamp("source_created_at", {withTimezone : true})
    .notNull(),
  source_modified_at : timestamp("source_modified_at", {withTimezone : true})
    .notNull(),

  ...processed_order_columns.metadata_columns
}, table => [
  uniqueIndex("toast_orders_source_identity_idx")
    .on(table.source_system, table.source_record_id),
  index("toast_orders_raw_record_id_idx").on(table.raw_record_id),
  index("toast_orders_location_business_date_idx")
    .on(table.location_id, table.business_date),
  check("toast_orders_check_count_not_negative", sql`${table.check_count} >= 0`)
]);