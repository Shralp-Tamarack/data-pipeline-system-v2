import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Raw_Location = {
  id : string;
  source_record_id : string;
  content : {locationName : string; deleted : boolean};
  content_revision : number;
  processed : boolean;
  deleted : boolean;
};

type Processing_State = {
  raw : Raw_Location[];
  output : Array<{
    id : string;
    source_system : string;
    source_record_id : string;
    name : string;
    raw_content_revision : number;
    type : string;
  }>;
  count : number;
  fail_at : string;
  pipeline_name : string;
  execution_valid : boolean;
  batches : number[];
  lock_order : string[];
  predicates : Array<{sql : string; params : unknown[]}>;
  upsert_columns : string[];
  rollbacks : number;
};

test("Toast location processing with synthetic transactional persistence", async context => {
  const directory = mkdtempSync(join(tmpdir(), "toast-processing-test-"));
  const system_directory = join(directory, "core", "system");
  const toast_directory = join(directory, "core", "toast");

  try {
    mkdirSync(system_directory, {recursive : true});
    mkdirSync(toast_directory, {recursive : true});
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["system-schema.ts", "pipeline-operation.ts", "processing.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(system_directory, filename));
    }
    for (const filename of ["toast-schema.ts", "toast-locations.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "toast", filename), join(toast_directory, filename));
    }
    writeFileSync(join(toast_directory, "toast-location-type-map.ts"), `
export const toast_location_type_map = new Map();
`);
    writeFileSync(join(system_directory, "system-configuration.ts"), `
export const env_vars = {system_environment : "experimental"};
`);
    writeFileSync(join(system_directory, "system-logger.ts"), `
export const log_entries = [];
export const system_logger = {
  child() {return this;}, info(fields) {log_entries.push(fields);}, warn() {}, error() {}
};
`);
    writeFileSync(join(system_directory, "pipeline-history.ts"), `
export const completions = [];
export async function record_pipeline_execution_start() {return "synthetic-execution";}
export async function record_pipeline_execution_completion(execution_id, outcome) {
  completions.push(outcome.status);
}
`);
    writeFileSync(join(system_directory, "raw-pipeline-loader.ts"), `
export async function load_raw_records() {throw new Error("Processing must not run ingestion.");}
`);
    writeFileSync(join(toast_directory, "toast-authentication.ts"), `
export async function request_toast_authorized_json() {throw new Error("Processing must not call Toast.");}
`);
    writeFileSync(join(toast_directory, "toast-request.ts"), `export class Toast_Request_Error extends Error {}`);
    writeFileSync(join(system_directory, "pgsql-warehouse.ts"), `
import assert from "node:assert/strict";
import {PgDialect} from "drizzle-orm/pg-core";
import {Pipeline_Execution_History} from "./system-schema.ts";
import {Raw_Toast_Locations, Processed_Locations} from "../toast/toast-schema.ts";
const dialect = new PgDialect();
export const state = {
  raw : [], output : [], count : 0, fail_at : "", pipeline_name : "toast_locations",
  execution_valid : true, batches : [], lock_order : [], predicates : [],
  upsert_columns : [], rollbacks : 0
};
export const warehouse_db = {
  async transaction(work) {
    const before = structuredClone({raw : state.raw, output : state.output, count : state.count});
    let selected = [];
    try {
      return await work({
        select() {
          let table;
          let limit;
          let query;
          return {
            from(value) {table = value; return this;},
            innerJoin() {return this;},
            where(predicate) {
              query = dialect.sqlToQuery(predicate);
              state.predicates.push(query);
              return this;
            },
            orderBy() {return this;},
            limit(value) {limit = value; return this;},
            async for(mode) {
              assert.equal(mode, "update");
              if (table === Pipeline_Execution_History) {
                state.lock_order.push("history");
                return state.execution_valid ? [{pipeline_name : state.pipeline_name}] : [];
              }
              if (table === Processed_Locations) {
                assert.match(query.sql, /"source_system"/);
                assert.match(query.sql, /"source_record_id"/);
                assert.equal(query.params[0], "toast");
                state.lock_order.push("processed");
                const location = state.output.find(record =>
                  record.source_system === query.params[0] && record.source_record_id === query.params[1]
                );
                return location ? [structuredClone(location)] : [];
              }
              assert.equal(table, Raw_Toast_Locations);
              assert.equal(state.lock_order.at(-1), "history");
              assert.equal(limit, 100);
              state.lock_order.push("raw");
              selected = state.raw.filter(record => !record.processed).slice(0, limit);
              state.batches.push(selected.length);
              return structuredClone(selected);
            }
          };
        },
        insert(table) {
          assert.equal(table, Processed_Locations);
          return {values(records) {return {
            async onConflictDoUpdate(config) {
              assert.deepEqual(config.target, [Processed_Locations.source_system, Processed_Locations.source_record_id]);
              state.upsert_columns = Object.keys(config.set);
              for (const record of records) {
                const existing = state.output.find(output =>
                  output.source_system === record.source_system && output.source_record_id === record.source_record_id
                );
                if (existing) {
                  for (const key of state.upsert_columns) {
                    if (key !== "updated_at") existing[key] = record[key];
                  }
                } else {
                  state.output.push({...record, id : "processed-" + record.raw_record_id, type : "unclassified"});
                }
              }
              if (state.fail_at === "upsert") throw new Error("Synthetic upsert failure.");
            }
          };}};
        },
        update(table) {
          return {set(values) {return {where(predicate) {
            const query = dialect.sqlToQuery(predicate);
            state.predicates.push(query);
            return {async returning() {
              if (table === Processed_Locations) {
                assert.deepEqual(Object.keys(values).sort(), ["type", "updated_at"]);
                assert.match(query.sql, /"id"/);
                assert.match(dialect.sqlToQuery(values.updated_at).sql, /now\\(\\)/);
                const location = state.output.find(record => record.id === query.params[0]);
                assert.ok(location);
                location.type = values.type;
                location.updated_at = "synthetic-update";
                if (state.fail_at === "type-update") throw new Error("Synthetic type update failure.");
                return state.fail_at === "type-acknowledgment" ? [] : [{id : location.id}];
              }
              if (table === Raw_Toast_Locations) {
                assert.equal(values.processed, true);
                assert.match(query.sql, /"content_revision"/);
                for (const record of selected) {
                  assert.ok(query.params.includes(record.id));
                  assert.ok(query.params.includes(record.content_revision));
                }
                const completed = state.fail_at === "acknowledgment" ? selected.slice(1) : selected;
                for (const record of completed) record.processed = true;
                return completed.map(record => ({id : record.id}));
              }
              assert.equal(table, Pipeline_Execution_History);
              assert.ok(query.params.includes("synthetic-execution"));
              assert.ok(query.params.includes("running"));
              assert.ok(query.params.includes("processing"));
              const increment = dialect.sqlToQuery(values.records_processed);
              assert.match(increment.sql, /"records_processed" \\+ /);
              assert.deepEqual(increment.params, [selected.length]);
              state.count += selected.length;
              if (state.fail_at === "history") throw new Error("Synthetic history failure.");
              return [{id : "synthetic-execution"}];
            }};
          }};}};
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
    const {process_toast_locations} : typeof import("../core/toast/toast-locations.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-locations.ts")).href);
    const {process_pending_raw_records} : typeof import("../core/system/processing.ts") =
      await import(pathToFileURL(join(system_directory, "processing.ts")).href);
    const {Raw_Toast_Locations} : typeof import("../core/toast/toast-schema.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-schema.ts")).href);
    const {state} : {state : Processing_State} =
      await import(pathToFileURL(join(system_directory, "pgsql-warehouse.ts")).href);
    const {toast_location_type_map} : typeof import("../core/toast/toast-location-type-map.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-location-type-map.ts")).href);
    const {env_vars} : {env_vars : {system_environment : string}} =
      await import(pathToFileURL(join(system_directory, "system-configuration.ts")).href);
    const {log_entries} : {log_entries : Array<{event : string; locations_updated? : number}>} =
      await import(pathToFileURL(join(system_directory, "system-logger.ts")).href);
    const {completions} : {completions : string[]} =
      await import(pathToFileURL(join(system_directory, "pipeline-history.ts")).href);

    function reset(record_count : number = 1): void {
      toast_location_type_map.clear();
      toast_location_type_map.set("source-0", "retail");
      env_vars.system_environment = "experimental";
      log_entries.length = 0;
      completions.length = 0;
      state.raw = Array.from({length : record_count}, (_, index) => ({
        id : `raw-${index}`,
        source_record_id : `source-${index}`,
        content : {locationName : `Location ${index}`, deleted : false},
        content_revision : 1,
        processed : false,
        deleted : false
      }));
      Object.assign(state, {
        output : [], count : 0, fail_at : "", pipeline_name : "toast_locations",
        execution_valid : true, batches : [], lock_order : [], predicates : [],
        upsert_columns : [], rollbacks : 0
      });
    }
    const execute_test_processing = () => process_toast_locations(new AbortController().signal);

    await context.test("shared processing finalizes once on empty and releases the guard after finalization failure", async () => {
      reset(0);
      const settings = {
        raw_table : Raw_Toast_Locations,
        signal : new AbortController().signal,
        write_processed_records : async () => assert.fail("Empty batches must not call the writer.")
      };
      await assert.rejects(process_pending_raw_records({
        ...settings,
        finalize_processing : async () => {
          await assert.rejects(process_pending_raw_records(settings), /already running in this process/);
          throw new Error("Synthetic finalization failure.");
        }
      }), /Pipeline execution .* failed/);
      let finalizations = 0;
      await process_pending_raw_records({
        ...settings,
        finalize_processing : async () => {finalizations++; }
      });
      assert.equal(finalizations, 1);
      assert.deepEqual(completions, ["failed", "succeeded"]);
    });

    await context.test("cancellation prevents startup or further batches and finalization without undoing committed work", async () => {
      reset(101);
      const controller = new AbortController();
      const settings = {
        raw_table : Raw_Toast_Locations,
        signal : controller.signal,
        write_processed_records : async () => {controller.abort();},
        finalize_processing : async () => assert.fail("Cancelled processing must not finalize.")
      };
      await assert.rejects(process_pending_raw_records(settings), /Pipeline execution .* failed/);
      assert.equal(state.count, 100);
      assert.equal(state.raw.filter(record => !record.processed).length, 1);
      assert.deepEqual(state.batches, [100]);
      const before = structuredClone(state);
      await assert.rejects(process_pending_raw_records(settings));
      assert.deepEqual(state, before);
      assert.deepEqual(completions, ["failed"]);
    });

    await context.test("drains 250 rows in bounded batches and a second run is a no-op", async () => {
      reset(250);
      assert.equal((await execute_test_processing()).status, "succeeded");
      assert.deepEqual(state.batches, [100, 100, 50, 0]);
      assert.equal(state.output.length, 250);
      assert.equal(state.count, 250);
      assert.equal(state.output[0]?.type, "retail");
      assert.ok(state.output.slice(1).every(location => location.type === "unclassified"));
      assert.ok(state.raw.every(record => record.processed));
      const before = structuredClone(state.output);
      await execute_test_processing();
      assert.deepEqual(state.output, before);
      assert.equal(state.count, 250);
      assert.deepEqual(
        log_entries.filter(entry => entry.event === "location_types_applied")
          .map(entry => entry.locations_updated),
        [1, 0]
      );
      assert.ok(state.predicates[0]?.params.includes("processing"));
      assert.ok(state.predicates[0]?.params.includes("running"));
      assert.ok(state.predicates[1]?.params.includes("toast_locations"));
      assert.ok(state.predicates[1]?.params.includes(false));
    });

    await context.test("a rename updates the same location and revision without replacing its reviewed classification", async () => {
      reset();
      await execute_test_processing();
      const original = state.output[0];
      const raw = state.raw[0];
      assert.ok(original && raw);
      original.type = "retail";
      toast_location_type_map.clear();
      toast_location_type_map.set("source-1", "food_and_beverage");
      const other = structuredClone(original);
      other.id = "other-processed-location";
      other.source_record_id = "source-1";
      other.type = "food_and_beverage";
      state.output.push(other);
      const original_id = original.id;
      raw.content = {locationName : "Renamed outlet", deleted : true};
      raw.content_revision = 2;
      raw.processed = false;
      await execute_test_processing();
      assert.equal(state.output.length, 2);
      assert.equal(state.output[0]?.id, original_id);
      assert.equal(state.output[0]?.name, "Renamed outlet");
      assert.equal(state.output[0]?.raw_content_revision, 2);
      assert.equal(state.output[0]?.type, "retail");
      assert.equal(state.upsert_columns.includes("type"), false);
      assert.equal(state.upsert_columns.includes("created_at"), false);
      assert.equal(state.upsert_columns.includes("source_record_id"), false);
      assert.equal(state.count, 2);
    });

    await context.test("mapping edits apply without pending Raw and do not change Raw-processing counts", async () => {
      reset();
      await execute_test_processing();
      const before_raw = structuredClone(state.raw);
      toast_location_type_map.set("source-0", "food_and_beverage");
      await execute_test_processing();
      assert.equal(state.output[0]?.type, "food_and_beverage");
      assert.equal(state.count, 1);
      assert.deepEqual(state.raw, before_raw);
      assert.deepEqual(completions, ["succeeded", "succeeded"]);
      assert.deepEqual(
        log_entries.filter(entry => entry.event === "location_types_applied")
          .map(entry => entry.locations_updated),
        [1, 1]
      );
    });

    await context.test("missing locations or failed type writes roll back all classifications, retaining committed Raw work", async () => {
      for (const failure of ["missing", "type-update", "type-acknowledgment"]) {
        reset(2);
        toast_location_type_map.set(failure === "missing" ? "unknown-source" : "source-1", "food_and_beverage");
        state.fail_at = failure;
        await assert.rejects(execute_test_processing(), /Pipeline execution .* failed/);
        assert.equal(state.count, 2);
        assert.ok(state.raw.every(record => record.processed));
        assert.ok(state.output.every(location => location.type === "unclassified"));
        assert.deepEqual(completions, ["failed"]);
        assert.equal(log_entries.some(entry => entry.event === "location_types_applied"), false);
        state.fail_at = "";
        toast_location_type_map.delete("unknown-source");
        await execute_test_processing();
        assert.equal(state.output[0]?.type, "retail");
        assert.equal(state.count, 2);
        assert.equal(completions.at(-1), "succeeded");
      }
    });

    await context.test("empty mappings and operational targets refuse classification writes", async () => {
      for (const scenario of ["empty-map", "operational"]) {
        reset();
        if (scenario === "empty-map") toast_location_type_map.clear();
        else env_vars.system_environment = "operational";
        await assert.rejects(execute_test_processing(), /Pipeline execution .* failed/);
        assert.equal(state.output[0]?.type, "unclassified");
        assert.deepEqual(completions, ["failed"]);
      }
    });

    await context.test("mapping, upsert, acknowledgment and history failures leave the whole batch pending", async () => {
      for (const failure of ["mapping", "upsert", "acknowledgment", "history"]) {
        reset(2);
        state.fail_at = failure;
        if (failure === "mapping") {
          const record = state.raw[1];
          assert.ok(record);
          record.content.locationName = "";
        }
        await assert.rejects(execute_test_processing(), /Pipeline execution .* failed/);
        assert.deepEqual(state.output, []);
        assert.equal(state.count, 0);
        assert.ok(state.raw.every(record => !record.processed));
        assert.equal(state.rollbacks, 1);
      }
    });

    await context.test("a later batch failure preserves earlier committed work and can be retried", async () => {
      reset(101);
      const invalid = state.raw[100];
      assert.ok(invalid);
      invalid.content.locationName = "";
      await assert.rejects(execute_test_processing());
      assert.equal(state.count, 100);
      assert.equal(state.output.length, 100);
      assert.equal(state.raw.filter(record => !record.processed).length, 1);
      const remaining = state.raw[100];
      assert.ok(remaining);
      remaining.content.locationName = "Repaired outlet";
      await execute_test_processing();
      assert.equal(state.count, 101);
      assert.equal(state.output.length, 101);
    });

    await context.test("rejects invalid or wrong-pipeline executions before locking Raw, even for an empty catalog", async () => {
      for (const scenario of ["missing", "wrong-pipeline"]) {
        reset(0);
        state.execution_valid = scenario !== "missing";
        state.pipeline_name = scenario === "wrong-pipeline" ? "toast_orders" : "toast_locations";
        await assert.rejects(execute_test_processing());
        assert.deepEqual(state.lock_order, ["history"]);
        assert.deepEqual(state.batches, []);
      }
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
