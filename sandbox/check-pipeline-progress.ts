import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_pool} from "../core/system/pgsql-warehouse.ts";
import {get_or_create_pipeline_progress} from "../core/system/pipeline-progress.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

try {
  const first_record = await get_or_create_pipeline_progress(
    "sandbox_progress_check"
  );

  const second_record = await get_or_create_pipeline_progress(
    "sandbox_progress_check"
  );

  if (first_record.id !== second_record.id) {
    throw new Error("Repeated registration returned different progress IDs.");
  }

  console.log("Pipeline progress registration check succeeded.");
} finally {
  await warehouse_pool.end();
}