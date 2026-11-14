import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Executer_Module = typeof import("../core/system/ingestion-executer.ts");
type Toast_Module = typeof import("../core/toast/toast-ingestion.ts");
type Schema_Module = typeof import("../core/toast/toast-schema.ts");
type Test_State = {
  watermark : Date | null;
  checkpoints : Date[];
  loaded : string[];
  fail_load : boolean;
  fail_checkpoint : boolean;
  discoveries : number;
  restaurants : string[];
  visits : Array<{restaurant_guid : string; start_at : Date; end_at : Date}>;
  fail_restaurant : string | null;
};

test("one ingestion flow with synthetic persistence and source adapters", async context => {
  const directory = mkdtempSync(join(tmpdir(), "ingestion-executer-test-"));
  try {
    const system_directory = join(directory, "core", "system");
    const toast_directory = join(directory, "core", "toast");
    mkdirSync(system_directory, {recursive : true});
    mkdirSync(toast_directory, {recursive : true});
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["ingestion-executer.ts", "ingestion-windows.ts", "pipeline-orchestrator.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(system_directory, filename));
    }
    for (const filename of ["toast-ingestion.ts", "toast-configuration.ts", "toast-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "toast", filename), join(toast_directory, filename));
    }
    writeFileSync(join(directory, "test-state.ts"), `
export const state = {
  watermark : null, checkpoints : [], loaded : [],
  fail_load : false, fail_checkpoint : false, discoveries : 0,
  restaurants : ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  visits : [], fail_restaurant : null
};
`);
    writeFileSync(join(system_directory, "pipeline-history.ts"), `
export async function record_pipeline_execution_start() { return "synthetic-execution"; }
export async function record_pipeline_execution_completion() {}
`);
    writeFileSync(join(system_directory, "pipeline-progress.ts"), `
import {state} from "../../test-state.ts";
export async function get_or_create_pipeline_progress() {
  return {ingestion_watermark : state.watermark};
}
export async function record_ingestion_window_completion(name, id, previous, end_at) {
  if (state.fail_checkpoint) throw new Error("Synthetic checkpoint failure.");
  if (previous?.getTime() !== state.watermark?.getTime()) throw new Error("Unexpected previous checkpoint.");
  state.checkpoints.push(end_at);
  state.watermark = end_at;
}
`);
    writeFileSync(join(system_directory, "raw-pipeline-loader.ts"), `
import {state} from "../../test-state.ts";
export async function load_raw_records(table, execution_id, records) {
  if (state.fail_load) throw new Error("Synthetic load failure.");
  state.loaded.push(...records.map(record => record.source_record_id));
  return records.length;
}
`);
    writeFileSync(join(toast_directory, "toast-restaurants.ts"), `
import {state} from "../../test-state.ts";
export async function get_toast_restaurants(signal) {
  signal.throwIfAborted();
  state.discoveries++;
  return state.restaurants.map(restaurantGuid => ({restaurantGuid}));
}
`);
    writeFileSync(join(toast_directory, "toast-orders.ts"), `
import {state} from "../../test-state.ts";
export async function* extract_toast_raw_order_window(restaurant_guid, window, signal) {
  signal.throwIfAborted();
  state.visits.push({restaurant_guid, ...window});
  if (restaurant_guid === state.fail_restaurant) throw new Error("Synthetic restaurant failure.");
  yield [{source_record_id : restaurant_guid, content : {}}];
}
`);
    const {execute_ingestion} : Executer_Module = await import(pathToFileURL(join(system_directory, "ingestion-executer.ts")).href);
    const {ingest_toast_orders} : Toast_Module = await import(pathToFileURL(join(toast_directory, "toast-ingestion.ts")).href);
    const {Raw_Toast_Orders} : Schema_Module = await import(pathToFileURL(join(toast_directory, "toast-schema.ts")).href);
    const {state} : {state : Test_State} = await import(pathToFileURL(join(directory, "test-state.ts")).href);
    const fixed_now = new Date("2026-01-03T12:00:00.000Z");
    context.mock.timers.enable({apis : ["Date"], now : fixed_now.getTime()});
    const signal = new AbortController().signal;
    const settings = {
      raw_table : Raw_Toast_Orders,
      operation : "ingestion",
      source_configuration : {data_start_date : new Date("2026-01-01T00:00:00.000Z")},
      signal : signal
    };
    const reset = (): void => {
      state.watermark = null;
      state.checkpoints = [];
      state.loaded = [];
      state.fail_load = false;
      state.fail_checkpoint = false;
      state.discoveries = 0;
      state.visits = [];
      state.fail_restaurant = null;
    };
    await context.test("initial history and subsequent ingestion share windows and a fixed now", async () => {
      reset();
      const windows : Array<{start_at : Date; end_at : Date}> = [];
      await execute_ingestion({...settings, extract_window : async function* (window) {
        windows.push(window);
        context.mock.timers.tick(60_000);
        yield [{source_record_id : String(windows.length), content : {}}];
      }});
      assert.deepEqual(windows.map(window => [window.start_at.toISOString(), window.end_at.toISOString()]), [
        ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
        ["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
        ["2026-01-03T00:00:00.000Z", "2026-01-03T12:00:00.000Z"]
      ]);
      assert.equal(state.watermark?.getTime(), fixed_now.getTime());
      const resumed_windows : Array<{start_at : Date; end_at : Date}> = [];
      await execute_ingestion({...settings, extract_window : async function* (window) {
        resumed_windows.push(window);
      }});
      assert.equal(resumed_windows[0]?.start_at.getTime(), fixed_now.getTime());
      assert.equal(resumed_windows[0]?.end_at.getTime(), fixed_now.getTime() + 180_000);
    });
    await context.test("later-page failure preserves completed windows and replays the incomplete one", async () => {
      reset();
      let visited = 0;
      await assert.rejects(execute_ingestion({...settings, extract_window : async function* () {
        visited++;
        yield [{source_record_id : String(visited), content : {}}];
        if (visited === 2) throw new Error("Synthetic later-page failure.");
      }}));
      assert.equal(state.watermark?.toISOString(), "2026-01-02T00:00:00.000Z");
      assert.deepEqual(state.loaded, ["1", "2"]);
      let resumed_start : Date | undefined;
      await execute_ingestion({...settings, extract_window : async function* (window) {
        resumed_start ??= window.start_at;
      }});
      assert.equal(resumed_start?.toISOString(), "2026-01-02T00:00:00.000Z");
    });
    await context.test("load failure, checkpoint failure and cancellation cannot skip a window", async () => {
      for (const scenario of ["load", "checkpoint", "cancel"]) {
        reset();
        state.fail_load = scenario === "load";
        state.fail_checkpoint = scenario === "checkpoint";
        const controller = new AbortController();
        await assert.rejects(execute_ingestion({...settings, signal : controller.signal, extract_window : async function* () {
          yield [{source_record_id : "committed-before-cancel", content : {}}];
          if (scenario === "cancel") controller.abort();
        }}));
        assert.equal(state.watermark, null);
        assert.equal(state.checkpoints.length, 0);
      }
    });
    await context.test("explicit-date checks never read or advance normal coverage", async () => {
      reset();
      const original_watermark = new Date("2026-01-03T00:00:00.000Z");
      state.watermark = original_watermark;
      await execute_ingestion({
        raw_table : Raw_Toast_Orders, operation : "manual-check", signal : signal,
        start_at : new Date("2026-01-01T00:00:00.000Z"),
        end_at : new Date("2026-01-02T00:00:00.000Z"),
        extract_window : async function* () { yield [{source_record_id : "manual", content : {}}]; }
      });
      assert.equal(state.watermark, original_watermark);
      assert.equal(state.checkpoints.length, 0);
    });
    await context.test("Toast discovers once and includes every restaurant in every historical window", async () => {
      reset();
      await ingest_toast_orders(signal);
      assert.equal(state.discoveries, 1);
      assert.equal(state.visits[0]?.start_at.toISOString(), "2026-01-01T00:00:00.000Z");
      assert.equal(state.visits.length, state.checkpoints.length * 2);
      for (let index = 0; index < state.visits.length; index += 2) {
        assert.equal(state.visits[index]?.restaurant_guid, state.restaurants[0]);
        assert.equal(state.visits[index + 1]?.restaurant_guid, state.restaurants[1]);
        assert.equal(state.visits[index]?.end_at.getTime(), state.visits[index + 1]?.end_at.getTime());
      }
    });
    await context.test("one failing restaurant or empty discovery prevents a false checkpoint", async () => {
      reset();
      const failing_restaurant = state.restaurants[1];
      assert.ok(failing_restaurant);
      state.fail_restaurant = failing_restaurant;
      await assert.rejects(ingest_toast_orders(signal));
      assert.equal(state.loaded.length, 1);
      assert.equal(state.watermark, null);
      reset();
      state.restaurants = [];
      await assert.rejects(ingest_toast_orders(signal));
      assert.equal(state.watermark, null);
    });
    await context.test("invalid configured date fails without extraction", async () => {
      reset();
      await assert.rejects(execute_ingestion({
        ...settings, source_configuration : {data_start_date : new Date("invalid")},
        extract_window : async function* () { assert.fail("Invalid date reached extraction."); }
      }));
      assert.equal(state.watermark, null);
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
