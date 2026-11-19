import {and, eq, getTableName, or, sql} from "drizzle-orm";
import {execute_tracked_pipeline_operation} from "./pipeline-operation.ts";
import type {Logger} from "pino";
import type {Pipeline_Operation_Result} from "./pipeline-types.ts";
import {warehouse_db} from "./pgsql-warehouse.ts";
import {create_raw_table, Pipeline_Execution_History, Pipeline_Progress} from "./system-schema.ts";
import type {Processing_Transaction, Raw_Processing_Record} from "./processing-types.ts";

type Processing_Settings = {
    raw_table : ReturnType<typeof create_raw_table>;
    signal : AbortSignal;
    write_processed_records : (
        transaction : Processing_Transaction,
        raw_records : Raw_Processing_Record[],
        execution_id : string
    ) => Promise<void>;
    finalize_processing? : (pipeline_logger : Logger) => Promise<void>;
}

// Keep history/progress-before-Raw lock order consistent with ingestion.
async function process_next_raw_batch(
    settings : Processing_Settings,
    execution_id : string
) : Promise<number> {
    const raw_table = settings.raw_table;
    const pipeline_name = getTableName(raw_table);

    return warehouse_db.transaction(async transaction => {
        const [execution_record] = await transaction
            .select({pipeline_name : Pipeline_Progress.pipeline_name})
            .from(Pipeline_Execution_History)
            .innerJoin(
                Pipeline_Progress,
                eq(Pipeline_Execution_History.pipeline_progress_id, Pipeline_Progress.id)
            )
            .where(and(
                eq(Pipeline_Execution_History.id, execution_id),
                eq(Pipeline_Execution_History.operation, "processing"),
                eq(Pipeline_Execution_History.status, "running")
            ))
            .for("update");

        if (!execution_record || execution_record.pipeline_name !== pipeline_name) {
            throw new Error("Raw processing requires a running processing execution for this pipeline.");
        }

        const raw_records = await transaction
            .select()
            .from(raw_table)
            .where(and(
                eq(raw_table.record_source, pipeline_name),
                eq(raw_table.processed, false)
            ))
            .orderBy(raw_table.id)
            .limit(100)
            .for("update");

        if (raw_records.length === 0) {
            return 0;
        }

        await settings.write_processed_records(transaction, raw_records, execution_id);

        const processed_records = await transaction
            .update(raw_table)
            .set({processed : true})
            .where(or(...raw_records.map(raw_record => and(
                eq(raw_table.id, raw_record.id),
                eq(raw_table.content_revision, raw_record.content_revision)
            ))))
            .returning({id : raw_table.id});

        if (processed_records.length !== raw_records.length) {
            throw new Error("Not every Raw record in the batch was marked as processed.");
        }

        const [execution] = await transaction
            .update(Pipeline_Execution_History)
            .set({
                records_processed : sql`${Pipeline_Execution_History.records_processed} + ${processed_records.length}`
            })
            .where(and(
                eq(Pipeline_Execution_History.id, execution_id),
                eq(Pipeline_Execution_History.operation, "processing"),
                eq(Pipeline_Execution_History.status, "running")
            ))
            .returning({id : Pipeline_Execution_History.id});

        if (!execution) {
            throw new Error("Raw processing requires a running processing execution.");
        }

        return processed_records.length;
    });
}

/** Drains pending Raw in batches, committing writer output, revision acknowledgments and counts together. */
export async function process_pending_raw_records(
    settings : Processing_Settings
) : Promise<Pipeline_Operation_Result> {
    settings.signal.throwIfAborted();

    return execute_tracked_pipeline_operation(
        getTableName(settings.raw_table),
        "processing",
        async (execution_id, pipeline_logger) => {
            let batches_completed = 0;

            while (true) {
                settings.signal.throwIfAborted();

                const started_at = performance.now();
                const records_processed = await process_next_raw_batch(settings, execution_id);

                if (records_processed > 0) {
                    batches_completed += 1;

                    pipeline_logger.info({
                        event : "processing_batch_completed",
                        batch_number : batches_completed,
                        records_processed : records_processed,
                        duration_ms : Math.round(performance.now() - started_at)
                    }, "Processing batch committed");
                }

                settings.signal.throwIfAborted();

                if (records_processed === 0) {
                    await settings.finalize_processing?.(pipeline_logger);
                    settings.signal.throwIfAborted();

                    return {status : "succeeded"};
                }
            }
        }
    );
}