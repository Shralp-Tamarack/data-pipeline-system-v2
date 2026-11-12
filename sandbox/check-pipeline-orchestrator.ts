import assert from "node:assert/strict";
import {eq} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {Pipeline_Execution_History} from "../core/system/system-schema.ts";
import {execute_pipeline} from "../core/system/pipeline-orchestrator.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const pipeline_name = "sandbox_orchestrator_check";

try {
  const successful_execution_id = await execute_pipeline(
    pipeline_name,
    "success-check",
    async () => ({status : "succeeded"})
  );

  const [successful_record] = await warehouse_db
    .select()
    .from(Pipeline_Execution_History)
    .where(eq(Pipeline_Execution_History.id, successful_execution_id));

  assert.ok(successful_record);
  assert.equal(successful_record.status, "succeeded");
  assert.ok(successful_record.finished_at);

  let failed_execution_id : string | undefined;

  await assert.rejects(
    execute_pipeline(
      pipeline_name,
      "failure-check",
      async execution_id => {
        failed_execution_id = execution_id;

        await warehouse_db
          .update(Pipeline_Execution_History)
          .set({records_loaded : 7})
          .where(eq(Pipeline_Execution_History.id, execution_id));

        throw new Error("Synthetic pipeline failure.");
      }
    ),
    /Pipeline execution .* failed/
  );

  assert.ok(failed_execution_id);

  const [failed_record] = await warehouse_db
    .select()
    .from(Pipeline_Execution_History)
    .where(eq(Pipeline_Execution_History.id, failed_execution_id));

  assert.ok(failed_record);
  assert.equal(failed_record.status, "failed");
  assert.equal(failed_record.records_loaded, 7);
  assert.ok(failed_record.finished_at);
  assert.ok(failed_record.error_summary);

  console.log("Pipeline orchestrator check succeeded.");
} finally {
  await warehouse_pool.end();
}