import {eq} from "drizzle-orm";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {Pipeline_Progress} from "./system-schema.ts";

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