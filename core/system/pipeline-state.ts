import {and, eq, isNull} from "drizzle-orm";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {Pipeline_Operation_History, Pipeline_State} from "./system-schema.ts";

type Pipeline_State_Record = typeof Pipeline_State.$inferSelect;

/** Creates missing state without resetting an existing pipeline's checkpoint. */
export async function get_or_create_pipeline_state(
  pipeline_name : string
): Promise<Pipeline_State_Record> {
  if (!pipeline_name.trim()) {
    throw new Error("Pipeline name is required.");
  }

  await warehouse_db
    .insert(Pipeline_State)
    .values({pipeline_name : pipeline_name})
    .onConflictDoNothing({target : Pipeline_State.pipeline_name});

  const [state_record] = await warehouse_db
    .select()
    .from(Pipeline_State)
    .where(eq(Pipeline_State.pipeline_name, pipeline_name))
    .limit(1);

  if (!state_record) {
    throw new Error("Could not load pipeline state.");
  }

  return state_record;
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
      .select({pipeline_state_id : Pipeline_State.id})
      .from(Pipeline_Operation_History)
      .innerJoin(
        Pipeline_State,
        eq(Pipeline_Operation_History.pipeline_state_id, Pipeline_State.id)
      )
      .where(and(
        eq(Pipeline_Operation_History.id, execution_id),
        eq(Pipeline_Operation_History.status, "running"),
        eq(Pipeline_State.pipeline_name, pipeline_name)
      ))
      .for("update");

    if (!execution_record) {
      throw new Error("Checkpoint requires a running execution for this pipeline.");
    }

    const [state_record] = await transaction
      .update(Pipeline_State)
      .set({
        ingestion_watermark : end_at,
        updated_at : new Date()
      })
      .where(and(
        eq(Pipeline_State.id, execution_record.pipeline_state_id),
        previous_watermark === null
          ? isNull(Pipeline_State.ingestion_watermark)
          : eq(Pipeline_State.ingestion_watermark, previous_watermark)
      ))
      .returning({id : Pipeline_State.id});

    if (!state_record) {
      throw new Error("Pipeline watermark changed before window completion.");
    }

    await transaction
      .update(Pipeline_Operation_History)
      .set({ingestion_watermark_after : end_at})
      .where(eq(Pipeline_Operation_History.id, execution_id));
  });
}