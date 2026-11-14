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

    const {execute_pipeline} : Orchestrator_Module =
      await import(pathToFileURL(join(test_directory, "pipeline-orchestrator.ts")).href);
    const {test_state} : History_Test_Module =
      await import(pathToFileURL(join(test_directory, "pipeline-history.ts")).href);

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
      test_state.fail_start = true;
      try {
        await assert.rejects(
          execute_pipeline("start-failure", "failure", async () => ({status : "succeeded"})),
          /history-start failure/
        );
      } finally {
        test_state.fail_start = false;
      }
      await execute_pipeline("start-failure", "restart", async () => ({status : "succeeded"}));
    });

    await context.test("releases the guard when successful completion cannot be persisted", async () => {
      test_state.fail_completion = true;
      try {
        await assert.rejects(
          execute_pipeline("completion-failure", "failure", async () => ({status : "succeeded"})),
          /history-completion failure/
        );
      } finally {
        test_state.fail_completion = false;
      }
      await execute_pipeline("completion-failure", "restart", async () => ({status : "succeeded"}));
    });

    await context.test("releases the guard when failed completion cannot be persisted", async () => {
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
      await execute_pipeline("failed-completion", "restart", async () => ({status : "succeeded"}));
    });
  } finally {
    rmSync(test_directory, {recursive : true, force : true});
  }
});
