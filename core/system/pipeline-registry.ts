import {ingest_toast_orders} from "../toast/toast-orders.ts";
import {ingest_toast_locations} from "../toast/toast-locations.ts";
import type {Pipeline_Execution_Result} from "./pipeline-types.ts";

type Ingestion_Pipeline = (signal : AbortSignal) => Promise<Pipeline_Execution_Result>;

export const ingestion_pipelines = new Map<string, Ingestion_Pipeline>([
    ["toast-orders", ingest_toast_orders],
    ["toast-locations", ingest_toast_locations]
])