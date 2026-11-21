import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {and, eq, inArray} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {
  record_pipeline_execution_start,
  record_pipeline_execution_completion
} from "../core/system/pipeline-operation-history.ts";
import {get_or_create_pipeline_state} from "../core/system/pipeline-state.ts";
import {load_raw_records} from "../core/system/raw-pipeline-loader.ts";
import {Pipeline_Operation_History} from "../core/system/system-schema.ts";
import {
  Raw_Toast_Orders,
  toast_orders_pipeline_name
} from "../core/toast/toast-schema.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const test_tag = `sandbox_raw_safety_${randomUUID()}`;
const source_ids = [
  `${test_tag}_original`,
  `${test_tag}_conflict_batch`,
  `${test_tag}_database_failure`
];

const original_record = {
  source_record_id : source_ids[0]!,
  source_context : {synthetic_test : test_tag, restaurant_guid : randomUUID()},
  content : {synthetic_test : test_tag, version : 1}
};

const test_filter = and(
  eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
  inArray(Raw_Toast_Orders.source_record_id, source_ids)
);

let execution_id : string | undefined;
let execution_finished = false;

try {
  const progress_before = await get_or_create_pipeline_state(
    toast_orders_pipeline_name
  );

  execution_id = await record_pipeline_execution_start(
    toast_orders_pipeline_name,
    "sandbox-raw-safety"
  );

  assert.equal(
    await load_raw_records(Raw_Toast_Orders, execution_id, [original_record]),
    1
  );

  const [inserted_record] = await warehouse_db
    .select()
    .from(Raw_Toast_Orders)
    .where(test_filter);

  assert.ok(inserted_record, "Synthetic insert is missing.");
  assert.equal(inserted_record.content_revision, 1);

  await warehouse_db
    .update(Raw_Toast_Orders)
    .set({processed : true})
    .where(eq(Raw_Toast_Orders.id, inserted_record.id));

  const changed_record = {
    ...original_record,
    content : {synthetic_test : test_tag, version : 2}
  };

  assert.equal(
    await load_raw_records(Raw_Toast_Orders, execution_id, [changed_record]),
    1
  );

  const [updated_record] = await warehouse_db
    .select()
    .from(Raw_Toast_Orders)
    .where(eq(Raw_Toast_Orders.id, inserted_record.id));

  assert.ok(updated_record, "Changed synthetic record is missing.");
  assert.ok(updated_record.id === inserted_record.id, "Internal ID changed.");
  assert.equal(
    updated_record.created_at.getTime(),
    inserted_record.created_at.getTime()
  );
  assert.equal(updated_record.content_revision, 2);
  assert.equal(updated_record.processed, false);
  assert.ok(isDeepStrictEqual(updated_record.content, changed_record.content));

  assert.equal(
    await load_raw_records(Raw_Toast_Orders, execution_id, [changed_record]),
    0
  );

  const [replayed_record] = await warehouse_db
    .select()
    .from(Raw_Toast_Orders)
    .where(eq(Raw_Toast_Orders.id, inserted_record.id));

  assert.ok(
    isDeepStrictEqual(replayed_record, updated_record),
    "Replay changed the synthetic record."
  );

  console.log("Changed payload and unchanged replay checks passed.");

  await assert.rejects(
    load_raw_records(Raw_Toast_Orders, execution_id, [
      {
        source_record_id : source_ids[1]!,
        source_context : original_record.source_context,
        content : {synthetic_test : test_tag}
      },
      {
        ...changed_record,
        source_context : {
          ...original_record.source_context,
          restaurant_guid : randomUUID()
        },
        content : {synthetic_test : test_tag, version : 3}
      }
    ]),
    /source context conflicts/
  );

  const records_after_conflict = await warehouse_db
    .select()
    .from(Raw_Toast_Orders)
    .where(test_filter);

  assert.equal(records_after_conflict.length, 1);
  assert.ok(
    isDeepStrictEqual(records_after_conflict[0], updated_record),
    "Context conflict did not roll back the batch."
  );

  const [history_after_conflict] = await warehouse_db
    .select()
    .from(Pipeline_Operation_History)
    .where(eq(Pipeline_Operation_History.id, execution_id));

  assert.ok(history_after_conflict);
  assert.equal(history_after_conflict.records_loaded, 2);

  console.log("Context conflict rolled back the whole batch.");

  await warehouse_db
    .update(Pipeline_Operation_History)
    .set({records_loaded : 2_147_483_647})
    .where(eq(Pipeline_Operation_History.id, execution_id));

  try {
    await assert.rejects(
      load_raw_records(Raw_Toast_Orders, execution_id, [{
        source_record_id : source_ids[2]!,
        source_context : original_record.source_context,
        content : {synthetic_test : test_tag}
      }]),
      (error : unknown): boolean => {
        let current_error : unknown = error;

        while (current_error instanceof Error) {
          if ("code" in current_error && current_error.code === "22003") {
            return true;
          }

          current_error = current_error.cause;
        }

        return false;
      },
      "Expected PostgreSQL integer overflow during the count update."
    );

    const records_after_failure = await warehouse_db
      .select()
      .from(Raw_Toast_Orders)
      .where(test_filter);

    assert.equal(records_after_failure.length, 1);
    assert.ok(
      isDeepStrictEqual(records_after_failure[0], updated_record),
      "Database failure did not roll back the Raw insert."
    );

    const [history_after_failure] = await warehouse_db
      .select()
      .from(Pipeline_Operation_History)
      .where(eq(Pipeline_Operation_History.id, execution_id));

    assert.ok(history_after_failure);
    assert.equal(history_after_failure.records_loaded, 2_147_483_647);
  } finally {
    await warehouse_db
      .update(Pipeline_Operation_History)
      .set({records_loaded : 2})
      .where(eq(Pipeline_Operation_History.id, execution_id));
  }

  console.log("Database failure rolled back the Raw insert and count update.");

  const progress_after = await get_or_create_pipeline_state(
    toast_orders_pipeline_name
  );

  assert.ok(
    isDeepStrictEqual(progress_after, progress_before),
    "Safety check changed pipeline progress."
  );

  await record_pipeline_execution_completion(execution_id, {
    status : "succeeded"
  });
  execution_finished = true;

  await assert.rejects(
    load_raw_records(Raw_Toast_Orders, execution_id, [changed_record]),
    /requires a running execution/
  );

  console.log("Finished execution rejected. Pipeline progress unchanged.");
  console.log("Raw loader safety check succeeded.");
} catch {
  console.error("Raw loader safety check failed; inspect its execution history.");
  process.exitCode = 1;

  if (execution_id && !execution_finished) {
    await record_pipeline_execution_completion(execution_id, {
      status : "failed",
      error_summary : "Synthetic Raw loader safety check failed."
    });
  }
} finally {
  try {
    if (execution_id) {
      await warehouse_db
        .delete(Raw_Toast_Orders)
        .where(and(
          test_filter,
          eq(Raw_Toast_Orders.execution_id, execution_id)
        ));
    }
  } finally {
    await warehouse_pool.end();
  }
}