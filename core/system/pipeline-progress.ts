import {and, eq, isNull} from "drizzle-orm";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {Pipeline_Execution_History, Pipeline_Progress} from "./system-schema.ts";

type Pipeline_Progress_Record = typeof Pipeline_Progress.$inferSelect;

/** Creates missing progress without resetting an existing pipeline's checkpoint. */
export async function get_or_create_pipeline_progress(
  pipeline_name : string
): Promise<Pipeline_Progress_Record> {
  if (!pipeline_name.trim()) {
    throw new Error("Pipeline name is required.");
  }

  await warehouse_db
    .insert(Pipeline_Progress)
    .values({pipeline_name : pipeline_name})
    .onConflictDoNothing({target : Pipeline_Progress.pipeline_name});

  const [progress_record] = await warehouse_db
    .select()
    .from(Pipeline_Progress)
    .where(eq(Pipeline_Progress.pipeline_name, pipeline_name))
    .limit(1);

  if (!progress_record) {
    throw new Error("Could not load pipeline progress.");
  }

  return progress_record;
}

/** Saves fully loaded window coverage and its history atomically; never call for partial scope. */
export async function record_ingestion_window_completion(
  pipeline_name : string,
  execution_id : string,
  previous_watermark : Date | null,
  end_at : Date
): Promise<void> {
  if (
    !Number.isFinite(end_at.getTime()) ||
    (previous_watermark !== null &&
      (!Number.isFinite(previous_watermark.getTime()) ||
        end_at.getTime() <= previous_watermark.getTime()))
  ) {
    throw new Error("Ingestion checkpoint must advance to a valid date.");
  }

  await warehouse_db.transaction(async transaction => {
    const [execution_record] = await transaction
      .select({pipeline_progress_id : Pipeline_Progress.id})
      .from(Pipeline_Execution_History)
      .innerJoin(
        Pipeline_Progress,
        eq(Pipeline_Execution_History.pipeline_progress_id, Pipeline_Progress.id)
      )
      .where(and(
        eq(Pipeline_Execution_History.id, execution_id),
        eq(Pipeline_Execution_History.status, "running"),
        eq(Pipeline_Progress.pipeline_name, pipeline_name)
      ))
      .for("update");

    if (!execution_record) {
      throw new Error("Checkpoint requires a running execution for this pipeline.");
    }

    const [progress_record] = await transaction
      .update(Pipeline_Progress)
      .set({
        ingestion_watermark : end_at,
        last_successful_ingestion_at : new Date(),
        updated_at : new Date()
      })
      .where(and(
        eq(Pipeline_Progress.id, execution_record.pipeline_progress_id),
        previous_watermark === null
          ? isNull(Pipeline_Progress.ingestion_watermark)
          : eq(Pipeline_Progress.ingestion_watermark, previous_watermark)
      ))
      .returning({id : Pipeline_Progress.id});

    if (!progress_record) {
      throw new Error("Pipeline watermark changed before window completion.");
    }

    await transaction
      .update(Pipeline_Execution_History)
      .set({ingestion_watermark_after : end_at})
      .where(eq(Pipeline_Execution_History.id, execution_id));
  });
}