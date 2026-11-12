import {
  index,
  pgSchema,
  text,
  timestamp,
  uuid,
  integer
} from "drizzle-orm/pg-core";

const System_Schema = pgSchema("system");

export const Pipeline_Progress = System_Schema.table("pipeline_progress", {
  id : uuid("id").primaryKey().defaultRandom(),

  pipeline_name : text("pipeline_name").notNull().unique(),

  ingestion_watermark : timestamp(
    "ingestion_watermark",
    {withTimezone : true}
  ),

  last_successful_ingestion_at : timestamp(
    "last_successful_ingestion_at",
    {withTimezone : true}
  ),
  last_successful_processing_at : timestamp(
    "last_successful_processing_at",
    {withTimezone : true}
  ),

  created_at : timestamp("created_at", {withTimezone : true})
    .notNull()
    .defaultNow(),
  updated_at : timestamp("updated_at", {withTimezone : true})
    .notNull()
    .defaultNow()
});

const Pipeline_Execution_Status = System_Schema.enum(
  "pipeline_execution_status",
  [
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "abandoned"
  ]
);

export const Pipeline_Execution_History = System_Schema.table(
  "pipeline_history",
  {
    id : uuid("id").primaryKey().defaultRandom(),

    pipeline_progress_id : uuid("pipeline_progress_id")
      .notNull()
      .references(() => Pipeline_Progress.id, {onDelete : "restrict"}),

    operation : text("operation").notNull(),
    status : Pipeline_Execution_Status("status")
      .notNull()
      .default("running"),

    ingestion_watermark_before : timestamp(
      "ingestion_watermark_before",
      {withTimezone : true}
    ),
    ingestion_watermark_after : timestamp(
      "ingestion_watermark_after",
      {withTimezone : true}
    ),

    error_summary : text("error_summary"),

    records_loaded : integer("records_loaded").notNull().default(0),
    records_processed : integer("records_processed").notNull().default(0),

    started_at : timestamp("started_at", {withTimezone : true})
      .notNull()
      .defaultNow(),
    finished_at : timestamp("finished_at", {withTimezone : true})
  },
  table => [
    index("pipeline_execution_history_progress_started_at_idx")
      .on(table.pipeline_progress_id, table.started_at)
  ]
);