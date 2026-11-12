import assert from "node:assert/strict";
import {eq} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {Pipeline_Execution_History} from "../core/system/system-schema.ts";
import {get_or_create_pipeline_progress} from "../core/system/pipeline-progress.ts";
import {
  record_pipeline_execution_start,
  record_pipeline_execution_completion
} from "../core/system/pipeline-history.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

try {
  const progress_before = await get_or_create_pipeline_progress(
    "sandbox_execution_check"
  );

  const execution_id = await record_pipeline_execution_start(
    "sandbox_execution_check",
    "lifecycle-check"
  );

  await record_pipeline_execution_completion(execution_id, {
    status : "succeeded",
    records_loaded : 0,
    records_processed : 0,
    ingestion_watermark_after : progress_before.ingestion_watermark
  });

  await assert.rejects(
    record_pipeline_execution_completion(execution_id, {
      status : "failed",
      records_loaded : 0,
      records_processed : 0,
      ingestion_watermark_after : progress_before.ingestion_watermark,
      error_summary : "Synthetic duplicate-finish attempt."
    }),
    /already finished/
  );

  const [execution_record] = await warehouse_db
    .select()
    .from(Pipeline_Execution_History)
    .where(eq(Pipeline_Execution_History.id, execution_id));

  assert.ok(execution_record, "Execution history record is missing.");
  assert.equal(execution_record.status, "succeeded");
  assert.ok(execution_record.finished_at, "Execution finish time is missing.");
  assert.equal(execution_record.records_loaded, 0);
  assert.equal(execution_record.records_processed, 0);
  assert.deepEqual(
    execution_record.ingestion_watermark_before,
    progress_before.ingestion_watermark
  );
  assert.deepEqual(
    execution_record.ingestion_watermark_after,
    progress_before.ingestion_watermark
  );

  const progress_after = await get_or_create_pipeline_progress(
    "sandbox_execution_check"
  );

  assert.deepEqual(progress_after, progress_before);

  console.log("Pipeline execution lifecycle check succeeded.");
} finally {
  await warehouse_pool.end();
}