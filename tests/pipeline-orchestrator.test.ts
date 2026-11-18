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
    completions : Array<{execution_id : string; status : string}>;
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
    copyFileSync(
      resolve(import.meta.dirname, "..", "core", "system", "processing-executer.ts"),
      join(test_directory, "processing-executer.ts")
    );
    writeFileSync(join(test_directory, "pipeline-history.ts"), `
export const test_state = {starts : 0, fail_start : false, fail_completion : false, completions : []};
export async function record_pipeline_execution_start(): Promise<string> {
  test_state.starts++;
  if (test_state.fail_start) throw new Error("Synthetic history-start failure.");
  return String(test_state.starts);
}
export async function record_pipeline_execution_completion(execution_id, outcome): Promise<void> {
  if (test_state.fail_completion) throw new Error("Synthetic history-completion failure.");
  test_state.completions.push({execution_id, status : outcome.status});
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
    const {execute_processing} : typeof import("../core/system/processing-executer.ts") =
      await import(pathToFileURL(join(test_directory, "processing-executer.ts")).href);
    const {test_state} : History_Test_Module =
      await import(pathToFileURL(join(test_directory, "pipeline-history.ts")).href);
    const {log_entries} : {log_entries : Test_Log_Entry[]} =
      await import(pathToFileURL(join(test_directory, "system-logger.ts")).href);

    await context.test("processing drains every batch under one execution and stops on empty", async () => {
      const log_start = log_entries.length;
      const counts = [100, 100, 50, 0];
      const execution_ids : string[] = [];
      const result = await execute_processing({
        pipeline_name : "processing-check",
        signal : new AbortController().signal,
        process_batch : async execution_id => {
          execution_ids.push(execution_id);
          const count = counts.shift();
          assert.ok(count !== undefined, "Executor called again after the empty batch.");
          return count;
        }
      });
      assert.equal(result.status, "succeeded");
      assert.deepEqual(execution_ids, Array(4).fill(result.execution_id));
      const events = log_entries.slice(log_start);
      assert.equal(events.filter(entry => entry.event === "processing_batch_completed").length, 3);
      assert.equal(events.at(-1)?.event, "pipeline_completed");
      assert.ok(events.every(entry => entry.operation === "processing"));
    });

    await context.test("processing fails without reporting completion when a batch throws or returns an invalid count", async () => {
      for (const invalid_count of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, undefined]) {
        const log_start = log_entries.length;
        await assert.rejects(execute_processing({
          pipeline_name : "processing-check",
          signal : new AbortController().signal,
          process_batch : async () => {
            if (invalid_count === undefined) throw new Error("Synthetic batch failure.");
            return invalid_count;
          },
          finalize_processing : async () => assert.fail("Failed batches must not finalize.")
        }), /Pipeline execution .* failed/);
        assert.equal(log_entries.slice(log_start).some(entry => entry.event === "pipeline_completed"), false);
      }
    });

    await context.test("finalizes exactly once after draining, including when no Raw work is pending", async () => {
      for (const counts of [[2, 1, 0], [0]]) {
        const order : string[] = [];
        const result = await execute_processing({
          pipeline_name : "finalization-check",
          signal : new AbortController().signal,
          process_batch : async () => {
            const count = counts.shift();
            assert.ok(count !== undefined);
            order.push(`batch-${count}`);
            return count;
          },
          finalize_processing : async pipeline_logger => {
            assert.equal(order.at(-1), "batch-0");
            assert.equal(test_state.completions.at(-1)?.execution_id === String(test_state.starts), false);
            order.push("finalize");
            pipeline_logger.info({event : "test_processing_finalized"}, "Finalized");
            await assert.rejects(execute_processing({
              pipeline_name : "finalization-check",
              signal : new AbortController().signal,
              process_batch : async () => assert.fail("Finalization must retain the overlap guard.")
            }), /already running in this process/);
          }
        });
        assert.equal(result.status, "succeeded");
        assert.equal(order.at(-1), "finalize");
        assert.equal(order.filter(step => step === "finalize").length, 1);
        assert.deepEqual(test_state.completions.at(-1), {
          execution_id : result.execution_id, status : "succeeded"
        });
        assert.equal(
          log_entries.find(entry => entry.event === "test_processing_finalized" &&
            entry.execution_id === result.execution_id)?.pipeline_name,
          "finalization-check"
        );
      }
    });

    await context.test("finalization failure or cancellation records failure and releases the guard", async () => {
      for (const failure of ["throw", "cancel"]) {
        const log_start = log_entries.length;
        const controller = new AbortController();
        await assert.rejects(execute_processing({
          pipeline_name : "finalization-failure",
          signal : controller.signal,
          process_batch : async () => 0,
          finalize_processing : async () => {
            if (failure === "throw") throw new Error("Synthetic finalization failure.");
            controller.abort();
          }
        }), /Pipeline execution .* failed/);
        assert.equal(test_state.completions.at(-1)?.status, "failed");
        assert.equal(log_entries.slice(log_start).some(entry => entry.event === "pipeline_completed"), false);
        await execute_processing({
          pipeline_name : "finalization-failure",
          signal : new AbortController().signal,
          process_batch : async () => 0
        });
      }
    });

    await context.test("processing cancellation prevents further batches, including before startup", async () => {
      const controller = new AbortController();
      let batches = 0;
      await assert.rejects(execute_processing({
        pipeline_name : "processing-check",
        signal : controller.signal,
        process_batch : async () => {
          batches++;
          controller.abort();
          return 100;
        },
        finalize_processing : async () => assert.fail("Cancelled processing must not finalize.")
      }));
      assert.equal(batches, 1);
      const starts_before = test_state.starts;
      await assert.rejects(execute_processing({
        pipeline_name : "processing-check",
        signal : controller.signal,
        process_batch : async () => assert.fail("Cancelled processing started a batch.")
      }));
      assert.equal(test_state.starts, starts_before);
    });

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
