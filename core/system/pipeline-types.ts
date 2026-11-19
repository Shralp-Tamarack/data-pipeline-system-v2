export type Pipeline_Operation_Result = {
  execution_id : string;
  status : "succeeded" | "partial" | "cancelled";
};