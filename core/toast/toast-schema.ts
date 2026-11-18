import {sql} from "drizzle-orm";
import {check, index, text, uniqueIndex} from "drizzle-orm/pg-core";
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

export const Processed_Locations = Processed_Schema.table("locations", {
  ...processed_location_columns.identity_columns,

  name : text("name").notNull(),
  type : text("type")
    .$type<Location_Type>()
    .notNull()
    .default("unclassified"),

  ...processed_location_columns.metadata_columns
}, table => [
  uniqueIndex("locations_source_identity_idx")
    .on(table.source_system, table.source_record_id),
  index("locations_raw_record_id_idx").on(table.raw_record_id),
  check("locations_name_not_blank", sql`btrim(${table.name}) <> ''`),
  check(
    "locations_type_valid",
    sql`${table.type} IN ('food_and_beverage', 'retail', 'unclassified')`
  )
]);