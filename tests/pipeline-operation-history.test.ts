import assert from "node:assert/strict";
import {copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type History_Module = typeof import("../core/system/pipeline-operation-history.ts");
type Test_History = {
  id : string;
  pipeline_state_id : string;
  operation : string;
  status : string;
  records_read : number | null;
  records_loaded : number;
  records_processed : number;
  ingestion_watermark_before : Date | null;
  finished_at : Date | null;
};
type Persistence_State = {
  history : Test_History | null;
  processing_at : Date | null;
  ingestion_at : Date | null;
  watermark : Date | null;
  updated_at : Date | null;
  state_exists : boolean;
  fail_state_write : boolean;
};

test("operation history metrics and completion with synthetic transactional persistence", async context => {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-operation-history-test-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["pipeline-operation-history.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(directory, filename));
    }
    writeFileSync(join(directory, "pipeline-state.ts"), `
import {state} from "./pgsql-warehouse.ts";
export async function get_or_create_pipeline_state() {
  return {id : "pipeline-state", ingestion_watermark : state.watermark};
}
`);
    writeFileSync(join(directory, "pgsql-warehouse.ts"), `
import assert from "node:assert/strict";
import {PgDialect} from "drizzle-orm/pg-core";
import {Pipeline_Operation_History, Pipeline_State} from "./system-schema.ts";
const dialect = new PgDialect();
export const state = {
  history : null, processing_at : null, ingestion_at : null, watermark : null, updated_at : null,
  state_exists : true, fail_state_write : false
};
const persistence = {
  insert(table) {
    assert.equal(table, Pipeline_Operation_History);
    return {values(values) {return {async returning() {
      state.history = {
        id : "execution", status : "running", records_loaded : 0, records_processed : 0,
        finished_at : null, ...values
      };
      return [{id : "execution"}];
    }};}};
  },
  update(table) {
    return {set(values) {return {where(predicate) {return {async returning() {
      const query = dialect.sqlToQuery(predicate);
      if (table === Pipeline_State) {
        assert.deepEqual(query.params, ["pipeline-state"]);
        if (state.fail_state_write) throw new Error("Synthetic state write failure.");
        if (!state.state_exists) return [];
        if (values.last_successful_processing_at !== undefined) state.processing_at = values.last_successful_processing_at;
        if (values.last_successful_ingestion_at !== undefined) state.ingestion_at = values.last_successful_ingestion_at;
        if (values.ingestion_watermark !== undefined) state.watermark = values.ingestion_watermark;
        state.updated_at = values.updated_at;
        return [{id : "pipeline-state"}];
      }
      assert.equal(table, Pipeline_Operation_History);
      assert.ok(query.params.includes("running"));
      if (!state.history || state.history.id !== query.params[0] || state.history.status !== "running") return [];
      if (values.records_read !== undefined) {
        const increment = dialect.sqlToQuery(values.records_read);
        assert.match(increment.sql, /coalesce\\(.*"records_read", 0\\) \\+ /);
        state.history.records_read = (state.history.records_read ?? 0) + increment.params[0];
      } else {
        for (const [key, value] of Object.entries(values)) {
          if (value !== undefined) state.history[key] = value;
        }
      }
      return [structuredClone(state.history)];
    }};}};}};
  }
};
export const warehouse_db = {
  ...persistence,
  async transaction(work) {
    const before = structuredClone(state);
    try {return await work(persistence);}
    catch (error) {Object.assign(state, before); throw error;}
  }
};
`);
    const {
      record_pipeline_execution_start,
      record_ingestion_records_read,
      record_pipeline_execution_completion
    } : History_Module = await import(pathToFileURL(join(directory, "pipeline-operation-history.ts")).href);
    const {state} : {state : Persistence_State} =
      await import(pathToFileURL(join(directory, "pgsql-warehouse.ts")).href);
    const reset = async (operation : string = "processing"): Promise<void> => {
      state.processing_at = new Date("2026-01-01T00:00:00Z");
      state.ingestion_at = new Date("2026-01-01T00:00:00Z");
      state.watermark = new Date("2026-01-01T00:00:00Z");
      state.updated_at = new Date("2026-01-01T00:00:00Z");
      state.state_exists = true;
      state.fail_state_write = false;
      await record_pipeline_execution_start("toast_locations", operation);
    };

    await context.test("counts source reads separately from changes and refuses missing or finished attempts", async () => {
      await reset("ingestion");
      assert.equal(state.history?.records_read, 0);
      await record_ingestion_records_read("execution", 100);
      await record_ingestion_records_read("execution", 100);
      assert.equal(state.history?.records_read, 200);
      assert.equal(state.history?.records_loaded, 0);
      await record_pipeline_execution_completion("execution", {status : "failed"});
      assert.equal(state.history?.records_read, 200);
      await assert.rejects(record_ingestion_records_read("execution", 1), /running execution/);
      await reset();
      assert.equal(state.history?.records_read, null);
      await assert.rejects(record_ingestion_records_read("missing", 1), /running execution/);
      await reset("manual-check");
      await record_ingestion_records_read("execution", 1);
      assert.equal(state.history?.records_read, 1);
      for (const count of [-1, 0.5, NaN, 2_147_483_648]) {
        await assert.rejects(record_ingestion_records_read("execution", count), /Read count/);
      }
    });

    await context.test("successful processing atomically saves finish time and state without replacing committed counts", async () => {
      await reset();
      assert.ok(state.history);
      state.history.records_processed = 250;
      const watermark = state.history.ingestion_watermark_before;
      await record_pipeline_execution_completion("execution", {status : "succeeded"});
      assert.equal(state.history.status, "succeeded");
      assert.equal(state.history.records_processed, 250);
      assert.deepEqual(state.history.ingestion_watermark_before, watermark);
      assert.ok(state.history.finished_at instanceof Date);
      assert.deepEqual(state.processing_at, state.history.finished_at);
      assert.deepEqual(state.updated_at, state.history.finished_at);
      await assert.rejects(record_pipeline_execution_completion("execution", {status : "succeeded"}), /already finished/);
    });

    await context.test("snapshot ingestion and unchanged refreshes record success without creating a watermark", async () => {
      await reset("ingestion");
      state.watermark = null;
      const processing_at = state.processing_at;
      context.mock.timers.enable({apis : ["Date"], now : Date.parse("2026-01-02T00:00:00Z")});
      try {
        for (const records_loaded of [18, 0]) {
          const previous_success = state.ingestion_at;
          await record_pipeline_execution_start("toast_locations", "ingestion");
          await record_ingestion_records_read("execution", 18);
          await record_pipeline_execution_completion("execution", {status : "succeeded", records_loaded});
          assert.ok(state.ingestion_at);
          assert.ok(previous_success && state.ingestion_at.getTime() > previous_success.getTime());
          assert.deepEqual(state.ingestion_at, state.history?.finished_at);
          assert.deepEqual(state.updated_at, state.history?.finished_at);
          assert.equal(state.history?.records_loaded, records_loaded);
          assert.equal(state.watermark, null);
          assert.equal(state.history?.ingestion_watermark_before, null);
          assert.deepEqual(state.processing_at, processing_at);
          context.mock.timers.tick(1000);
        }
      } finally {
        context.mock.timers.reset();
      }
    });

    await context.test("failed, partial, cancelled and unrelated outcomes do not advance success timestamps", async () => {
      for (const operation of ["ingestion", "processing", "reconciliation"]) {
        for (const status of ["failed", "partial", "cancelled", "succeeded"] as const) {
          if (status === "succeeded" && operation !== "reconciliation") continue;
          await reset(operation);
          const before = {ingestion_at : state.ingestion_at, processing_at : state.processing_at};
          await record_pipeline_execution_completion("execution", {status});
          assert.deepEqual({ingestion_at : state.ingestion_at, processing_at : state.processing_at}, before);
          assert.equal(state.history?.status, status);
        }
      }
    });

    await context.test("a missing state row or state write failure rolls history completion back", async () => {
      for (const operation of ["ingestion", "processing"]) {
        for (const failure of ["missing", "write"]) {
          await reset(operation);
          state.state_exists = failure !== "missing";
          state.fail_state_write = failure === "write";
          const before = structuredClone(state);
          await assert.rejects(record_pipeline_execution_completion("execution", {status : "succeeded"}));
          assert.deepEqual(state, before);
          assert.equal(state.history?.status, "running");
          assert.equal(state.history?.finished_at, null);
        }
      }
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
