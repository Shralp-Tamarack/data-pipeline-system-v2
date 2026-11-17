export type Raw_Record_Input = {
  source_record_id : string;
  source_context? : Record<string, unknown>;
  content : Record<string, unknown>;
};
export type Source_System_Configuration = {
  data_start_date : Date;
  window_size_in_days : number;
  request_page_size? : number;
};
