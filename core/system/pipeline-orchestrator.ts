import {
  record_pipeline_execution_start,
  record_pipeline_execution_completion
} from "./pipeline-history.ts";
import type {Logger} from "pino";
import { system_logger } from "./system-logger.ts";
import type {Pipeline_Execution_Result} from "./pipeline-types.ts";

type Pipeline_Work_Outcome = {
  status : Pipeline_Execution_Result["status"];
  error_summary? : string;
};

const active_pipelines = new Set<string>();

/** Returns the execution ID and saved outcome; rejects on work or history failures. */
export async function execute_pipeline(
  pipeline_name : string,
  operation : string,
  perform_pipeline_work : (
    execution_id : string,
    pipeline_logger : Logger
  ) => Promise<Pipeline_Work_Outcome>
): Promise<Pipeline_Execution_Result> {
  if (active_pipelines.has(pipeline_name)) {
    throw new Error("This pipeline is already running in this process.");
  }

  active_pipelines.add(pipeline_name);

  try {
    let execution_id : string;

    try {
      execution_id = await record_pipeline_execution_start(
        pipeline_name,
        operation
      );
    } catch (error) {
      system_logger.error({
        event : "pipeline_history_start_failed",
        pipeline_name : pipeline_name,
        operation : operation
      }, "Could not register pipeline execution; work was not started");

      throw error;
    }

    const pipeline_logger = system_logger.child({
      pipeline_name : pipeline_name,
      execution_id : execution_id,
      operation : operation
    });

    const started_at = performance.now();

    pipeline_logger.info({
      event : "pipeline_started"
    }, "Pipeline execution started");

    let outcome : Pipeline_Work_Outcome;

    try {
      outcome = await perform_pipeline_work(execution_id, pipeline_logger);
    } catch (error) {

      pipeline_logger.error({
        event : "pipeline_work_failed",
        duration_ms : Math.round(performance.now() - started_at)
      }, "Pipeline work failed; previously committed data remains saved");

      try {
        await record_pipeline_execution_completion(execution_id, {
          status : "failed",
          error_summary : "Pipeline work threw an error."
        });
      } catch (history_error) {
        pipeline_logger.error({
          event : "pipeline_history_completion_failed",
          intended_status : "failed"
        }, "Pipeline work failed and its failed status could not be saved");

        throw history_error;
      }

      throw new Error(`Pipeline execution ${execution_id} failed.`, {cause : error});
    }

    try {
      await record_pipeline_execution_completion(execution_id, outcome);
    } catch (history_error) {
      pipeline_logger.error({
        event : "pipeline_history_completion_failed",
        intended_status : outcome.status,
        duration_ms : Math.round(performance.now() - started_at)
      }, "Pipeline work returned an outcome, but execution history could not be finalized");

      throw history_error;
    }

    const completion_details = {
      event : "pipeline_completed",
      status : outcome.status,
      duration_ms : Math.round(performance.now() - started_at)
    };

    if (outcome.status === "succeeded") {
      pipeline_logger.info(completion_details, "Pipeline execution completed");
    } else {
      pipeline_logger.warn(completion_details, "Pipeline execution ended without full success");
    }

    return {execution_id : execution_id, status : outcome.status};
  } finally {
    active_pipelines.delete(pipeline_name);
  }
}