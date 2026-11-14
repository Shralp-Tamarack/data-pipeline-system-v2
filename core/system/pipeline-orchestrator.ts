import {
  record_pipeline_execution_start,
  record_pipeline_execution_completion
} from "./pipeline-history.ts";

type Pipeline_Work_Outcome = {
  status : "succeeded" | "partial" | "cancelled";
  error_summary? : string;
};

const active_pipelines = new Set<string>();

/** Records execution outcomes and prevents same-pipeline overlap within this process. */
export async function execute_pipeline(
  pipeline_name : string,
  operation : string,
  perform_pipeline_work : (
    execution_id : string
  ) => Promise<Pipeline_Work_Outcome>
): Promise<string> {
  if (active_pipelines.has(pipeline_name)) {
    throw new Error("This pipeline is already running in this process.");
  }

  active_pipelines.add(pipeline_name);

  try {
    const execution_id = await record_pipeline_execution_start(
      pipeline_name,
      operation
    );

    let outcome : Pipeline_Work_Outcome;

    try {
      outcome = await perform_pipeline_work(execution_id);
    } catch {
      await record_pipeline_execution_completion(execution_id, {
        status : "failed",
        error_summary : "Pipeline work threw an error."
      });

      throw new Error(`Pipeline execution ${execution_id} failed.`);
    }

    await record_pipeline_execution_completion(execution_id, outcome);

    return execution_id;
  } finally {
    active_pipelines.delete(pipeline_name);
  }
}