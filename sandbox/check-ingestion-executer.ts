import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {and, eq, inArray} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {execute_ingestion} from "../core/system/ingestion-executer.ts";
import {get_or_create_pipeline_progress} from "../core/system/pipeline-progress.ts";
import {Pipeline_Execution_History} from "../core/system/system-schema.ts";
import {
  Raw_Toast_Orders,
  toast_orders_pipeline_name
} from "../core/toast/toast-schema.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

type Test_Scenario = "success" | "failure" | "cancellation";

const scenarios : Test_Scenario[] = [
  "success",
  "failure",
  "cancellation"
];

const test_tag = `sandbox_ingestion_${randomUUID()}`;
const source_ids : string[] = [];
const start_at = new Date("2026-11-11T00:00:00.000Z");
const end_at = new Date("2026-11-11T02:00:00.000Z");

try {
  const progress_before = await get_or_create_pipeline_progress(
    toast_orders_pipeline_name
  );

  for (const scenario of scenarios) {
    const controller = new AbortController();
    const visited_windows : Array<{start_at : string; end_at : string}> = [];
    const operation = `${test_tag}_${scenario}`;

    const execution = execute_ingestion({
      raw_table : Raw_Toast_Orders,
      operation : operation,
      start_at : start_at,
      end_at : end_at,
      ingestion_window_days : 1 / 24,
      signal : controller.signal,
      extract_window : async function* (window) {
        visited_windows.push({
          start_at : window.start_at.toISOString(),
          end_at : window.end_at.toISOString()
        });

        if (scenario === "failure" && visited_windows.length === 2) {
          throw new Error("Synthetic second-window failure.");
        }

        const source_record_id =
          `${test_tag}_${scenario}_${visited_windows.length}`;

        source_ids.push(source_record_id);

        yield [{
          source_record_id : source_record_id,
          source_context : {synthetic_test : test_tag},
          content : {
            synthetic_test : test_tag,
            scenario : scenario,
            window_start : window.start_at.toISOString()
          }
        }];

        if (scenario === "cancellation") {
          controller.abort();
        }
      }
    });

    if (scenario === "success") {
      await execution;
    } else {
      await assert.rejects(
        execution,
        /Pipeline execution .* failed/
      );
    }

    const expected_windows = [
      {
        start_at : "2026-11-11T00:00:00.000Z",
        end_at : "2026-11-11T01:00:00.000Z"
      },
      {
        start_at : "2026-11-11T01:00:00.000Z",
        end_at : "2026-11-11T02:00:00.000Z"
      }
    ];

    assert.deepEqual(
      visited_windows,
      scenario === "cancellation"
        ? expected_windows.slice(0, 1)
        : expected_windows
    );

    const history_records = await warehouse_db
      .select()
      .from(Pipeline_Execution_History)
      .where(and(
        eq(Pipeline_Execution_History.pipeline_progress_id, progress_before.id),
        eq(Pipeline_Execution_History.operation, operation)
      ));

    assert.equal(history_records.length, 1);
    const history_record = history_records[0];
    assert.ok(history_record);

    const expected_count = scenario === "success" ? 2 : 1;

    assert.equal(
      history_record.status,
      scenario === "success" ? "succeeded" : "failed"
    );
    assert.equal(history_record.records_loaded, expected_count);
    assert.equal(history_record.records_processed, 0);
    assert.ok(history_record.finished_at);
    assert.equal(history_record.ingestion_watermark_after, null);

    if (scenario !== "success") {
      assert.ok(history_record.error_summary);
    }

    const committed_records = await warehouse_db
      .select({source_record_id : Raw_Toast_Orders.source_record_id})
      .from(Raw_Toast_Orders)
      .where(and(
        eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
        eq(Raw_Toast_Orders.execution_id, history_record.id)
      ))
      .orderBy(Raw_Toast_Orders.source_record_id);

    assert.deepEqual(
      committed_records.map(record => record.source_record_id),
      Array.from(
        {length : expected_count},
        (_, index) => `${test_tag}_${scenario}_${index + 1}`
      )
    );

    console.log(
      `${scenario}: expected history status, ${expected_count} committed records, correct window boundaries.`
    );
  }

  const progress_after = await get_or_create_pipeline_progress(
    toast_orders_pipeline_name
  );

  assert.ok(
    isDeepStrictEqual(progress_after, progress_before),
    "Executer checks changed pipeline progress."
  );

  console.log("Ingestion executer checks succeeded. Pipeline progress unchanged.");
} catch {
  console.error("Ingestion executer checks failed; inspect synthetic execution history.");
  process.exitCode = 1;
} finally {
  try {
    if (source_ids.length > 0) {
      await warehouse_db
        .delete(Raw_Toast_Orders)
        .where(and(
          eq(Raw_Toast_Orders.record_source, toast_orders_pipeline_name),
          inArray(Raw_Toast_Orders.source_record_id, source_ids)
        ));
    }
  } finally {
    await warehouse_pool.end();
  }
}