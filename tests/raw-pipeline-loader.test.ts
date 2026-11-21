import assert from "node:assert/strict";
import {copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";
import type {Raw_Record_Input} from "../core/system/ingestion-types.ts";

type Stored_Record = Raw_Record_Input & {
  id : string;
  record_source : string;
  deleted : boolean;
  processed : boolean;
  content_revision : number;
  execution_id : string;
  created_at : string;
  updated_at : string;
};

type Loader_State = {
  records : Stored_Record[];
  count : number;
  fail_history : boolean;
  rollbacks : number;
};

test("Raw loading deletion and restoration with local SQL expression evaluation", async context => {
  const directory = mkdtempSync(join(tmpdir(), "raw-loader-test-"));

  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["raw-pipeline-loader.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(directory, filename));
    }
    writeFileSync(join(directory, "pgsql-warehouse.ts"), `
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {PgDialect} from "drizzle-orm/pg-core";
import {Pipeline_Operation_History} from "./system-schema.ts";

const dialect = new PgDialect();
export const state = {records : [], count : 0, fail_history : false, rollbacks : 0};

export const warehouse_db = {
  async transaction(work) {
    const before = structuredClone({records : state.records, count : state.count});
    const database = new DatabaseSync(":memory:");
    let incoming = [];
    database.exec(\`
      ATTACH DATABASE ':memory:' AS raw;
      CREATE TABLE raw.synthetic_records (
        source_record_id TEXT, content TEXT, source_context TEXT,
        deleted INTEGER, content_revision INTEGER, execution_id TEXT
      );
      CREATE TABLE excluded (
        source_record_id TEXT, content TEXT, source_context TEXT,
        deleted INTEGER, content_revision INTEGER, execution_id TEXT
      );
    \`);

    // Execute the emitted CASE/WHERE expressions, not a rewritten JavaScript deletion rule.
    // Persistence and rollback are simulated; this is not a PostgreSQL integration test.
    function evaluate(expression) {
      const query = dialect.sqlToQuery(expression);
      const bindings = Object.fromEntries(query.params.map((value, index) => ["$" + (index + 1), value]));
      return database.prepare(
        "SELECT " + query.sql + " AS value FROM raw.synthetic_records CROSS JOIN excluded"
      ).get(bindings).value;
    }

    function stage(table, record) {
      database.exec("DELETE FROM " + table);
      database.prepare("INSERT INTO " + table + " VALUES (?, ?, ?, ?, ?, ?)").run(
        record.source_record_id, JSON.stringify(record.content),
        record.source_context === undefined ? null : JSON.stringify(record.source_context),
        Number(record.deleted), record.content_revision ?? 1, record.execution_id
      );
    }

    try {
      return await work({
        select() {
          let table;
          return {
            from(value) {table = value; return this;},
            innerJoin() {return this;},
            where() {return this;},
            async for(mode) {
              assert.equal(table, Pipeline_Operation_History);
              assert.equal(mode, "update");
              return [{pipeline_name : "synthetic_records"}];
            },
            async limit() {
              const conflict = incoming.some(record => {
                if (record.source_context === undefined) return false;
                const stored = state.records.find(existing =>
                  existing.source_record_id === record.source_record_id &&
                  existing.record_source === record.record_source
                );
                return stored && JSON.stringify(stored.source_context) !== JSON.stringify(record.source_context);
              });
              return conflict ? [{id : "conflict"}] : [];
            }
          };
        },
        insert() {
          return {values(records) {
            incoming = records;
            return {onConflictDoUpdate(config) {
              return {async returning() {
                assert.deepEqual(Object.keys(config.set).sort(), [
                  "content", "content_revision", "deleted", "execution_id", "processed", "updated_at"
                ]);
                assert.equal(config.set.processed, false);
                assert.match(dialect.sqlToQuery(config.set.updated_at).sql, /now\\(\\)/);
                const changed = [];
                for (const record of records) {
                  assert.equal(typeof record.deleted, "boolean");
                  const stored = state.records.find(existing =>
                    existing.source_record_id === record.source_record_id &&
                    existing.record_source === record.record_source
                  );
                  if (!stored) {
                    const created = {
                      ...record, id : "raw-" + record.source_record_id,
                      content_revision : 1, processed : false,
                      created_at : "creation-time", updated_at : "creation-time"
                    };
                    state.records.push(created);
                    changed.push({id : created.id});
                    continue;
                  }
                  stage("raw.synthetic_records", stored);
                  stage("excluded", record);
                  if (!evaluate(config.setWhere)) continue;
                  const next_deleted = Boolean(evaluate(config.set.deleted));
                  const next_revision = evaluate(config.set.content_revision);
                  const next_content = JSON.parse(evaluate(config.set.content));
                  const next_execution_id = evaluate(config.set.execution_id);
                  Object.assign(stored, {
                    content : next_content, deleted : next_deleted,
                    content_revision : next_revision, execution_id : next_execution_id,
                    processed : config.set.processed, updated_at : "update-time"
                  });
                  changed.push({id : stored.id});
                }
                return changed;
              }};
            }};
          }};
        },
        update(table) {
          assert.equal(table, Pipeline_Operation_History);
          return {set(values) {return {async where() {
            const increment = dialect.sqlToQuery(values.records_loaded);
            assert.match(increment.sql, /"records_loaded" \\+ /);
            state.count += increment.params[0];
            if (state.fail_history) throw new Error("Synthetic history failure.");
          }};}};
        }
      });
    } catch (error) {
      Object.assign(state, before);
      state.rollbacks++;
      throw error;
    } finally {
      database.close();
    }
  }
};
`);
    const {load_raw_records} : typeof import("../core/system/raw-pipeline-loader.ts") =
      await import(pathToFileURL(join(directory, "raw-pipeline-loader.ts")).href);
    const {create_raw_table} : typeof import("../core/system/system-schema.ts") =
      await import(pathToFileURL(join(directory, "system-schema.ts")).href);
    const {state} : {state : Loader_State} =
      await import(pathToFileURL(join(directory, "pgsql-warehouse.ts")).href);
    const raw_table = create_raw_table("synthetic_records");
    const load = (records : Raw_Record_Input[]) =>
      load_raw_records(raw_table, "current-execution", records);

    function reset(): void {
      Object.assign(state, {records : [], count : 0, fail_history : false, rollbacks : 0});
    }

    async function seed(deleted : boolean): Promise<Stored_Record> {
      assert.equal(await load([{
        source_record_id : "source-0", content : {name : "Original"},
        source_context : {account : "original-account"}, deleted : deleted
      }]), 1);
      const record = state.records[0];
      assert.ok(record);
      record.processed = true;
      record.execution_id = "previous-execution";
      return structuredClone(record);
    }

    await context.test("inserts explicit deletion states and defaults new records to active", async () => {
      reset();
      assert.equal(await load([
        {source_record_id : "deleted", content : {}, deleted : true},
        {source_record_id : "active", content : {}, deleted : false},
        {source_record_id : "unspecified", content : {}}
      ]), 3);
      assert.deepEqual(state.records.map(record => record.deleted), [true, false, false]);
      assert.ok(state.records.every(record => !record.processed && record.content_revision === 1));
      assert.equal(state.count, 3);
    });

    await context.test("deletes and restores unchanged payloads once while preserving identity and context", async () => {
      for (const initially_deleted of [false, true]) {
        reset();
        const before = await seed(initially_deleted);
        const incoming = {
          source_record_id : before.source_record_id, content : before.content,
          deleted : !initially_deleted
        };
        assert.equal(await load([incoming]), 1);
        assert.deepEqual(state.records[0], {
          ...before, deleted : !initially_deleted, processed : false,
          content_revision : 2, execution_id : "current-execution", updated_at : "update-time"
        });
        const after = structuredClone(state.records);
        assert.equal(await load([incoming]), 0);
        assert.deepEqual(state.records, after);
        assert.equal(state.count, 2);
      }
    });

    await context.test("omitted status preserves deletion for equal and changed payloads", async () => {
      reset();
      const before = await seed(true);
      assert.equal(await load([{source_record_id : before.source_record_id, content : before.content}]), 0);
      assert.deepEqual(state.records[0], before);
      assert.equal(await load([{
        source_record_id : before.source_record_id, content : {name : "Renamed"}
      }]), 1);
      assert.deepEqual(state.records[0], {
        ...before, content : {name : "Renamed"}, deleted : true, processed : false,
        content_revision : 2, execution_id : "current-execution", updated_at : "update-time"
      });
      assert.equal(state.count, 2);
    });

    await context.test("mixed batches apply only explicitly supplied statuses and count each changed row once", async () => {
      reset();
      await load([
        {source_record_id : "delete", content : {}, deleted : false},
        {source_record_id : "restore", content : {}, deleted : true},
        {source_record_id : "preserve", content : {}, deleted : true},
        {source_record_id : "unchanged", content : {}, deleted : true}
      ]);
      for (const record of state.records) record.processed = true;
      assert.equal(await load([
        {source_record_id : "delete", content : {changed : true}, deleted : true},
        {source_record_id : "restore", content : {}, deleted : false},
        {source_record_id : "preserve", content : {changed : true}},
        {source_record_id : "unchanged", content : {}, deleted : true}
      ]), 3);
      assert.deepEqual(state.records.map(record => ({
        deleted : record.deleted, revision : record.content_revision, processed : record.processed
      })), [
        {deleted : true, revision : 2, processed : false},
        {deleted : false, revision : 2, processed : false},
        {deleted : true, revision : 2, processed : false},
        {deleted : true, revision : 1, processed : true}
      ]);
      assert.equal(state.count, 7);
    });

    await context.test("conflicting context or failed history rolls back deletion and restoration changes", async () => {
      for (const failure of ["context", "history"]) {
        for (const initially_deleted of [false, true]) {
          reset();
          const before_record = await seed(initially_deleted);
          const before = structuredClone({records : state.records, count : state.count});
          state.fail_history = failure === "history";
          await assert.rejects(load([{
            source_record_id : "new-record", content : {}
          }, {
            source_record_id : before_record.source_record_id, content : {changed : true},
            deleted : !initially_deleted,
            ...(failure === "context" ? {source_context : {account : "different-account"}} : {})
          }]), /source context conflicts|Synthetic history failure/);
          assert.deepEqual({records : state.records, count : state.count}, before);
          assert.equal(state.rollbacks, 1);
        }
      }
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
