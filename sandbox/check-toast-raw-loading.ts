import assert from "node:assert/strict";
import {isDeepStrictEqual} from "node:util";
import {and, eq, inArray} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {execute_tracked_pipeline_operation} from "../core/system/pipeline-operation.ts";
import {get_or_create_pipeline_state} from "../core/system/pipeline-state.ts";
import {load_raw_records} from "../core/system/raw-pipeline-loader.ts";
import {Pipeline_Operation_History} from "../core/system/system-schema.ts";
import {get_toast_order_page} from "../core/toast/toast-orders.ts";
import {Raw_Toast_Orders, toast_orders_pipeline_name} from "../core/toast/toast-schema.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const restaurant_guid = "30adf260-2cab-4857-8b94-5af40f8bcd13";
const business_date = "20261111";

try {
  const order_page = await get_toast_order_page(restaurant_guid, business_date);
  assert.ok(order_page.order_records.length > 0, "No orders returned; Raw replay cannot be verified.");

  const records = order_page.order_records.map(order => ({
    source_record_id : order.guid,
    source_context : {restaurant_guid : restaurant_guid},
    content : order
  }));
  const source_ids = records.map(record => record.source_record_id);
  assert.equal(new Set(source_ids).size, records.length, "Order page contains duplicate source identities.");

  const progress_before = await get_or_create_pipeline_state(toast_orders_pipeline_name);
  const raw_records_before = await warehouse_db
    .select()
    .from(Raw_Toast_Orders)
    .where(and(
      eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
      inArray(Raw_Toast_Orders.source_record_id, source_ids)
    ));
  const previous_records = new Map(raw_records_before.map(record => [record.source_record_id, record]));
  const expected_changes = records.filter(record => {
    const previous_record = previous_records.get(record.source_record_id);
    return !previous_record || !isDeepStrictEqual(previous_record.content, record.content);
  }).length;

  const {execution_id} = await execute_tracked_pipeline_operation(
    toast_orders_pipeline_name,
    "sandbox-raw-page-replay",
    async current_execution_id => {
      const changes_loaded = await load_raw_records(Raw_Toast_Orders, current_execution_id, records);
      assert.equal(changes_loaded, expected_changes, "First load count does not match inserted/changed records.");

      const loaded_records = await warehouse_db
        .select()
        .from(Raw_Toast_Orders)
        .where(and(
          eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
          inArray(Raw_Toast_Orders.source_record_id, source_ids)
        ))
        .orderBy(Raw_Toast_Orders.source_record_id);

      assert.equal(loaded_records.length, records.length, "Not every source identity has exactly one Raw row.");
      const source_records = new Map(records.map(record => [record.source_record_id, record]));

      for (const loaded_record of loaded_records) {
        const source_record = source_records.get(loaded_record.source_record_id);
        assert.ok(source_record, "An unexpected source identity was returned.");
        assert.ok(isDeepStrictEqual(loaded_record.content, source_record.content), "Raw payload differs from the source record.");
        assert.ok(isDeepStrictEqual(loaded_record.source_context, source_record.source_context), "Restaurant context was not preserved.");

        const previous_record = previous_records.get(loaded_record.source_record_id);
        if (!previous_record) {
          assert.equal(loaded_record.content_revision, 1, "New Raw revision must be one.");
          assert.equal(loaded_record.processed, false, "New Raw record must be pending.");
          assert.ok(loaded_record.execution_id === current_execution_id, "New Raw provenance is incorrect.");
        } else {
          assert.ok(loaded_record.id === previous_record.id, "Raw internal identity changed.");
          assert.equal(loaded_record.created_at.getTime(), previous_record.created_at.getTime(), "Raw creation time changed.");
          if (!isDeepStrictEqual(previous_record.content, source_record.content)) {
            assert.equal(loaded_record.content_revision, previous_record.content_revision + 1, "Changed Raw revision did not increment once.");
            assert.equal(loaded_record.processed, false, "Changed Raw record must be pending.");
            assert.ok(loaded_record.execution_id === current_execution_id, "Changed Raw provenance is incorrect.");
          } else {
            assert.ok(isDeepStrictEqual(loaded_record, previous_record), "Unchanged Raw record was modified.");
          }
        }
      }

      const replay_changes = await load_raw_records(Raw_Toast_Orders, current_execution_id, records);
      assert.equal(replay_changes, 0, "Same-page replay must load zero changes.");
      const replayed_records = await warehouse_db
        .select()
        .from(Raw_Toast_Orders)
        .where(and(
          eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
          inArray(Raw_Toast_Orders.source_record_id, source_ids)
        ))
        .orderBy(Raw_Toast_Orders.source_record_id);
      assert.ok(isDeepStrictEqual(replayed_records, loaded_records), "Replay changed Raw rows or metadata.");

      console.log(`Orders fetched: ${records.length}. Raw changes: ${changes_loaded}. Replay changes: ${replay_changes}.`);
      return {status : "succeeded"};
    }
  );

  const [history_record] = await warehouse_db
    .select()
    .from(Pipeline_Operation_History)
    .where(eq(Pipeline_Operation_History.id, execution_id));
  assert.ok(history_record, "Execution history is missing.");
  assert.equal(history_record.status, "succeeded", "Execution did not complete successfully.");
  assert.ok(history_record.finished_at, "Execution finish time is missing.");
  assert.equal(history_record.records_loaded, expected_changes, "Committed history count is incorrect.");
  assert.equal(history_record.records_processed, 0, "Page check must not process records.");
  assert.ok(isDeepStrictEqual(history_record.ingestion_watermark_before, progress_before.ingestion_watermark), "Starting watermark is incorrect.");
  assert.equal(history_record.ingestion_watermark_after, null, "Page check must not claim completed coverage.");

  const progress_after = await get_or_create_pipeline_state(toast_orders_pipeline_name);
  assert.ok(isDeepStrictEqual(progress_after, progress_before), "Page check changed pipeline progress.");
  console.log("Toast Raw load/replay check succeeded. Pipeline progress unchanged.");
} catch {
  console.error("Toast Raw load/replay check failed. Committed first-load records may remain; inspect execution history before retrying.");
  process.exitCode = 1;
} finally {
  await warehouse_pool.end();
}
