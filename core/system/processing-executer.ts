import { execute_pipeline } from "./pipeline-orchestrator.ts";
import type {Logger} from "pino";
import type {Pipeline_Execution_Result} from "./pipeline-types.ts"

type Processing_Settings = {
    pipeline_name : string;
    signal : AbortSignal;
    process_batch : (execution_id : string) => Promise<number>;
    finalize_processing? : (pipeline_logger : Logger) => Promise<void>;
}

/** Drains pending batches; each callback must commit output, Raw markers and counts together. */
export async function execute_processing(
    settings : Processing_Settings
) : Promise<Pipeline_Execution_Result> {
    settings.signal.throwIfAborted();

    return execute_pipeline(
        settings.pipeline_name,
        "processing",
        async (execution_id, pipeline_logger) => {
            let batches_completed = 0;

            while (true) {
                settings.signal.throwIfAborted();

                const started_at = performance.now();
                const records_processed = await settings.process_batch(execution_id);

                if (!Number.isSafeInteger(records_processed) || records_processed < 0) {
                    throw new Error("Processing batch must return a nonnegative whole record count.")
                }

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