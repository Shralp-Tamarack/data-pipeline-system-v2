import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Executer_Module = typeof import("../core/system/ingestion-executer.ts");
type Toast_Module = typeof import("../core/toast/toast-orders.ts");
type Locations_Module = typeof import("../core/toast/toast-locations.ts");
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
  fail_start_at : string | null;
  batches : Array<Array<{source_record_id : string; content : Record<string, unknown>}>>;
  known_locations : string[];
  fail_catalog_read : boolean;
  location_name : string;
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
    for (const filename of ["ingestion-executer.ts", "ingestion-windows.ts", "processing-executer.ts", "pipeline-orchestrator.ts", "system-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(system_directory, filename));
    }
    for (const filename of ["toast-orders.ts", "toast-locations.ts", "toast-location-type-map.ts", "toast-sync.ts", "toast-order-pagination.ts", "toast-request.ts", "toast-response.ts", "toast-schema.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "toast", filename), join(toast_directory, filename));
    }
    writeFileSync(join(toast_directory, "toast-configuration.ts"), `
export const toast_configuration = {
  data_start_date : new Date("2026-01-01T00:00:00.000Z"),
  window_size_in_days : 28,
  request_page_size : 100
};
`);
    writeFileSync(join(directory, "test-state.ts"), `
export const state = {
  watermark : null, checkpoints : [], loaded : [],
  fail_load : false, fail_checkpoint : false, discoveries : 0,
  restaurants : ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  visits : [], fail_restaurant : null, fail_start_at : null, batches : [],
  known_locations : [], fail_catalog_read : false, location_name : "Synthetic location"
};
`);
    writeFileSync(join(system_directory, "pipeline-history.ts"), `
export async function record_pipeline_execution_start() { return "synthetic-execution"; }
export async function record_pipeline_execution_completion() {}
`);
    writeFileSync(join(system_directory, "system-logger.ts"), `
export const log_entries = [];

function create_logger(bindings) {
  const capture = level => (fields, message) =>
    log_entries.push(JSON.parse(JSON.stringify({...bindings, ...fields, level, message})));
  return {
    child : fields => create_logger({...bindings, ...fields}),
    info : capture("info"),
    warn : capture("warn"),
    error : capture("error")
  };
}

export const system_logger = create_logger({});
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
import {getTableName} from "drizzle-orm";
export async function load_raw_records(table, execution_id, records) {
  if (state.fail_load) throw new Error("Synthetic load failure.");
  state.batches.push(records);
  state.loaded.push(...records.map(record => record.source_record_id));
  if (getTableName(table) === "toast_locations") {
    state.known_locations = [...new Set([...state.known_locations, ...records.map(record => record.source_record_id)])];
  }
  return records.length;
}
`);
    writeFileSync(join(system_directory, "pgsql-warehouse.ts"), `
import {state} from "../../test-state.ts";
export const warehouse_db = {
  select() {
    return {from() {return {async where() {
      if (state.fail_catalog_read) throw new Error("Synthetic catalog lookup failure.");
      return state.known_locations.map(source_record_id => ({source_record_id}));
    }}}};
  }
};
`);
    writeFileSync(join(system_directory, "system-configuration.ts"), `
export const env_vars = {toast_api_host : "https://example.com"};
`);
    writeFileSync(join(toast_directory, "toast-authentication.ts"), `
import {state} from "../../test-state.ts";
export async function request_toast_authorized_json(url, options) {
  options.signal?.throwIfAborted();
  if (url.pathname === "/partners/v1/restaurants") {
    state.discoveries++;
    return {
      data : state.restaurants.map(restaurantGuid => ({restaurantGuid, locationName : state.location_name})),
      headers : new Headers()
    };
  }
  const restaurant_guid = options.headers["Toast-Restaurant-External-ID"];
  const window = {
    start_at : new Date(url.searchParams.get("startDate")),
    end_at : new Date(url.searchParams.get("endDate"))
  };
  state.visits.push({restaurant_guid, ...window});
  if (restaurant_guid === state.fail_restaurant &&
      (!state.fail_start_at || window.start_at.toISOString() === state.fail_start_at)) {
    throw new Error("Synthetic restaurant failure.");
  }
  return {data : [{guid : restaurant_guid}], headers : new Headers()};
}
`);
    const {execute_ingestion} : Executer_Module = await import(pathToFileURL(join(system_directory, "ingestion-executer.ts")).href);
    const {log_entries} : {log_entries : Array<{event : string} & Record<string, unknown>>} =
      await import(pathToFileURL(join(system_directory, "system-logger.ts")).href);
    const {ingest_toast_orders} : Toast_Module = await import(pathToFileURL(join(toast_directory, "toast-orders.ts")).href);
    const {ingest_toast_locations, map_toast_location} : Locations_Module =
      await import(pathToFileURL(join(toast_directory, "toast-locations.ts")).href);
    const {execute_toast_sync} : typeof import("../core/toast/toast-sync.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-sync.ts")).href);
    const {Raw_Toast_Orders} : Schema_Module = await import(pathToFileURL(join(toast_directory, "toast-schema.ts")).href);
    const {state} : {state : Test_State} = await import(pathToFileURL(join(directory, "test-state.ts")).href);
    const {toast_configuration} : typeof import("../core/toast/toast-configuration.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-configuration.ts")).href);
    const fixed_now = new Date("2026-01-03T12:00:00.000Z");
    context.mock.timers.enable({apis : ["Date"], now : fixed_now.getTime()});
    const signal = new AbortController().signal;
    const get_location_warnings = () => log_entries.filter(entry => entry.event === "source_location_discovered");
    const settings = {
      raw_table : Raw_Toast_Orders,
      operation : "ingestion",
      source_configuration : {
        data_start_date : new Date("2026-01-01T00:00:00.000Z"),
        window_size_in_days : 1
      },
      ingestion_window_days : 1,
      ingestion_lookback_days : 0,
      signal : signal
    };
    const reset = (): void => {
      log_entries.length = 0;
      state.watermark = null;
      state.checkpoints = [];
      state.loaded = [];
      state.fail_load = false;
      state.fail_checkpoint = false;
      state.discoveries = 0;
      state.restaurants = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      ];
      state.visits = [];
      state.fail_restaurant = null;
      state.fail_start_at = null;
      state.batches = [];
      state.known_locations = [];
      state.fail_catalog_read = false;
      state.location_name = "Synthetic location";
    };
    const raw_location = {
      id : "33333333-3333-4333-8333-333333333333",
      source_record_id : "11111111-1111-4111-8111-111111111111",
      content : {locationName : "  Synthetic outlet  ", restaurantName : "Synthetic group", deleted : false},
      content_revision : 3,
      deleted : false
    };

    await context.test("maps a trimmed outlet name and exact Raw provenance without a business type", () => {
      assert.deepEqual(map_toast_location(raw_location), {
        raw_record_id : raw_location.id,
        source_system : "toast",
        source_record_id : raw_location.source_record_id,
        name : "Synthetic outlet",
        deleted : false,
        raw_content_revision : 3
      });
    });

    await context.test("falls back to the restaurant name and preserves soft deletion from either source", () => {
      const mapped_location = map_toast_location({
        ...raw_location,
        content : {locationName : " ", restaurantName : "  Synthetic group  ", deleted : true}
      });
      assert.equal(mapped_location.name, "Synthetic group");
      assert.equal(mapped_location.deleted, true);
      assert.equal(map_toast_location({...raw_location, deleted : true}).deleted, true);
    });

    await context.test("rejects malformed content, missing names and invalid deletion flags", () => {
      assert.throws(() => map_toast_location({...raw_location, content : []}), /must be an object/);
      assert.throws(() => map_toast_location({
        ...raw_location,
        content : {locationName : " ", restaurantName : null, deleted : false}
      }), /no usable name/);
      assert.throws(() => map_toast_location({
        ...raw_location,
        content : {...raw_location.content, deleted : "false"}
      }), /invalid deleted flag/);
    });

    await context.test("Toast sync finishes locations before starting orders", async () => {
      reset();
      await execute_toast_sync(signal);

      const locations_completed_at = log_entries.findIndex(entry =>
        entry.event === "pipeline_completed" &&
        entry.pipeline_name === "toast_locations" &&
        entry.status === "succeeded"
      );
      const orders_started_at = log_entries.findIndex(entry =>
        entry.event === "pipeline_started" && entry.pipeline_name === "toast_orders"
      );
      assert.ok(locations_completed_at >= 0);
      assert.ok(orders_started_at > locations_completed_at);
      assert.ok(state.visits.length > 0);
    });

    await context.test("Toast sync skips orders when the locations refresh fails", async () => {
      reset();
      state.fail_catalog_read = true;

      await assert.rejects(execute_toast_sync(signal), /Pipeline execution .* failed/);

      assert.equal(state.visits.length, 0);
      assert.equal(log_entries.some(entry =>
        entry.event === "pipeline_started" && entry.pipeline_name === "toast_orders"
      ), false);
    });

    await context.test("Toast sync rejects on orders failure without undoing locations", async () => {
      reset();
      state.fail_restaurant = state.restaurants[0] ?? null;

      await assert.rejects(execute_toast_sync(signal), /Pipeline execution .* failed/);

      assert.deepEqual(state.known_locations, state.restaurants);
      assert.ok(log_entries.some(entry =>
        entry.event === "pipeline_work_failed" && entry.pipeline_name === "toast_orders"
      ));
    });

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
    await context.test("configured ingestion uses weekly checkpoints when no window override is supplied", async () => {
      reset();
      context.mock.timers.setTime(Date.parse("2026-01-16T12:00:00.000Z"));
      await execute_ingestion({
        ...settings,
        ingestion_window_days : undefined,
        extract_window : async function* () {}
      });
      assert.deepEqual(state.checkpoints.map(date => date.toISOString()), [
        "2026-01-08T00:00:00.000Z",
        "2026-01-15T00:00:00.000Z",
        "2026-01-16T12:00:00.000Z"
      ]);
    });
    await context.test("default lookback rereads 24 hours and loads a late record", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      state.watermark = new Date("2026-01-03T00:00:00.000Z");
      const windows : Array<{start_at : Date; end_at : Date}> = [];
      await execute_ingestion({
        ...settings, ingestion_lookback_days : undefined,
        extract_window : async function* (window) {
          windows.push(window);
          if (windows.length === 1) {
            assert.equal(state.checkpoints.length, 0);
            yield [{source_record_id : "late-record", content : {}}];
          }
        }
      });
      assert.deepEqual(windows.map(window => [window.start_at.toISOString(), window.end_at.toISOString()]), [
        ["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
        ["2026-01-03T00:00:00.000Z", "2026-01-03T12:00:00.000Z"]
      ]);
      assert.deepEqual(state.loaded, ["late-record"]);
      assert.deepEqual(state.checkpoints.map(date => date.toISOString()), ["2026-01-03T12:00:00.000Z"]);
    });
    await context.test("fractional-day lookback and windows preserve hourly boundaries", async () => {
      reset();
      context.mock.timers.setTime(Date.parse("2026-01-03T06:30:00.000Z"));
      state.watermark = new Date("2026-01-03T06:00:00.000Z");
      const windows : Array<{start_at : Date; end_at : Date}> = [];
      await execute_ingestion({
        ...settings, ingestion_lookback_days : 1 / 24, ingestion_window_days : 1 / 24,
        extract_window : async function* (window) { windows.push(window); }
      });
      assert.deepEqual(windows.map(window => [window.start_at.toISOString(), window.end_at.toISOString()]), [
        ["2026-01-03T05:00:00.000Z", "2026-01-03T06:00:00.000Z"],
        ["2026-01-03T06:00:00.000Z", "2026-01-03T06:30:00.000Z"]
      ]);
      assert.deepEqual(state.checkpoints.map(date => date.toISOString()), ["2026-01-03T06:30:00.000Z"]);
    });
    await context.test("long lookback replays safely after failure without rolling back the watermark", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      const watermark = new Date("2026-01-03T00:00:00.000Z");
      state.watermark = watermark;
      const starts : string[] = [];
      await assert.rejects(execute_ingestion({
        ...settings, ingestion_lookback_days : 3,
        extract_window : async function* (window) {
          starts.push(window.start_at.toISOString());
          if (starts.length === 2) throw new Error("Synthetic replay failure.");
          yield [{source_record_id : "replayed-record", content : {}}];
        }
      }));
      assert.equal(state.watermark, watermark);
      assert.equal(state.checkpoints.length, 0);
      starts.length = 0;
      await execute_ingestion({
        ...settings, ingestion_lookback_days : 3,
        extract_window : async function* (window) {
          starts.push(window.start_at.toISOString());
          if (window.end_at.getTime() <= watermark.getTime()) {
            assert.equal(state.watermark, watermark);
            assert.equal(state.checkpoints.length, 0);
          }
        }
      });
      assert.deepEqual(starts, [
        "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"
      ]);
      assert.deepEqual(state.checkpoints.map(date => date.toISOString()), ["2026-01-03T12:00:00.000Z"]);
    });
    await context.test("invalid lookbacks and future watermarks fail before extraction", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      for (const days of [-1, NaN, Infinity, 1e-12]) {
        await assert.rejects(execute_ingestion({
          ...settings, ingestion_lookback_days : days,
          extract_window : async function* () { assert.fail("Invalid lookback reached extraction."); }
        }), /ingestion_lookback_days/);
        assert.equal(state.watermark, null);
      }
      state.watermark = new Date("2026-01-04T00:00:00.000Z");
      await assert.rejects(execute_ingestion({
        ...settings, ingestion_lookback_days : 2,
        extract_window : async function* () { assert.fail("Future watermark reached extraction."); }
      }));
      assert.deepEqual(state.checkpoints, []);
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
    await context.test("logs checkpoint failures without reporting a completed window", async () => {
      reset();
      state.fail_checkpoint = true;
      await assert.rejects(execute_ingestion({
        ...settings,
        extract_window : async function* () {
          yield [{source_record_id : "record", content : {}}];
        }
      }));
      assert.deepEqual(log_entries.map(entry => entry.event), [
        "pipeline_started", "ingestion_range_selected", "ingestion_window_started",
        "ingestion_window_checkpoint_failed", "pipeline_work_failed"
      ]);
      assert.equal(log_entries[3]?.window_end_at, "2026-01-02T00:00:00.000Z");
      assert.equal(log_entries[3]?.execution_id, "synthetic-execution");
    });
    await context.test("logs range settings, replay counts and the saved checkpoint under one execution", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      state.watermark = new Date("2026-01-03T00:00:00.000Z");
      await execute_ingestion({
        ...settings, ingestion_lookback_days : 1,
        extract_window : async function* () {
          yield [{source_record_id : "record", content : {}}];
        }
      });
      const range_log = log_entries.find(entry => entry.event === "ingestion_range_selected");
      assert.equal(range_log?.range_start_at, "2026-01-02T00:00:00.000Z");
      assert.equal(range_log?.range_end_at, fixed_now.toISOString());
      assert.equal(range_log?.ingestion_lookback_days, 1);
      assert.equal(range_log?.ingestion_window_days, 1);
      const replay_log = log_entries.find(entry => entry.event === "ingestion_window_completed");
      assert.equal(replay_log?.window_end_at, "2026-01-03T00:00:00.000Z");
      assert.equal(replay_log?.checkpoint_advanced, false);
      const checkpoint_log = log_entries.find(entry => entry.event === "ingestion_window_checkpointed");
      assert.equal(checkpoint_log?.window_end_at, state.checkpoints[0]?.toISOString());
      assert.equal(checkpoint_log?.checkpoint_advanced, true);
      assert.equal(checkpoint_log?.records_read, 1);
      assert.equal(checkpoint_log?.records_changed, 1);
      assert.equal(log_entries.at(-1)?.event, "pipeline_completed");
      assert.ok(log_entries.every(entry => entry.execution_id === "synthetic-execution"));
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
    await context.test("warns for new catalog identities but not repeat refreshes or name changes", async () => {
      reset();
      const known_guid = "11111111-1111-4111-8111-111111111111";
      const new_guid = "22222222-2222-4222-8222-222222222222";
      state.restaurants = [known_guid];
      await ingest_toast_locations(signal);
      assert.equal(get_location_warnings().length, 1);
      assert.equal(get_location_warnings()[0]?.location_guid, known_guid);
      log_entries.length = 0;
      state.restaurants = [known_guid, new_guid];
      await ingest_toast_locations(signal);
      const [warning] = get_location_warnings();
      assert.equal(get_location_warnings().length, 1);
      assert.equal(warning?.location_guid, new_guid);
      assert.equal(warning?.execution_id, "synthetic-execution");
      assert.equal(warning?.pipeline_name, "toast_locations");
      assert.equal(warning?.level, "warn");
      assert.match(String(warning?.message), /historical replay/);
      log_entries.length = 0;
      state.location_name = "Renamed location";
      await ingest_toast_locations(signal);
      assert.equal(get_location_warnings().length, 0);
    });
    await context.test("failed catalog reads fail ingestion rather than treating every location as new", async () => {
      reset();
      state.restaurants = ["11111111-1111-4111-8111-111111111111"];
      state.fail_catalog_read = true;
      await assert.rejects(ingest_toast_locations(signal));
      assert.equal(get_location_warnings().length, 0);
      assert.equal(state.batches.length, 0);
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
        ...settings, source_configuration : {data_start_date : new Date("invalid"), window_size_in_days : 1},
        extract_window : async function* () { assert.fail("Invalid date reached extraction."); }
      }));
      assert.equal(state.watermark, null);
    });
    await context.test("Toast window duration follows its source configuration", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      state.restaurants = ["11111111-1111-4111-8111-111111111111"];
      const original_window = toast_configuration.window_size_in_days;
      toast_configuration.window_size_in_days = 2;
      try {
        await ingest_toast_orders(signal);
        assert.deepEqual(state.visits.map(visit => [
          visit.start_at.toISOString(), visit.end_at.toISOString()
        ]), [
          ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
          ["2026-01-03T00:00:00.000Z", "2026-01-03T12:00:00.000Z"]
        ]);
      } finally {
        toast_configuration.window_size_in_days = original_window;
      }
    });
    await context.test("Toast orders can override the default lookback", async () => {
      reset();
      context.mock.timers.setTime(fixed_now.getTime());
      state.restaurants = ["11111111-1111-4111-8111-111111111111"];
      state.watermark = new Date("2026-01-03T00:00:00.000Z");
      toast_configuration.orders_ingestion_lookback_days = 2;
      try {
        await ingest_toast_orders(signal);
        assert.equal(state.visits[0]?.start_at.toISOString(), "2026-01-01T00:00:00.000Z");
        assert.equal(state.watermark?.toISOString(), "2026-01-03T12:00:00.000Z");
      } finally {
        delete toast_configuration.orders_ingestion_lookback_days;
      }
    });
    await context.test("Toast splits a lookback longer than 28 days into bounded windows", async () => {
      reset();
      context.mock.timers.setTime(Date.parse("2026-03-05T12:00:00.000Z"));
      state.restaurants = ["11111111-1111-4111-8111-111111111111"];
      state.watermark = new Date("2026-03-01T00:00:00.000Z");
      toast_configuration.orders_ingestion_lookback_days = 60;
      try {
        await ingest_toast_orders(signal);
        assert.deepEqual(state.visits.map(visit => [
          visit.start_at.toISOString(), visit.end_at.toISOString()
        ]), [
          ["2025-12-31T00:00:00.000Z", "2026-01-28T00:00:00.000Z"],
          ["2026-01-28T00:00:00.000Z", "2026-02-25T00:00:00.000Z"],
          ["2026-02-25T00:00:00.000Z", "2026-03-05T12:00:00.000Z"]
        ]);
        assert.deepEqual(state.checkpoints.map(date => date.toISOString()), ["2026-03-05T12:00:00.000Z"]);
      } finally {
        delete toast_configuration.orders_ingestion_lookback_days;
      }
    });
    await context.test("Toast uses consecutive 28-day windows and resumes after a later restaurant fails", async () => {
      reset();
      state.restaurants = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      ];
      context.mock.timers.setTime(Date.parse("2026-03-05T12:00:00.000Z"));
      state.fail_restaurant = state.restaurants[1] ?? null;
      state.fail_start_at = "2026-01-29T00:00:00.000Z";
      await assert.rejects(ingest_toast_orders(signal));
      assert.deepEqual(
        state.checkpoints.map(date => date.toISOString()),
        ["2026-01-29T00:00:00.000Z"]
      );
      assert.deepEqual(state.visits.map(visit => [
        visit.start_at.toISOString(), visit.end_at.toISOString()
      ]), [
        ["2026-01-01T00:00:00.000Z", "2026-01-29T00:00:00.000Z"],
        ["2026-01-01T00:00:00.000Z", "2026-01-29T00:00:00.000Z"],
        ["2026-01-29T00:00:00.000Z", "2026-02-26T00:00:00.000Z"],
        ["2026-01-29T00:00:00.000Z", "2026-02-26T00:00:00.000Z"]
      ]);
      state.visits = [];
      state.fail_restaurant = null;
      await ingest_toast_orders(signal);
      assert.deepEqual(state.visits.map(visit => [
        visit.start_at.toISOString(), visit.end_at.toISOString()
      ]), [
        ["2026-01-28T00:00:00.000Z", "2026-02-25T00:00:00.000Z"],
        ["2026-01-28T00:00:00.000Z", "2026-02-25T00:00:00.000Z"],
        ["2026-02-25T00:00:00.000Z", "2026-03-05T12:00:00.000Z"],
        ["2026-02-25T00:00:00.000Z", "2026-03-05T12:00:00.000Z"]
      ]);
      assert.deepEqual(state.checkpoints.map(date => date.toISOString()), [
        "2026-01-29T00:00:00.000Z", "2026-02-25T00:00:00.000Z",
        "2026-03-05T12:00:00.000Z"
      ]);
    });
    await context.test("location snapshots preserve payloads in bounded batches without changing coverage", async () => {
      reset();
      state.restaurants = Array.from({length : 101}, (_, index) =>
        `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`
      );
      const watermark = new Date("2026-01-03T00:00:00.000Z");
      state.watermark = watermark;
      await ingest_toast_locations(signal);
      assert.equal(state.discoveries, 1);
      assert.deepEqual(state.batches.map(batch => batch.length), [100, 1]);
      assert.deepEqual(state.batches[0]?.[0], {
        source_record_id : state.restaurants[0],
        content : {restaurantGuid : state.restaurants[0], locationName : "Synthetic location"}
      });
      assert.equal(state.watermark, watermark);
      assert.equal(state.checkpoints.length, 0);
    });
    await context.test("invalid location snapshots fail before any Raw writes", async () => {
      const guid = "11111111-1111-4111-8111-111111111111";
      for (const locations of [[], [guid, guid], ["not-a-guid"]]) {
        reset();
        state.restaurants = locations;
        await assert.rejects(ingest_toast_locations(signal));
        assert.equal(state.batches.length, 0);
      }
    });
    await context.test("location load failures and pre-aborted refreshes fail explicitly", async () => {
      reset();
      state.restaurants = ["11111111-1111-4111-8111-111111111111"];
      state.fail_load = true;
      await assert.rejects(ingest_toast_locations(signal));
      assert.equal(state.batches.length, 0);
      assert.equal(get_location_warnings().length, 1);
      log_entries.length = 0;
      state.fail_load = false;
      await ingest_toast_locations(signal);
      assert.equal(get_location_warnings().length, 1);
      const discoveries_before = state.discoveries;
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(ingest_toast_locations(controller.signal), {name : "AbortError"});
      assert.equal(state.discoveries, discoveries_before);
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
