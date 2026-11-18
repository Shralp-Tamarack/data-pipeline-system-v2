import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";

test("pipeline CLI routing with synthetic pipelines and no warehouse access", async context => {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-cli-test-"));
  const system_directory = join(directory, "core", "system");
  const toast_directory = join(directory, "core", "toast");

  try {
    mkdirSync(system_directory, {recursive : true});
    mkdirSync(toast_directory, {recursive : true});
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    copyFileSync(
      resolve(import.meta.dirname, "..", "core", "system", "pipeline-cli.ts"),
      join(system_directory, "pipeline-cli.ts")
    );
    writeFileSync(join(system_directory, "system-configuration.ts"), `
export const env_vars = {system_environment : process.env.test_environment};
`);
    writeFileSync(join(system_directory, "pgsql-warehouse.ts"), `
export const warehouse_pool = {async end() {console.log("POOL_CLOSED");}};
`);
    writeFileSync(join(system_directory, "pipeline-registry.ts"), `
function create_pipeline(operation) {
  return async signal => {
    signal.throwIfAborted();
    console.log("CALLED_" + operation);
    if (process.env.test_outcome === "failed") throw new Error("Synthetic failure.");
    return {execution_id : "synthetic-execution", status : process.env.test_outcome};
  };
}
export const ingestion_pipelines = new Map([["toast-locations", create_pipeline("INGEST")]]);
export const processing_pipelines = new Map([["toast-locations", create_pipeline("PROCESS")]]);
`);
    writeFileSync(join(toast_directory, "toast-request.ts"), `
export class Toast_Request_Error extends Error {}
`);
    writeFileSync(join(toast_directory, "toast-sync.ts"), `
export async function execute_toast_sync() {console.log("CALLED_SYNC");}
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

    await context.test("routes processing, ingestion and sync to only the selected handler", () => {
      for (const [command, target, handler] of [
        ["process", "toast-locations", "PROCESS"],
        ["ingest", "toast-locations", "INGEST"],
        ["sync", "toast", "SYNC"]
      ] as const) {
        const result = execute_cli([command, target]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.match(/CALLED_\w+/g), [`CALLED_${handler}`]);
      }
    });

    await context.test("fails on incomplete processing without claiming success", () => {
      for (const outcome of ["partial", "cancelled", "failed"]) {
        const result = execute_cli(["process", "toast-locations"], outcome);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /CALLED_PROCESS/);
        assert.doesNotMatch(result.stdout, /Processing completed/);
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
        assert.match(result.stderr, /Usage: npm run process/);
      }
      const result = execute_cli(["process", "toast-locations"], "succeeded", "operational");
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /CALLED_/);
      assert.match(result.stderr, /requires the experimental environment/);
    });
  } finally {
    rmSync(directory, {recursive : true, force : true});
  }
});
