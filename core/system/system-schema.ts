import {
  index,
  pgSchema,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
check,
jsonb,
uniqueIndex
} from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

export const System_Schema = pgSchema("system");

export const Pipeline_State = System_Schema.table("pipeline_state", {
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

export const Pipeline_Execution_Status = System_Schema.enum(
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

export const Pipeline_Operation_History = System_Schema.table(
  "pipeline_operation_history",
  {
    id : uuid("id").primaryKey().defaultRandom(),

    pipeline_state_id : uuid("pipeline_state_id")
      .notNull()
      .references(() => Pipeline_State.id, {onDelete : "restrict"}),

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

    records_read : integer("records_read"),
    records_loaded : integer("records_loaded").notNull().default(0),
    records_processed : integer("records_processed").notNull().default(0),

    started_at : timestamp("started_at", {withTimezone : true})
      .notNull()
      .defaultNow(),
    finished_at : timestamp("finished_at", {withTimezone : true})
  },
  table => [
    index("pipeline_operation_history_state_started_at_idx")
      .on(table.pipeline_state_id, table.started_at)
  ]
);

export const Raw_Schema = pgSchema("raw");

/** Creates a fresh Raw table using the shared metadata and identity contract. */
export function create_raw_table(pipeline_name : string) {
  return Raw_Schema.table(pipeline_name, {
    id : uuid("id").primaryKey().defaultRandom(),

    execution_id : uuid("execution_id")
      .notNull()
      .references(() => Pipeline_Operation_History.id, {
        onDelete : "restrict"
      }),

    source_record_id : text("source_record_id").notNull(),

    source_context : jsonb("source_context").$type<Record<string, unknown>>(),

    content : jsonb("content").notNull(),

    record_source : text("record_source")
      .notNull()
      .default(pipeline_name),
    deleted : boolean("deleted").notNull().default(false),

    content_revision : integer("content_revision")
      .notNull()
      .default(1),
    processed : boolean("processed").notNull().default(false),

    created_at : timestamp("created_at", {withTimezone : true})
      .notNull()
      .defaultNow(),
    updated_at : timestamp("updated_at", {withTimezone : true})
      .notNull()
      .defaultNow()
  }, table => [
    uniqueIndex(`${pipeline_name}_source_identity_idx`)
    .on(table.record_source, table.source_record_id),
    index(`${pipeline_name}_pending_processing_idx`)
      .on(table.processed, table.id),
    index(`${pipeline_name}_execution_idx`)
      .on(table.execution_id)
  ]);
}

export const Processed_Schema = pgSchema("processed");

/** Creates identity and metadata columns for a Processed table backed by one Raw table. */
export function create_processed_columns(
  raw_table : ReturnType<typeof create_raw_table>
) {
  return {
    identity_columns : {
      id : uuid("id").primaryKey().defaultRandom(),

      raw_record_id : uuid("raw_record_id")
        .notNull()
        .references(() => raw_table.id, {onDelete : "restrict"}),

      source_system : text("source_system").notNull(),
      source_record_id : text("source_record_id").notNull()
    },

    metadata_columns : {
      deleted : boolean("deleted").notNull().default(false),

      raw_content_revision : integer("raw_content_revision").notNull(),
      processing_version : integer("processing_version").notNull(),

      execution_id : uuid("execution_id")
        .notNull()
        .references(() => Pipeline_Operation_History.id, {
          onDelete : "restrict"
        }),

      created_at : timestamp("created_at", {withTimezone : true})
        .notNull()
        .defaultNow(),
      updated_at : timestamp("updated_at", {withTimezone : true})
        .notNull()
        .defaultNow()
    }
  };
}

export const Refined_Schema = pgSchema("refined");
