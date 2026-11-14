import {and, eq, getTableName, or, sql} from "drizzle-orm";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {
  create_raw_table,
  Pipeline_Execution_History,
  Pipeline_Progress
} from "./system-schema.ts";
import type { Raw_Record_Input } from "./ingestion-types.ts";

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
        source_context : record.source_context,
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
        setWhere : sql`${raw_table.content} IS DISTINCT FROM excluded.content
          AND (excluded.source_context IS NULL
            OR ${raw_table.source_context} IS NOT DISTINCT FROM excluded.source_context)`
      })
      .returning({id : raw_table.id});

    const context_checks = records.flatMap(record =>
      record.source_context === undefined ? [] : [
        and(
          eq(raw_table.source_record_id, record.source_record_id),
          sql`${raw_table.source_context} IS DISTINCT FROM ${JSON.stringify(record.source_context)}::jsonb`
        )
      ]
    );

    if (context_checks.length > 0) {
      const [context_conflict] = await transaction
        .select({id : raw_table.id})
        .from(raw_table)
        .where(and(
          eq(raw_table.record_source, pipeline_name),
          or(...context_checks)
        ))
        .limit(1);

      if (context_conflict) {
        throw new Error("Raw record source context conflicts with existing data.");
      }
    }

    await transaction
      .update(Pipeline_Execution_History)
      .set({
        records_loaded : sql`${Pipeline_Execution_History.records_loaded} + ${changed_records.length}`
      })
      .where(eq(Pipeline_Execution_History.id, execution_id));

    return changed_records.length;
  });
}