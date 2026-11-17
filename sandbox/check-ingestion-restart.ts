import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {and, eq, sql} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {execute_ingestion} from "../core/system/ingestion-executer.ts";
import {get_or_create_pipeline_progress} from "../core/system/pipeline-progress.ts";
import {
  create_raw_table,
  Pipeline_Execution_History,
  Pipeline_Progress
} from "../core/system/system-schema.ts";

type Check_Phase = "interrupt" | "resume";

async function check_phase(
  phase : Check_Phase,
  pipeline_name : string,
  start_at : Date
): Promise<void> {
  const raw_table = create_raw_table(pipeline_name);
  const progress_before = await get_or_create_pipeline_progress(pipeline_name);
  const first_end = new Date(start_at.getTime() + 3_600_000);
  const second_end = new Date(first_end.getTime() + 3_600_000);
  assert.equal(
    progress_before.ingestion_watermark?.getTime() ?? null,
    phase === "interrupt" ? null : first_end.getTime()
  );
  const records_before = await warehouse_db.select().from(raw_table);
  assert.equal(records_before.length, phase === "interrupt" ? 0 : 2);

  const visited_starts : number[] = [];
  let source_failure_reached = false;
  const before_execution = Date.now();
  const execution = execute_ingestion({
    raw_table : raw_table,
    operation : phase,
    source_configuration : {data_start_date : start_at, window_size_in_days : 1 / 24},
    ingestion_window_days : 1 / 24,
    ingestion_lookback_days : 0,
    signal : AbortSignal.timeout(60_000),
    extract_window : async function* (window) {
      visited_starts.push(window.start_at.getTime());
      assert.ok(visited_starts.length <= 3, "Synthetic check exceeded its window budget.");
      const source_record_id = window.start_at.getTime() === start_at.getTime()
        ? "first-window"
        : "second-window-page-one";

      if (window.start_at.getTime() < second_end.getTime()) {
        yield [{
          source_record_id : source_record_id,
          source_context : {synthetic_test : pipeline_name},
          content : {synthetic_test : pipeline_name, page : 1}
        }];
      }

      if (window.start_at.getTime() === first_end.getTime()) {
        if (phase === "interrupt") {
          source_failure_reached = true;
          throw new Error("Intentional synthetic later-page failure.");
        }
        yield [{
          source_record_id : "second-window-page-two",
          source_context : {synthetic_test : pipeline_name},
          content : {synthetic_test : pipeline_name, page : 2}
        }];
      }
      // The final window intentionally has no records but still completes coverage.
    }
  });

  if (phase === "interrupt") {
    await assert.rejects(execution, /Pipeline execution .* failed/);
    assert.ok(source_failure_reached, "Failure occurred before the intended interruption.");
  } else {
    await execution;
  }
  const after_execution = Date.now();
  const progress_after = await get_or_create_pipeline_progress(pipeline_name);
  const [history] = await warehouse_db
    .select()
    .from(Pipeline_Execution_History)
    .where(and(
      eq(Pipeline_Execution_History.pipeline_progress_id, progress_before.id),
      eq(Pipeline_Execution_History.operation, phase)
    ));
  assert.ok(history);
  assert.equal(history.status, phase === "interrupt" ? "failed" : "succeeded");
  assert.equal(history.records_loaded, phase === "interrupt" ? 2 : 1);
  assert.equal(history.records_processed, 0);
  assert.ok(history.finished_at);
  assert.equal(
    history.ingestion_watermark_before?.getTime() ?? null,
    phase === "interrupt" ? null : first_end.getTime()
  );
  assert.ok(progress_after.last_successful_ingestion_at);
  assert.ok(progress_after.ingestion_watermark);
  assert.equal(
    history.ingestion_watermark_after?.getTime(),
    progress_after.ingestion_watermark.getTime()
  );

  const records_after = await warehouse_db.select().from(raw_table);
  assert.equal(records_after.length, phase === "interrupt" ? 2 : 3);
  assert.ok(records_after.every(record =>
    record.content_revision === 1 && record.processed === false
  ));
  assert.deepEqual(
    records_after.map(record => record.source_record_id).sort(),
    phase === "interrupt"
      ? ["first-window", "second-window-page-one"]
      : ["first-window", "second-window-page-one", "second-window-page-two"]
  );

  if (phase === "interrupt") {
    assert.deepEqual(visited_starts, [start_at.getTime(), first_end.getTime()]);
    assert.equal(progress_after.ingestion_watermark.getTime(), first_end.getTime());
    console.log("Interrupted: first window checkpointed; second-window page committed without advancing coverage.");
  } else {
    assert.deepEqual(visited_starts, [first_end.getTime(), second_end.getTime()]);
    assert.ok(progress_after.ingestion_watermark.getTime() >= before_execution);
    assert.ok(progress_after.ingestion_watermark.getTime() <= after_execution);
    for (const original_record of records_before) {
      const replayed_record = records_after.find(record => record.id === original_record.id);
      assert.ok(
        isDeepStrictEqual(replayed_record, original_record),
        "Restart changed an already committed synthetic record."
      );
    }
    console.log("Resumed in a fresh process: incomplete window replayed unchanged; empty final window checkpointed.");
  }
}

