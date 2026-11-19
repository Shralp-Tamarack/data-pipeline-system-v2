import type {Pipeline_Operation_Result} from "./pipeline-types.ts";

type Pipeline_Stage = "ingest" | "reconcile" | "process";
export type Pipeline_Command = Pipeline_Stage | "sync";
export type Pipeline_Stage_Handlers = Partial<Record<
  Pipeline_Stage,
  (signal : AbortSignal) => Promise<Pipeline_Operation_Result>
>>;

export class Pipeline_Command_Error extends Error {}

const active_workflow_pipelines = new Set<string>();

export async function execute_pipeline_workflow(
  command : Pipeline_Command,
  target : string,
  pipelines : ReadonlyMap<string, Pipeline_Stage_Handlers>,
  signal : AbortSignal,
  report_stage_completion? : (pipeline_name : string, stage : Pipeline_Stage, execution_id : string) => void
) : Promise<void> {
  signal.throwIfAborted();
  const stages : Pipeline_Stage[] = command === "sync" ? ["ingest", "reconcile", "process"] : [command];
  const planned_stages = [];

  for (const [pipeline_name, handlers] of pipelines) {
    for (const stage of stages) {
      const execute_stage = handlers[stage];
      if (!execute_stage) {
        if (stage === "reconcile") continue;
        const alternative = command === "sync" ? ` Use \`npm run ingest -- ${target}\` for Raw only.` : "";
        throw new Pipeline_Command_Error(
          `${command} is unavailable for ${target}: ${stage} is not implemented for ${pipeline_name}.${alternative}`
        );
      }
      planned_stages.push({pipeline_name : pipeline_name, stage : stage, execute_stage : execute_stage});
    }
  }

  if (planned_stages.length === 0) {
    throw new Pipeline_Command_Error(`${command} is not supported for ${target}.`);
  }

  for (const pipeline_name of pipelines.keys()) {
    if (active_workflow_pipelines.has(pipeline_name)) {
      throw new Pipeline_Command_Error(`${pipeline_name} already has an active workflow in this process.`);
    }
  }
  for (const pipeline_name of pipelines.keys()) {
    active_workflow_pipelines.add(pipeline_name);
  }

  try {
    for (const {pipeline_name, stage, execute_stage} of planned_stages) {
      signal.throwIfAborted();
      const {execution_id, status} = await execute_stage(signal);
      if (status !== "succeeded") {
        throw new Pipeline_Command_Error(`${pipeline_name} ${stage} ended ${status}. Execution: ${execution_id}`);
      }
      signal.throwIfAborted();
      report_stage_completion?.(pipeline_name, stage, execution_id);
    }
  } finally {
    for (const pipeline_name of pipelines.keys()) {
      active_workflow_pipelines.delete(pipeline_name);
    }
  }
}
