import {getTableName} from "drizzle-orm";
import type {Logger} from "pino";
import type {create_raw_table} from "./system-schema.ts";
import type {Raw_Record_Input, Source_System_Configuration} from "./ingestion-types.ts";
import type {Ingestion_Window} from "./ingestion-windows.ts";
import {create_ingestion_windows, default_ingestion_window_days} from "./ingestion-windows.ts";
import {execute_tracked_pipeline_operation} from "./pipeline-operation.ts";
import type {Pipeline_Operation_Result} from "./pipeline-types.ts";
import {load_raw_records} from "./raw-pipeline-loader.ts";
import {
  get_or_create_pipeline_progress,
  record_ingestion_window_completion
} from "./pipeline-progress.ts";

type Ingestion_Settings = {
  raw_table : ReturnType<typeof create_raw_table>;
  operation : string;
  ingestion_window_days? : number;
  signal : AbortSignal;
  extract_window : (
    window : Ingestion_Window,
    signal : AbortSignal,
    pipeline_logger : Logger
  ) => AsyncIterable<Raw_Record_Input[]>;
} & (
  | {
    source_configuration : Source_System_Configuration;
    ingestion_lookback_days? : number;
    start_at? : never;
    end_at? : never;
  }
  | {source_configuration? : never; ingestion_lookback_days? : never; start_at : Date; end_at : Date}
);

/** Logs ingestion under its execution ID; only configured runs advance the watermark. */
export async function execute_ingestion(
  settings : Ingestion_Settings
): Promise<Pipeline_Operation_Result> {
  settings.signal.throwIfAborted();

  const lookback_days = settings.ingestion_lookback_days ?? 1;
  const lookback_milliseconds = Math.round(lookback_days * 86_400_000);
  if (
    !Number.isFinite(lookback_days) ||
    lookback_days < 0 ||
    !Number.isSafeInteger(lookback_milliseconds) ||
    (lookback_days > 0 && lookback_milliseconds < 1)
  ) {
    throw new Error("ingestion_lookback_days must be nonnegative and round to at least one millisecond when positive.");
  }

  const pipeline_name = getTableName(settings.raw_table);
  const run_end_at = new Date();

  return execute_tracked_pipeline_operation(
    pipeline_name,
    settings.operation,
    async (execution_id, pipeline_logger) => {
      const source_configuration = settings.source_configuration;
      const progress = source_configuration
        ? await get_or_create_pipeline_progress(pipeline_name)
        : undefined;
      let previous_watermark = progress?.ingestion_watermark ?? null;

      if (source_configuration && !Number.isFinite(source_configuration.data_start_date.getTime())) {
        throw new Error("Source data_start_date must be a valid date.");
      }

      if (previous_watermark && (
        !Number.isFinite(previous_watermark.getTime()) ||
        previous_watermark.getTime() > run_end_at.getTime()
      )) {
        throw new Error("Ingestion watermark must be a valid date not later than the run start.");
      }

      const start_at = source_configuration
        ? previous_watermark
          ? new Date(previous_watermark.getTime() - lookback_milliseconds)
          : source_configuration.data_start_date
        : settings.start_at;
      const end_at = source_configuration ? run_end_at : settings.end_at;

      if (!start_at || !end_at) {
        throw new Error("Ingestion requires a start and end date.");
      }

      if (!Number.isFinite(start_at.getTime())) {
        throw new Error("Ingestion lookback produces an invalid start date.");
      }

      const window_days = settings.ingestion_window_days ?? default_ingestion_window_days;
      pipeline_logger.info({
        event : "ingestion_range_selected",
        range_start_at : start_at,
        range_end_at : end_at,
        ingestion_window_days : window_days,
        ingestion_lookback_days : source_configuration ? lookback_days : null,
        previous_watermark : previous_watermark
      }, "Ingestion range selected");

      for (const window of create_ingestion_windows(start_at, end_at, window_days)) {
        settings.signal.throwIfAborted();
        const window_started_at = performance.now();
        const window_details = {
          window_start_at : window.start_at,
          window_end_at : window.end_at
        };
        let records_read = 0;
        let records_changed = 0;
        pipeline_logger.info({event : "ingestion_window_started", ...window_details}, "Ingestion window started");

        for await (const records of settings.extract_window(
          window,
          settings.signal,
          pipeline_logger
        )) {
          settings.signal.throwIfAborted();

          const changed_record_count = await load_raw_records(
            settings.raw_table,
            execution_id,
            records
          );
          records_read += records.length;
          records_changed += changed_record_count;

          settings.signal.throwIfAborted();
        }

        settings.signal.throwIfAborted();
        const should_checkpoint = source_configuration !== undefined && (
          previous_watermark === null || window.end_at.getTime() > previous_watermark.getTime()
        );
        if (should_checkpoint) {
          try {
            await record_ingestion_window_completion(
              pipeline_name,
              execution_id,
              previous_watermark,
              window.end_at
            );
          } catch (error) {
            pipeline_logger.error({
              event : "ingestion_window_checkpoint_failed",
              ...window_details,
              previous_watermark : previous_watermark
            }, "Could not save ingestion window checkpoint");
            throw error;
          }
          previous_watermark = window.end_at;
        }
        pipeline_logger.info({
          event : should_checkpoint ? "ingestion_window_checkpointed" : "ingestion_window_completed",
          ...window_details,
          records_read : records_read,
          records_changed : records_changed,
          checkpoint_advanced : should_checkpoint,
          duration_ms : Math.round(performance.now() - window_started_at)
        }, should_checkpoint ? "Ingestion window loaded and checkpoint saved" : "Ingestion window loaded; watermark unchanged");
      }

      settings.signal.throwIfAborted();

      return {status : "succeeded"};
    }
  );
}