import {and, eq, getTableName, sql} from "drizzle-orm";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {
  create_raw_table,
  Pipeline_Execution_History,
  Pipeline_Progress
} from "./system-schema.ts";

type Raw_Record_Input = {
  source_record_id : string;
  content : Record<string, unknown>;
};

/** Commits a bounded Raw batch and its execution counts without advancing a watermark. */
export async function load_raw_records(
  raw_table : ReturnType<typeof create_raw_table>,
  execution_id : string,
  records : Raw_Record_Input[]
): Promise<number> {
  if (records.length > 100) {
    throw new Error("Raw write batches must contain at most 100 records.");
  }

  if (records.some(record => !record.source_record_id.trim())) {
    throw new Error("A Raw record is missing its source identity.");
  }

  const source_ids = records.map(record => record.source_record_id);

  if (new Set(source_ids).size !== source_ids.length) {
    throw new Error("Raw batch contains duplicate source identities.");
  }

  const pipeline_name = getTableName(raw_table);

  return warehouse_db.transaction(async transaction => {
    const [execution_record] = await transaction
      .select({pipeline_name : Pipeline_Progress.pipeline_name})
      .from(Pipeline_Execution_History)
      .innerJoin(
        Pipeline_Progress,
        eq(
          Pipeline_Execution_History.pipeline_progress_id,
          Pipeline_Progress.id
        )
      )
      .where(and(
        eq(Pipeline_Execution_History.id, execution_id),
        eq(Pipeline_Execution_History.status, "running")
      ))
      .for("update");

    if (!execution_record || execution_record.pipeline_name !== pipeline_name) {
      throw new Error("Raw loading requires a running execution for this pipeline.");
    }

    const changed_records = records.length === 0 ? [] : await transaction
      .insert(raw_table)
      .values(records.map(record => ({
        source_record_id : record.source_record_id,
        content : record.content,
        record_source : pipeline_name,
        execution_id : execution_id
      })))
      .onConflictDoUpdate({
        target : [raw_table.record_source, raw_table.source_record_id],
        set : {
          content : sql`excluded.content`,
          execution_id : sql`excluded.execution_id`,
          content_revision : sql`${raw_table.content_revision} + 1`,
          processed : false,
          updated_at : sql`now()`
        },
        setWhere : sql`${raw_table.content} IS DISTINCT FROM excluded.content`
      })
      .returning({id : raw_table.id});

    await transaction
      .update(Pipeline_Execution_History)
      .set({
        records_loaded : sql`${Pipeline_Execution_History.records_loaded} + ${changed_records.length}`
      })
      .where(eq(Pipeline_Execution_History.id, execution_id));

    return changed_records.length;
  });
}