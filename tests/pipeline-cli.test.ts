import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {execute_pipeline_workflow} from "../core/system/pipeline-workflow.ts";
import type {Pipeline_Stage_Handlers} from "../core/system/pipeline-workflow.ts";

test("pipeline CLI routing with synthetic pipelines and no warehouse access", async context => {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-cli-test-"));
  const system_directory = join(directory, "core", "system");
  const toast_directory = join(directory, "core", "toast");

  try {
    mkdirSync(system_directory, {recursive : true});
    mkdirSync(toast_directory, {recursive : true});
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    for (const filename of ["pipeline-cli.ts", "pipeline-registry.ts", "pipeline-workflow.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "system", filename), join(system_directory, filename));
    }
    writeFileSync(join(system_directory, "system-configuration.ts"), `
export const env_vars = {system_environment : process.env.test_environment};
`);
    writeFileSync(join(system_directory, "pgsql-warehouse.ts"), `
export const warehouse_pool = {async end() {console.log("POOL_CLOSED");}};
`);
    writeFileSync(join(toast_directory, "test-stage.ts"), `
export async function execute_stage(signal, stage) {
  signal.throwIfAborted();
  console.log("CALLED_" + stage);
  if (process.env.test_outcome === "failed") throw new Error("Synthetic failure.");
  return {execution_id : "synthetic-execution", status : process.env.test_outcome};
}
`);
    writeFileSync(join(toast_directory, "toast-locations.ts"), `
import {execute_stage} from "./test-stage.ts";
export const ingest_toast_locations = signal => execute_stage(signal, "INGEST_LOCATIONS");
export const process_toast_locations = signal => execute_stage(signal, "PROCESS_LOCATIONS");
`);
    writeFileSync(join(toast_directory, "toast-orders.ts"), `
import {execute_stage} from "./test-stage.ts";
export const ingest_toast_orders = signal => execute_stage(signal, "INGEST_ORDERS");
export const process_toast_orders = signal => execute_stage(signal, "PROCESS_ORDERS");
`);
    writeFileSync(join(toast_directory, "toast-request.ts"), `
export class Toast_Request_Error extends Error {}
`);

    function execute_cli(
      arguments_list : string[],
      outcome : string = "succeeded",
      environment : string = "experimental"
    ) {
      const result = spawnSync(process.execPath, [
        join(system_directory, "pipeline-cli.ts"), ...arguments_list
      ], {
        encoding : "utf8",
        timeout : 10_000,
        env : {...process.env, test_environment : environment, test_outcome : outcome}
      });
      assert.ifError(result.error);
      assert.match(result.stdout, /POOL_CLOSED/);
      return result;
    }

    await context.test("runs individual stages and source workflows in dependency order", () => {
      for (const [command, target, handlers] of [
        ["process", "toast-locations", ["CALLED_PROCESS_LOCATIONS"]],
        ["ingest", "toast-orders", ["CALLED_INGEST_ORDERS"]],
        ["ingest", "toast", ["CALLED_INGEST_LOCATIONS", "CALLED_INGEST_ORDERS"]],
        ["process", "toast", ["CALLED_PROCESS_LOCATIONS", "CALLED_PROCESS_ORDERS"]],
        ["sync", "toast", [
          "CALLED_INGEST_LOCATIONS", "CALLED_PROCESS_LOCATIONS", "CALLED_INGEST_ORDERS", "CALLED_PROCESS_ORDERS"
        ]]
      ] as const) {
        const result = execute_cli([command, target]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.match(/CALLED_\w+/g), handlers);
      }
    });

    await context.test("rejects unsupported reconciliation before starting any stage", () => {
      for (const [command, target, message] of [
        ["reconcile", "toast", /reconcile is not supported for toast/],
        ["reconcile", "toast-locations", /reconcile is not supported for toast-locations/]
      ] as const) {
        const result = execute_cli([command, target]);
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout, /CALLED_|Completed/);
        assert.match(result.stderr, message);
      }
    });

    await context.test("fails on incomplete processing without claiming success", () => {
      for (const outcome of ["partial", "cancelled", "failed"]) {
        const result = execute_cli(["process", "toast-locations"], outcome);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /CALLED_PROCESS/);
        assert.doesNotMatch(result.stdout, /Completed process/);
        assert.match(result.stderr, outcome === "failed" ? /Execution did not complete/ : new RegExp(outcome));
      }
    });

    await context.test("rejects invalid arguments and operational targets before executing work", () => {
      for (const arguments_list of [
        ["process"], ["process", "unknown"], ["process", "toast-locations", "extra"], ["unknown", "toast"]
      ]) {
        const result = execute_cli(arguments_list);
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout, /CALLED_/);
        assert.match(result.stderr, /Usage: npm run <ingest\|reconcile\|process\|sync>/);
      }
      const result = execute_cli(["process", "toast-locations"], "succeeded", "operational");
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /CALLED_/);
      assert.match(result.stderr, /requires the experimental environment/);
    });

    await context.test("full source sync waits for each pipeline including configured reconciliation and stops on failure", async () => {
      const stages : string[] = [];
      let reconcile_status : "partial" | "succeeded" = "partial";
      const pipelines = new Map<string, Pipeline_Stage_Handlers>([
        ["catalog", {
          ingest : async () => {
            stages.push("catalog ingest");
            return {execution_id : "catalog-ingest", status : "succeeded"};
          },
          reconcile : async () => {
            stages.push("catalog reconcile");
            return {execution_id : "catalog-reconcile", status : reconcile_status};
          },
          process : async () => {
            stages.push("catalog process");
            return {execution_id : "catalog-process", status : "succeeded"};
          }
        }],
        ["orders", {
          ingest : async () => {
            stages.push("orders ingest");
            return {execution_id : "orders-ingest", status : "succeeded"};
          },
          process : async () => {
            stages.push("orders process");
            return {execution_id : "orders-process", status : "succeeded"};
          }
        }]
      ]);
      const signal = new AbortController().signal;
      await assert.rejects(execute_pipeline_workflow("sync", "source", pipelines, signal), /reconcile ended partial/);
      assert.deepEqual(stages, ["catalog ingest", "catalog reconcile"]);
      stages.length = 0;
      reconcile_status = "succeeded";
      const execution = execute_pipeline_workflow("sync", "source", pipelines, signal);
      const orders = pipelines.get("orders");
      assert.ok(orders);
      await assert.rejects(execute_pipeline_workflow("ingest", "orders", new Map([["orders", orders]]), signal),
        /orders already has an active workflow/);
      await execution;
      assert.deepEqual(stages, ["catalog ingest", "catalog reconcile", "catalog process", "orders ingest", "orders process"]);
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