async function check_restart(): Promise<void> {
  if (env_vars.system_environment !== "experimental") {
    throw new Error("Run this check only in the experimental environment.");
  }

  const [phase, supplied_name, supplied_start, ...extra_arguments] = process.argv.slice(2);
  if (phase !== undefined) {
    const start_at = new Date(Number(supplied_start));
    if (
      (phase !== "interrupt" && phase !== "resume") ||
      !supplied_name ||
      !/^sandbox_restart_[a-f0-9]{32}$/.test(supplied_name) ||
      !supplied_start ||
      !Number.isFinite(start_at.getTime()) ||
      start_at.getTime() > Date.now() ||
      start_at.getTime() < Date.now() - 4 * 3_600_000 ||
      extra_arguments.length > 0
    ) {
      throw new Error("Invalid internal restart-check arguments.");
    }
    await check_phase(phase, supplied_name, start_at);
    return;
  }

  const pipeline_name = `sandbox_restart_${randomUUID().replaceAll("-", "")}`;
  const table_name = sql`${sql.identifier("raw")}.${sql.identifier(pipeline_name)}`;
  const start_at = new Date(Date.now() - 2.5 * 3_600_000);
  console.log("Experimental synthetic check: creates a temporary test table and progress/history.");
  console.log("No Toast requests or Toast record/progress mutations. Verify the actual database target before running.");

  let fixture_created = false;
  try {
    await warehouse_db.transaction(async transaction => {
      await transaction.execute(sql`
        CREATE TABLE ${table_name} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          execution_id uuid NOT NULL REFERENCES system.pipeline_history(id) ON DELETE RESTRICT,
          source_record_id text NOT NULL,
          source_context jsonb,
          content jsonb NOT NULL,
          record_source text NOT NULL,
          deleted boolean NOT NULL DEFAULT false,
          content_revision integer NOT NULL DEFAULT 1,
          processed boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (record_source, source_record_id)
        )
      `);
      await transaction.insert(Pipeline_Progress).values({pipeline_name : pipeline_name});
    });
    fixture_created = true;

    for (const child_phase of ["interrupt", "resume"]) {
      const child = spawnSync(process.execPath, [
        import.meta.filename,
        child_phase,
        pipeline_name,
        String(start_at.getTime())
      ], {stdio : "inherit", timeout : 90_000});
      if (child.error || child.status !== 0) {
        throw new Error("Synthetic restart-check child process failed or exceeded its time budget.");
      }
    }

    await warehouse_db.transaction(async transaction => {
      const [progress] = await transaction
        .select({id : Pipeline_Progress.id})
        .from(Pipeline_Progress)
        .where(eq(Pipeline_Progress.pipeline_name, pipeline_name));
      assert.ok(progress, "Synthetic progress disappeared before cleanup.");
      await transaction.execute(sql`DROP TABLE ${table_name}`);
      await transaction.delete(Pipeline_Execution_History)
        .where(eq(Pipeline_Execution_History.pipeline_progress_id, progress.id));
      await transaction.delete(Pipeline_Progress)
        .where(eq(Pipeline_Progress.id, progress.id));
    });
    console.log("Ingestion restart check succeeded. Temporary table and synthetic metadata removed.");
  } catch {
    if (fixture_created) {
      console.error(`Check failed. Synthetic table raw.${pipeline_name} and its metadata were retained for inspection.`);
    }
    throw new Error("Ingestion restart check failed; inspect the check phase and experimental fixtures.");
  }
}

try {
  await check_restart();
} catch {
  console.error("Ingestion restart check failed. No live Toast data or progress was intentionally changed.");
  process.exitCode = 1;
} finally {
  await warehouse_pool.end();
}
