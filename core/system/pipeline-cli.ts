import {env_vars} from "./system-configuration.ts";
import {warehouse_pool} from "./pgsql-warehouse.ts";
import {execute_pipeline_command, available_command_targets} from "./pipeline-registry.ts";
import {Pipeline_Command_Error} from "./pipeline-workflow.ts";
import {Toast_Request_Error} from "../toast/toast-request.ts";

const [command, target, ...extra_arguments] = process.argv.slice(2);
const abort_controller = new AbortController();

function request_cancellation(): void {
  console.log("Stopping after in-flight work settles...");
  abort_controller.abort();
}

process.on("SIGINT", request_cancellation);
process.on("SIGTERM", request_cancellation);

try {
  if (
    extra_arguments.length > 0 || !target || !available_command_targets.includes(target) ||
    (command !== "ingest" && command !== "reconcile" && command !== "process" && command !== "sync")
  ) {
    console.error("Usage: npm run <ingest|reconcile|process|sync> -- <pipeline-or-source>");
    console.error(`Targets: ${available_command_targets.join(", ")}`);
    process.exitCode = 1;
  } else if (env_vars.system_environment !== "experimental") {
    console.error("This command currently requires the experimental environment.");
    process.exitCode = 1;
  } else {
    await execute_pipeline_command(command, target, abort_controller.signal, (pipeline_name, stage, execution_id) => {
      console.log(`${pipeline_name} ${stage} completed. Execution: ${execution_id}`);
    });
    console.log(`Completed ${command}: ${target}.`);
  }
} catch (error) {
  if (error instanceof Pipeline_Command_Error) {
    console.error(error.message);
  } else {
    console.error(
      "Execution did not complete. Check pipeline logs and execution history. Previously committed data remains saved."
    );
    if (error instanceof Error && error.cause instanceof Toast_Request_Error) {
      console.error(`${error.message} ${error.cause.message}`);
    }
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", request_cancellation);
  process.off("SIGTERM", request_cancellation);

  try {
    await warehouse_pool.end();
  } catch {
    console.error("Could not close the warehouse connection pool.");
    process.exitCode = 1;
  }
}