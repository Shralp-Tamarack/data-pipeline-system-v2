import assert from "node:assert/strict";
import {copyFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Orchestrator_Module = typeof import("../core/system/pipeline-orchestrator.ts");
type History_Test_Module = {
  test_state : {
    starts : number;
    fail_start : boolean;
    fail_completion : boolean;
  };
};

type Test_Log_Entry = {
  event : string;
  level : string;
  pipeline_name : string;
  operation : string;
  execution_id? : string;
  intended_status? : string;
};

test("per-pipeline overlap protection with synthetic history persistence", async context => {
  const test_directory = mkdtempSync(join(tmpdir(), "pipeline-orchestrator-test-"));

  try {
    writeFileSync(join(test_directory, "package.json"), '{"type":"module"}');
    copyFileSync(
      resolve(import.meta.dirname, "..", "core", "system", "pipeline-orchestrator.ts"),
      join(test_directory, "pipeline-orchestrator.ts")
    );
    writeFileSync(join(test_directory, "pipeline-history.ts"), `
export const test_state = {starts : 0, fail_start : false, fail_completion : false};
export async function record_pipeline_execution_start(): Promise<string> {
  test_state.starts++;
  if (test_state.fail_start) throw new Error("Synthetic history-start failure.");
  return String(test_state.starts);
}
export async function record_pipeline_execution_completion(): Promise<void> {
  if (test_state.fail_completion) throw new Error("Synthetic history-completion failure.");
}
`);
    writeFileSync(join(test_directory, "system-logger.ts"), `
export const log_entries = [];

function create_logger(bindings) {
  return {
    child : fields => create_logger({...bindings, ...fields}),
    info : fields => log_entries.push({...bindings, ...fields, level : "info"}),
    warn : fields => log_entries.push({...bindings, ...fields, level : "warn"}),
    error : fields => log_entries.push({...bindings, ...fields, level : "error"})
  };
}

export const system_logger = create_logger({});
`);

    const {execute_pipeline} : Orchestrator_Module =
      await import(pathToFileURL(join(test_directory, "pipeline-orchestrator.ts")).href);
    const {test_state} : History_Test_Module =
      await import(pathToFileURL(join(test_directory, "pipeline-history.ts")).href);
    const {log_entries} : {log_entries : Test_Log_Entry[]} =
      await import(pathToFileURL(join(test_directory, "system-logger.ts")).href);

    await context.test("returns the recorded status with the execution ID", async () => {
      for (const status of ["succeeded", "partial", "cancelled"] as const) {
        const result = await execute_pipeline("status-check", "ingestion", async () => ({status : status}));
        assert.deepEqual(result, {execution_id : String(test_state.starts), status : status});
      }
    });

    await context.test("rejects duplicates before history registration while allowing independent pipelines", async () => {
      const starts_before = test_state.starts;
      let release_work : (() => void) | undefined;
      let duplicate_work_called = false;
      const held_work = new Promise<void>(resolve_work => {
        release_work = resolve_work;
      });
      const first_execution = execute_pipeline("first", "held", async () => {
        await held_work;
        return {status : "succeeded"};
      });

      try {
        await assert.rejects(
          execute_pipeline("first", "duplicate", async () => {
            duplicate_work_called = true;
            return {status : "succeeded"};
          }),
          /already running in this process/
        );
        assert.equal(test_state.starts, starts_before + 1);
        assert.equal(duplicate_work_called, false);
        await execute_pipeline("second", "independent", async () => ({status : "succeeded"}));
      } finally {
        assert.ok(release_work);
        release_work();
        await first_execution;
      }

      await execute_pipeline("first", "restart", async () => ({status : "succeeded"}));
      assert.equal(test_state.starts, starts_before + 3);
    });

    await context.test("releases the guard after work fails", async () => {
      await assert.rejects(
        execute_pipeline("work-failure", "failure", async () => {
          throw new Error("Synthetic work failure.");
        }),
        /Pipeline execution .* failed/
      );
      await execute_pipeline("work-failure", "restart", async () => ({status : "succeeded"}));
    });

    await context.test("releases the guard when history registration fails", async () => {
      const log_start = log_entries.length;
      test_state.fail_start = true;
      try {
        await assert.rejects(
          execute_pipeline("start-failure", "failure", async () => ({status : "succeeded"})),
          /history-start failure/
        );
      } finally {
        test_state.fail_start = false;
      }
      assert.deepEqual(log_entries.slice(log_start), [{
        event : "pipeline_history_start_failed",
        level : "error",
        pipeline_name : "start-failure",
        operation : "failure"
      }]);
      await execute_pipeline("start-failure", "restart", async () => ({status : "succeeded"}));
    });

    await context.test("releases the guard when successful completion cannot be persisted", async () => {
      const log_start = log_entries.length;
      test_state.fail_completion = true;
      try {
        await assert.rejects(
          execute_pipeline("completion-failure", "failure", async () => ({status : "succeeded"})),
          /history-completion failure/
        );
      } finally {
        test_state.fail_completion = false;
      }
      const attempt_logs = log_entries.slice(log_start);
      assert.deepEqual(attempt_logs.map(entry => entry.event), [
        "pipeline_started", "pipeline_history_completion_failed"
      ]);
      const failure_log = attempt_logs[1];
      assert.equal(failure_log?.level, "error");
      assert.equal(failure_log?.intended_status, "succeeded");
      assert.equal(failure_log?.pipeline_name, "completion-failure");
      assert.equal(failure_log?.operation, "failure");
      assert.equal(failure_log?.execution_id, String(test_state.starts));
      await execute_pipeline("completion-failure", "restart", async () => ({status : "succeeded"}));
    });

    await context.test("releases the guard when failed completion cannot be persisted", async () => {
      const log_start = log_entries.length;
      test_state.fail_completion = true;
      try {
        await assert.rejects(
          execute_pipeline("failed-completion", "failure", async () => {
            throw new Error("Synthetic work failure.");
          }),
          /history-completion failure/
        );
      } finally {
        test_state.fail_completion = false;
      }
      const attempt_logs = log_entries.slice(log_start);
      assert.deepEqual(attempt_logs.map(entry => entry.event), [
        "pipeline_started", "pipeline_work_failed", "pipeline_history_completion_failed"
      ]);
      assert.equal(attempt_logs[2]?.intended_status, "failed");
      await execute_pipeline("failed-completion", "restart", async () => ({status : "succeeded"}));
    });
  } finally {
    rmSync(test_directory, {recursive : true, force : true});
  }
});
