import {env_vars} from "./system-configuration.ts";
import {warehouse_pool} from "./pgsql-warehouse.ts";
import {ingestion_pipelines} from "./pipeline-registry.ts";
import {Toast_Request_Error} from "../toast/toast-request.ts";
import {run_toast_sync} from "../toast/toast-sync.ts";

const [command, target, ...extra_arguments] = process.argv.slice(2);
const ingest_pipeline = command === "ingest" && target
  ? ingestion_pipelines.get(target)
  : undefined;
const is_toast_sync = command === "sync" && target === "toast";
const controller = new AbortController();

function stop_run(): void {
  console.log("Stopping after in-flight work settles...");
  controller.abort();
}

process.on("SIGINT", stop_run);
process.on("SIGTERM", stop_run);

try {
  if (extra_arguments.length > 0 || (!ingest_pipeline && !is_toast_sync)) {
    console.error("Usage: npm run ingest -- <pipeline-name>");
    console.error(`Available pipelines: ${[...ingestion_pipelines.keys()].join(", ")}`);
    console.error("Usage: npm run sync -- toast");
    process.exitCode = 1;
  } else if (env_vars.system_environment !== "experimental") {
    console.error("This command currently requires the experimental environment.");
    process.exitCode = 1;
  } else if (ingest_pipeline) {
    console.log(`Starting ingestion: ${target}.`);
    const {execution_id, status} = await ingest_pipeline(controller.signal);
    if (status === "succeeded") {
      console.log(`Ingestion completed. Execution: ${execution_id}`);
    } else {
      console.error(`Ingestion ended ${status}. Execution: ${execution_id}`);
      process.exitCode = 1;
    }
  } else {
    console.log("Starting Toast sync: locations, then orders.");
    await run_toast_sync(controller.signal);
    console.log("Toast sync completed.");
  }
} catch (error) {
  console.error(
    "Run did not complete. Check pipeline logs and execution history. Previously committed data remains saved."
  );
  if (error instanceof Error && error.cause instanceof Toast_Request_Error) {
    console.error(`${error.message} ${error.cause.message}`);
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop_run);
  process.off("SIGTERM", stop_run);

  try {
    await warehouse_pool.end();
  } catch {
    console.error("Could not close the warehouse connection pool.");
    process.exitCode = 1;
  }
}