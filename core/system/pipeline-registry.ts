import {ingest_toast_orders} from "../toast/toast-orders.ts";
import {
  ingest_toast_locations,
  process_toast_locations
} from "../toast/toast-locations.ts";
import {execute_pipeline_workflow, Pipeline_Command_Error} from "./pipeline-workflow.ts";
import type {Pipeline_Command, Pipeline_Stage_Handlers} from "./pipeline-workflow.ts";

const toast_pipelines = new Map<string, Pipeline_Stage_Handlers>([
  ["toast-locations", {ingest : ingest_toast_locations, process : process_toast_locations}],
  ["toast-orders", {ingest : ingest_toast_orders}]
]);

const source_pipelines = new Map<string, ReadonlyMap<string, Pipeline_Stage_Handlers>>([
  ["toast", toast_pipelines]
]);
const individual_pipelines = new Map([...source_pipelines.values()].flatMap(pipelines => [...pipelines]));
export const available_command_targets = [...source_pipelines.keys(), ...individual_pipelines.keys()];

export async function execute_pipeline_command(
  command : Pipeline_Command,
  target : string,
  signal : AbortSignal,
  report_stage_completion? : Parameters<typeof execute_pipeline_workflow>[4]
) : Promise<void> {
  const pipeline = individual_pipelines.get(target);
  const pipelines = source_pipelines.get(target) ?? (pipeline && new Map([[target, pipeline]]));
  if (!pipelines) {
    throw new Pipeline_Command_Error(`Unknown pipeline or source: ${target}.`);
  }
  await execute_pipeline_workflow(command, target, pipelines, signal, report_stage_completion);
}