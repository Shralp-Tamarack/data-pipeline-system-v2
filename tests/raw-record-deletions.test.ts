import assert from "node:assert/strict";
import {copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Test_Record = {
  id : string;
  source_record_id : string;
  record_source : string;
  content : {name : string};
  source_context : {account : string};
  deleted : boolean;
  processed : boolean;
  content_revision : number;
  execution_id : string;
  created_at : string;
  updated_at : string;
};

type Deletion_State = {
  records : Test_Record[];
  count : number;
  execution_valid : boolean;
  pipeline_name : string;
  fail_at : string;
  transactions : number;
  rollbacks : number;
  events : string[];
};

test("shared Raw deletion helper with synthetic transactional persistence", async context => {
  const directory = mkdtempSync(join(tmpdir(), "raw-deletions-test-"));

  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["raw-pipeline-loader.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(directory, filename));
    }
    writeFileSync(join(directory, "pgsql-warehouse.ts"), `
import assert from "node:assert/strict";
import {PgDialect} from "drizzle-orm/pg-core";
import {Pipeline_Operation_History} from "./system-schema.ts";
const dialect = new PgDialect();
export const state = {
  records : [], count : 0, execution_valid : true, pipeline_name : "synthetic_records",
  fail_at : "", transactions : 0, rollbacks : 0, events : []
};
export const warehouse_db = {
  async transaction(work) {
    state.transactions++;
    const before = structuredClone({records : state.records, count : state.count});
    try {
      return await work({
        select() {
          return {
            from(table) {assert.equal(table, Pipeline_Operation_History); return this;},
            innerJoin() {return this;},
            where(predicate) {
              const query = dialect.sqlToQuery(predicate);
              assert.match(query.sql, /"id"/);
              assert.match(query.sql, /"status"/);
              assert.deepEqual(query.params, ["current-execution", "running"]);
              return this;
            },
            async for(mode) {
              assert.equal(mode, "update");
              state.events.push("execution-lock");
              return state.execution_valid ? [{pipeline_name : state.pipeline_name}] : [];
            }
          };
        },
        update(table) {
          return {set(values) {return {where(predicate) {
            const query = dialect.sqlToQuery(predicate);
            if (table === Pipeline_Operation_History) {
              assert.deepEqual(query.params, ["current-execution"]);
              assert.match(query.sql, /"id"/);
              assert.deepEqual(Object.keys(values), ["records_loaded"]);
              const increment = dialect.sqlToQuery(values.records_loaded);
              assert.match(increment.sql, /"records_loaded" \\+ /);
              state.events.push("history-count");
              state.count += increment.params[0];
              if (state.fail_at === "history") throw new Error("Synthetic history failure.");
              return Promise.resolve();
            }
            return {async returning() {
              assert.equal(state.events.at(-1), "execution-lock");
              state.events.push("raw-update");
              assert.match(query.sql, /"record_source"/);
              assert.match(query.sql, /"source_record_id" in /);
              assert.match(query.sql, /"deleted"/);
              assert.equal(query.params[0], "synthetic_records");
              assert.equal(query.params.at(-1), false);
              assert.deepEqual(Object.keys(values).sort(), [
                "content_revision", "deleted", "execution_id", "processed", "updated_at"
              ]);
              assert.equal(values.deleted, true);
              assert.equal(values.processed, false);
              assert.equal(values.execution_id, "current-execution");
              const revision = dialect.sqlToQuery(values.content_revision);
              assert.match(revision.sql, /"content_revision" \\+ 1$/);
              assert.match(dialect.sqlToQuery(values.updated_at).sql, /now\\(\\)/);
              const source_ids = query.params.slice(1, -1);
              const changed = state.records.filter(record =>
                record.record_source === query.params[0] &&
                source_ids.includes(record.source_record_id) && !record.deleted
              );
              for (const record of changed) {
                record.deleted = true;
                record.processed = false;
                record.content_revision++;
                record.execution_id = values.execution_id;
                record.updated_at = "deletion-time";
              }
              if (state.fail_at === "raw") throw new Error("Synthetic Raw update failure.");
              return changed.map(record => ({id : record.id}));
            }};
          }};}}
        }
      });
    } catch (error) {
      Object.assign(state, before);
      state.rollbacks++;
      throw error;
    }
  }
};
`);
    const {mark_raw_records_deleted} : typeof import("../core/system/raw-pipeline-loader.ts") =
      await import(pathToFileURL(join(directory, "raw-pipeline-loader.ts")).href);
    const {create_raw_table} : typeof import("../core/system/system-schema.ts") =
      await import(pathToFileURL(join(directory, "system-schema.ts")).href);
    const {state} : {state : Deletion_State} =
      await import(pathToFileURL(join(directory, "pgsql-warehouse.ts")).href);
    const raw_table = create_raw_table("synthetic_records");
    const mark_deleted = (ids : string[]) =>
      mark_raw_records_deleted(raw_table, "current-execution", ids);

    function reset(record_count : number = 1): void {
      Object.assign(state, {
        count : 0, execution_valid : true, pipeline_name : "synthetic_records",
        fail_at : "", transactions : 0, rollbacks : 0, events : []
      });
      state.records = Array.from({length : record_count}, (_, index) => ({
        id : `raw-${index}`,
        source_record_id : `source-${index}`,
        record_source : "synthetic_records",
        content : {name : `Record ${index}`},
        source_context : {account : "synthetic-account"},
        deleted : false,
        processed : true,
        content_revision : 3,
        execution_id : "original-execution",
        created_at : "creation-time",
        updated_at : "original-time"
      }));
    }

    await context.test("queues only confirmed active records while preserving payload and identity", async () => {
      reset(2);
      const original = structuredClone(state.records[0]);
      assert.ok(original);
      const unrelated = structuredClone(state.records[1]);
      const other_source = {...original, id : "other-source", record_source : "another_pipeline"};
      state.records.push(other_source);
      assert.equal(await mark_deleted(["source-0", "unknown-source"]), 1);
      assert.deepEqual(state.records[0], {
        ...original, deleted : true, processed : false, content_revision : 4,
        execution_id : "current-execution", updated_at : "deletion-time"
      });
      assert.deepEqual(state.records[1], unrelated);
      assert.deepEqual(other_source, {...original, id : "other-source", record_source : "another_pipeline"});
      assert.equal(state.count, 1);
      assert.deepEqual(state.events, ["execution-lock", "raw-update", "history-count"]);

      const before_replay = structuredClone(state.records);
      assert.equal(await mark_deleted(["source-0"]), 0);
      assert.deepEqual(state.records, before_replay);
      assert.equal(state.count, 1);
    });

    await context.test("accepts a full batch or empty list and rejects invalid batches before persistence", async () => {
      reset(100);
      assert.equal(await mark_deleted(state.records.map(record => record.source_record_id)), 100);
      assert.equal(state.count, 100);
      assert.equal(await mark_deleted([]), 0);
      const before = state.transactions;
      for (const ids of [
        [" "], ["source-0", "source-0"],
        Array.from({length : 101}, (_, index) => `source-${index}`)
      ]) {
        await assert.rejects(mark_deleted(ids), /at most 100|missing its source identity|duplicate source identities/);
      }
      assert.equal(state.transactions, before);
      assert.equal(state.count, 100);
    });

    await context.test("requires a running execution for the selected pipeline, even for empty batches", async () => {
      for (const ids of [[], ["source-0"]]) {
        for (const scenario of ["missing-or-finished", "wrong-pipeline"]) {
          reset();
          state.execution_valid = scenario !== "missing-or-finished";
          state.pipeline_name = scenario === "wrong-pipeline" ? "another_pipeline" : "synthetic_records";
          const before = structuredClone(state.records);
          await assert.rejects(mark_deleted(ids), /requires a running execution for this pipeline/);
          assert.deepEqual(state.records, before);
          assert.equal(state.count, 0);
          assert.deepEqual(state.events, ["execution-lock"]);
        }
      }
    });

    await context.test("Raw or history failure rolls back flags, revisions and execution counts", async () => {
      for (const failure of ["raw", "history"]) {
        reset(2);
        state.fail_at = failure;
        const before = structuredClone(state.records);
        await assert.rejects(mark_deleted(["source-0", "source-1"]), /Synthetic .* failure/);
        assert.deepEqual(state.records, before);
        assert.equal(state.count, 0);
        assert.equal(state.rollbacks, 1);
      }
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
