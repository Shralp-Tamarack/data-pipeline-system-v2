import {getTableName} from "drizzle-orm";
import type {create_raw_table} from "./system-schema.ts";
import type {Raw_Record_Input, Source_System_Configuration} from "./ingestion-types.ts";
import type {Ingestion_Window} from "./ingestion-windows.ts";
import {create_ingestion_windows} from "./ingestion-windows.ts";
import {execute_pipeline} from "./pipeline-orchestrator.ts";
import {load_raw_records} from "./raw-pipeline-loader.ts";
import {
  get_or_create_pipeline_progress,
  record_ingestion_window_completion
} from "./pipeline-progress.ts";

type Ingestion_Settings = {
  raw_table : ReturnType<typeof create_raw_table>;
  operation : string;
  ingestion_window_hours? : number;
  signal : AbortSignal;
  extract_window : (
    window : Ingestion_Window,
    signal : AbortSignal
  ) => AsyncIterable<Raw_Record_Input[]>;
} & (
  | {source_configuration : Source_System_Configuration; start_at? : never; end_at? : never}
  | {source_configuration? : never; start_at : Date; end_at : Date}
);

/** Resumes configured ingestion toward run-start time; explicit ranges leave progress unchanged. */
export async function execute_ingestion(
  settings : Ingestion_Settings
): Promise<string> {
  settings.signal.throwIfAborted();

  const pipeline_name = getTableName(settings.raw_table);
  const run_end_at = new Date();

  return execute_pipeline(
    pipeline_name,
    settings.operation,
    async execution_id => {
      const source_configuration = settings.source_configuration;
      const progress = source_configuration
        ? await get_or_create_pipeline_progress(pipeline_name)
        : undefined;
      let previous_watermark = progress?.ingestion_watermark ?? null;
      const start_at = source_configuration
        ? previous_watermark ?? source_configuration.data_start_date
        : settings.start_at;
      const end_at = source_configuration ? run_end_at : settings.end_at;

      if (source_configuration && !Number.isFinite(source_configuration.data_start_date.getTime())) {
        throw new Error("Source data_start_date must be a valid date.");
      }

      if (!start_at || !end_at) {
        throw new Error("Ingestion requires a start and end date.");
      }

      for (const window of create_ingestion_windows(
        start_at,
        end_at,
        settings.ingestion_window_hours
      )) {
        settings.signal.throwIfAborted();

        for await (const records of settings.extract_window(
          window,
          settings.signal
        )) {
          settings.signal.throwIfAborted();

          await load_raw_records(
            settings.raw_table,
            execution_id,
            records
          );

          settings.signal.throwIfAborted();
        }

        settings.signal.throwIfAborted();
        if (source_configuration) {
          await record_ingestion_window_completion(
            pipeline_name,
            execution_id,
            previous_watermark,
            window.end_at
          );
          previous_watermark = window.end_at;
        }
      }

      settings.signal.throwIfAborted();

      return {status : "succeeded"};
    }
  );
}