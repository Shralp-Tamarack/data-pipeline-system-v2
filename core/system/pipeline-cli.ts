import {env_vars} from "./system-configuration.ts";
import {warehouse_pool} from "./pgsql-warehouse.ts";
import {ingestion_pipelines, processing_pipelines} from "./pipeline-registry.ts";
import {Toast_Request_Error} from "../toast/toast-request.ts";
import {execute_toast_sync} from "../toast/toast-sync.ts";

const [command, target, ...extra_arguments] = process.argv.slice(2);
const pipelines = command === "ingest"
  ? ingestion_pipelines
  : command === "process"
    ? processing_pipelines
    : undefined;

const execute_selected_pipeline = target ? pipelines?.get(target) : undefined;
const is_toast_sync = command === "sync" && target === "toast";
const controller = new AbortController();

function stop_execution(): void {
  console.log("Stopping after in-flight work settles...");
  controller.abort();
}

process.on("SIGINT", stop_execution);
process.on("SIGTERM", stop_execution);

try {
  if (extra_arguments.length > 0 || (!execute_selected_pipeline && !is_toast_sync)) {
    console.error("Usage: npm run ingest -- <pipeline-name>");
    console.error(`Available pipelines: ${[...ingestion_pipelines.keys()].join(", ")}`);
    console.error("Usage: npm run process -- <pipeline-name>");
    console.error(`Available processing pipelines: ${[...processing_pipelines.keys()].join(", ")}`);
    console.error("Usage: npm run sync -- toast");
    process.exitCode = 1;
  } else if (env_vars.system_environment !== "experimental") {
    console.error("This command currently requires the experimental environment.");
    process.exitCode = 1;
  } else if (execute_selected_pipeline) {
    const operation_name = command === "ingest" ? "Ingestion" : "Processing";
    console.log(`Starting ${command}: ${target}.`);
    const {execution_id, status} = await execute_selected_pipeline(controller.signal);
    if (status === "succeeded") {
      console.log(`${operation_name} completed. Execution: ${execution_id}`);
    } else {
      console.error(`${operation_name} ended ${status}. Execution: ${execution_id}`);
      process.exitCode = 1;
    }
  } else {
    console.log("Starting Toast sync: locations, then orders.");
    await execute_toast_sync(controller.signal);
    console.log("Toast sync completed.");
  }
} catch (error) {
  console.error(
    "Execution did not complete. Check pipeline logs and execution history. Previously committed data remains saved."
  );
  if (error instanceof Error && error.cause instanceof Toast_Request_Error) {
    console.error(`${error.message} ${error.cause.message}`);
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop_execution);
  process.off("SIGTERM", stop_execution);

  try {
    await warehouse_pool.end();
  } catch {
    console.error("Could not close the warehouse connection pool.");
    process.exitCode = 1;
  }
}