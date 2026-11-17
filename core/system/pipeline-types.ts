export type Pipeline_Execution_Result = {
  execution_id : string;
  status : "succeeded" | "partial" | "cancelled";
};