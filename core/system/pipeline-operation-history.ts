import {warehouse_db} from "./pgsql-warehouse.ts";
import {Pipeline_Operation_History, Pipeline_State} from "./system-schema.ts";
import {get_or_create_pipeline_state} from "./pipeline-state.ts";
import {and, eq, sql} from "drizzle-orm";

/** Records an execution attempt; does not advance pipeline state. */
export async function record_pipeline_execution_start(
  pipeline_name : string,
  operation : string
): Promise<string> {
  if (!operation.trim()) {
    throw new Error("Pipeline operation is required.");
  }

  const state_record = await get_or_create_pipeline_state(
    pipeline_name
  );

  const [execution_record] = await warehouse_db
    .insert(Pipeline_Operation_History)
    .values({
      pipeline_state_id : state_record.id,
      operation : operation,
      records_read : operation === "ingestion" ? 0 : null,
      ingestion_watermark_before : state_record.ingestion_watermark
    })
    .returning({id : Pipeline_Operation_History.id});

  if (!execution_record) {
    throw new Error("Could not create pipeline operation history.");
  }

  return execution_record.id;
}

/** Counts validated source records delivered to ingestion, independently of Raw write success. */
export async function record_ingestion_records_read(
  execution_id : string,
  record_count : number
): Promise<void> {
  if (!Number.isSafeInteger(record_count) || record_count < 0 || record_count > 2_147_483_647) {
    throw new Error("Read count must be a non-negative PostgreSQL integer.");
  }

  const [execution_record] = await warehouse_db
    .update(Pipeline_Operation_History)
    .set({
      records_read : sql`coalesce(${Pipeline_Operation_History.records_read}, 0) + ${record_count}`
    })
    .where(and(
      eq(Pipeline_Operation_History.id, execution_id),
      eq(Pipeline_Operation_History.status, "running")
    ))
    .returning({id : Pipeline_Operation_History.id});

  if (!execution_record) {
    throw new Error("Read counts require a running execution.");
  }
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

  await warehouse_db.transaction(async transaction => {
    const finished_at = new Date();
    const [execution_record] = await transaction
      .update(Pipeline_Operation_History)
      .set({
        status : outcome.status,
        records_loaded : outcome.records_loaded,
        records_processed : outcome.records_processed,
        ingestion_watermark_after : outcome.ingestion_watermark_after,
        error_summary : outcome.error_summary ?? null,
        finished_at : finished_at
      })
      .where(and(
        eq(Pipeline_Operation_History.id, execution_id),
        eq(Pipeline_Operation_History.status, "running")
      ))
      .returning({
        id : Pipeline_Operation_History.id,
        pipeline_state_id : Pipeline_Operation_History.pipeline_state_id,
        operation : Pipeline_Operation_History.operation
      });

    if (!execution_record) {
      throw new Error("Execution was not found or is already finished.");
    }

    if (outcome.status === "succeeded" && (
      execution_record.operation === "ingestion" || execution_record.operation === "processing"
    )) {
      const [state_record] = await transaction
        .update(Pipeline_State)
        .set({
          ...(execution_record.operation === "ingestion"
            ? {last_successful_ingestion_at : finished_at}
            : {last_successful_processing_at : finished_at}),
          updated_at : finished_at
        })
        .where(eq(Pipeline_State.id, execution_record.pipeline_state_id))
        .returning({id : Pipeline_State.id});

      if (!state_record) {
        throw new Error("Could not record successful operation in pipeline state.");
      }
    }
  });
}