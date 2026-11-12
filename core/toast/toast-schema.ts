import {create_raw_table} from "../system/system-schema.ts";

export const toast_source_system_name = "toast";
const toast_orders_source_item_name = "orders";

export const toast_orders_pipeline_name =
  `${toast_source_system_name}_${toast_orders_source_item_name}`;

export const Raw_Toast_Orders = create_raw_table(
  toast_orders_pipeline_name
);