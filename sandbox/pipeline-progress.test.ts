import assert from "node:assert/strict";
import {copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Progress_Module = typeof import("../core/system/pipeline-progress.ts");
type Persistence_State = {
  execution_exists : boolean;
  progress_matches : boolean;
  fail_history : boolean;
  watermark : Date | null;
  history_watermark : Date | null;
  rollbacks : number;
  predicates : Array<{sql : string; params : unknown[]}>;
};

test("window checkpoint transaction with synthetic warehouse persistence", async context => {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-progress-test-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["pipeline-progress.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(directory, filename));
    }
    writeFileSync(join(directory, "pgsql-warehouse.ts"), `
import {PgDialect} from "drizzle-orm/pg-core";
import {Pipeline_Progress} from "./system-schema.ts";
const dialect = new PgDialect();
export const state = {
  execution_exists : true, progress_matches : true, fail_history : false,
  watermark : null, history_watermark : null, rollbacks : 0, predicates : []
};
export const warehouse_db = {
  async transaction(work) {
    const before = {watermark : state.watermark, history_watermark : state.history_watermark};
    const selection = {
      from() {return this;}, innerJoin() {return this;},
      where(predicate) {state.predicates.push(dialect.sqlToQuery(predicate)); return this;},
      async for(mode) {
        if (mode !== "update") throw new Error("Missing checkpoint lock.");
        return state.execution_exists ? [{pipeline_progress_id : "synthetic-progress"}] : [];
      }
    };
    try {
      return await work({
        select() {return selection;},
        update(table) {
          return {set(values) {return {
            where(predicate) {
              state.predicates.push(dialect.sqlToQuery(predicate));
              if (table === Pipeline_Progress) {
                return {async returning() {
                  if (!state.progress_matches) return [];
                  state.watermark = values.ingestion_watermark;
                  return [{id : "synthetic-progress"}];
                }};
              }
              if (state.fail_history) throw new Error("Synthetic history write failure.");
              state.history_watermark = values.ingestion_watermark_after;
              return Promise.resolve();
            }
          };}};
        }
      });
    } catch (error) {
      state.watermark = before.watermark;
      state.history_watermark = before.history_watermark;
      state.rollbacks++;
      throw error;
    }
  }
};
`);
    const {record_ingestion_window_completion} : Progress_Module =
      await import(pathToFileURL(join(directory, "pipeline-progress.ts")).href);
    const {state} : {state : Persistence_State} =
      await import(pathToFileURL(join(directory, "pgsql-warehouse.ts")).href);
    const first_end = new Date("2026-01-02T00:00:00.000Z");
    const second_end = new Date("2026-01-03T00:00:00.000Z");

    await context.test("checks the running pipeline and expected watermark before saving coverage and history", async () => {
      await record_ingestion_window_completion("toast_orders", "synthetic-execution", null, first_end);
      assert.equal(state.watermark, first_end);
      assert.equal(state.history_watermark, first_end);
      assert.ok(state.predicates[0]?.params.includes("toast_orders"));
      assert.ok(state.predicates[0]?.params.includes("running"));
      assert.match(state.predicates[1]?.sql ?? "", /"ingestion_watermark" is null/);
      await record_ingestion_window_completion("toast_orders", "synthetic-execution", first_end, second_end);
      assert.ok(state.predicates[4]?.params.includes(first_end.toISOString()));
      assert.equal(state.watermark, second_end);
      assert.equal(state.history_watermark, second_end);
    });
    await context.test("mismatched execution or changed progress refuses checkpoint advancement", async () => {
      for (const scenario of ["execution", "progress"]) {
        state.execution_exists = scenario !== "execution";
        state.progress_matches = scenario !== "progress";
        await assert.rejects(record_ingestion_window_completion(
          "toast_orders", "synthetic-execution", second_end, new Date("2026-01-04T00:00:00.000Z")
        ));
        assert.equal(state.watermark, second_end);
      }
      state.execution_exists = true;
      state.progress_matches = true;
    });
    await context.test("history failure rolls back the checkpoint transaction", async () => {
      state.fail_history = true;
      await assert.rejects(record_ingestion_window_completion(
        "toast_orders", "synthetic-execution", second_end, new Date("2026-01-04T00:00:00.000Z")
      ));
      assert.equal(state.watermark, second_end);
      assert.equal(state.history_watermark, second_end);
      assert.equal(state.rollbacks, 3);
    });
    await context.test("invalid and nonadvancing checkpoints fail before persistence", async () => {
      const predicates_before = state.predicates.length;
      for (const end_at of [new Date("invalid"), first_end, second_end]) {
        await assert.rejects(record_ingestion_window_completion("toast_orders", "synthetic-execution", second_end, end_at));
      }
      assert.equal(state.predicates.length, predicates_before);
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
