import {warehouse_db} from "./pgsql-warehouse.ts";
import {Pipeline_Execution_History} from "./system-schema.ts";
import {get_or_create_pipeline_progress} from "./pipeline-progress.ts";
import {and, eq} from "drizzle-orm";

/** Records an execution attempt; does not advance pipeline progress. */
export async function record_pipeline_execution_start(
  pipeline_name : string,
  operation : string
): Promise<string> {
  if (!operation.trim()) {
    throw new Error("Pipeline operation is required.");
  }

  const progress_record = await get_or_create_pipeline_progress(
    pipeline_name
  );

  const [execution_record] = await warehouse_db
    .insert(Pipeline_Execution_History)
    .values({
      pipeline_progress_id : progress_record.id,
      operation : operation,
      ingestion_watermark_before : progress_record.ingestion_watermark
    })
    .returning({id : Pipeline_Execution_History.id});

  if (!execution_record) {
    throw new Error("Could not create pipeline execution history.");
  }

  return execution_record.id;
}

type Pipeline_Execution_Outcome = {
  status : "succeeded" | "partial" | "failed" | "cancelled";
  records_loaded? : number;
  records_processed? : number;
  ingestion_watermark_after? : Date | null;
  error_summary? : string;
};

/** Records completion; error summaries must be sanitized by the caller. */
export async function record_pipeline_execution_completion(
  execution_id : string,
  outcome : Pipeline_Execution_Outcome
): Promise<void> {
  const counts = [outcome.records_loaded, outcome.records_processed];

    if (counts.some(count =>
    count !== undefined &&
    (!Number.isSafeInteger(count) || count < 0)
    )) {
    throw new Error("Execution counts must be non-negative whole numbers.");
    }

  const [execution_record] = await warehouse_db
    .update(Pipeline_Execution_History)
    .set({
      status : outcome.status,
      records_loaded : outcome.records_loaded,
      records_processed : outcome.records_processed,
      ingestion_watermark_after : outcome.ingestion_watermark_after,
      error_summary : outcome.error_summary ?? null,
      finished_at : new Date()
    })
    .where(and(
      eq(Pipeline_Execution_History.id, execution_id),
      eq(Pipeline_Execution_History.status, "running")
    ))
    .returning({id : Pipeline_Execution_History.id});

  if (!execution_record) {
    throw new Error("Execution was not found or is already finished.");
  }
}