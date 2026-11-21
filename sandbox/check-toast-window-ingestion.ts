import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import {eq} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {get_or_create_pipeline_state} from "../core/system/pipeline-state.ts";
import {Pipeline_Operation_History} from "../core/system/system-schema.ts";
import {execute_ingestion} from "../core/system/ingestion.ts";
import {extract_toast_raw_order_window} from "../core/toast/toast-orders.ts";
import {
  Raw_Toast_Orders,
  toast_orders_pipeline_name
} from "../core/toast/toast-schema.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const restaurant_guid = "30adf260-2cab-4857-8b94-5af40f8bcd13";
const start_at = new Date("2026-11-11T00:00:00.000Z");
const end_at = new Date("2026-11-12T00:00:00.000Z");

try {
  const progress_before = await get_or_create_pipeline_state(
    toast_orders_pipeline_name
  );

  const {execution_id} = await execute_ingestion({
    raw_table : Raw_Toast_Orders,
    operation : "sandbox-window-ingestion",
    start_at : start_at,
    end_at : end_at,
    signal : AbortSignal.timeout(120_000),
    extract_window : (window, signal) =>
      extract_toast_raw_order_window(
        restaurant_guid,
        window,
        signal
      )
  });

  const [history_record] = await warehouse_db
    .select()
    .from(Pipeline_Operation_History)
    .where(eq(Pipeline_Operation_History.id, execution_id));

  assert.ok(history_record, "Execution history is missing.");
  assert.equal(history_record.status, "succeeded");
  assert.ok(history_record.finished_at);
  assert.equal(history_record.records_processed, 0);
  assert.equal(history_record.ingestion_watermark_after, null);

  const progress_after = await get_or_create_pipeline_state(
    toast_orders_pipeline_name
  );

  assert.ok(
    isDeepStrictEqual(progress_after, progress_before),
    "Window ingestion changed pipeline progress."
  );

  console.log(
    `Toast window ingestion succeeded. Raw changes: ${history_record.records_loaded}.`
  );
  console.log("Pipeline progress unchanged. No processing performed.");
} catch {
  console.error(
    "Toast window ingestion check failed. Earlier batches may remain committed; inspect execution history."
  );
  process.exitCode = 1;
} finally {
  await warehouse_pool.end();
}