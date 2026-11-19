import type {warehouse_db} from "./pgsql-warehouse.ts";
import type {create_raw_table} from "./system-schema.ts";

export type Processing_Transaction = Parameters<
  Parameters<typeof warehouse_db.transaction>[0]
>[0];

export type Raw_Processing_Record = ReturnType<typeof create_raw_table>["$inferSelect"];
