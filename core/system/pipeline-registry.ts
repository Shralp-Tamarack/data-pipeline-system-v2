import {ingest_toast_orders} from "../toast/toast-orders.ts";
import {
  ingest_toast_locations,
  process_toast_locations
} from "../toast/toast-locations.ts";
import type {Pipeline_Execution_Result} from "./pipeline-types.ts";

type Pipeline_Command = (signal : AbortSignal) => Promise<Pipeline_Execution_Result>;

export const ingestion_pipelines = new Map<string, Pipeline_Command>([
  ["toast-orders", ingest_toast_orders],
  ["toast-locations", ingest_toast_locations]
]);

export const processing_pipelines = new Map<string, Pipeline_Command>([
  ["toast-locations", process_toast_locations]
]);