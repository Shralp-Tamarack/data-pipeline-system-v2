import {z} from "zod";
import type {Logger} from "pino";
import {and, eq, inArray, or, sql} from "drizzle-orm";
import {env_vars} from "../system/system-configuration.ts";
import {warehouse_db} from "../system/pgsql-warehouse.ts";
import {request_toast_authorized_json} from "./toast-authentication.ts";
import {Toast_Request_Error} from "./toast-request.ts";
import {execute_pipeline} from "../system/pipeline-orchestrator.ts";
import type {Pipeline_Execution_Result} from "../system/pipeline-types.ts";
import {load_raw_records} from "../system/raw-pipeline-loader.ts";
import {
  Raw_Toast_Locations,
  toast_locations_pipeline_name,
  toast_source_system_name,
  Processed_Locations
} from "./toast-schema.ts";
import {Pipeline_Execution_History, Pipeline_Progress} from "../system/system-schema.ts";
import { execute_processing } from "../system/processing-executer.ts";
import {toast_location_type_map} from "./toast-location-type-map.ts";

const toast_location_schema = z.object({
  restaurantGuid : z.string().refine(
    restaurant_guid => restaurant_guid.trim().length > 0
  )
}).passthrough();

type Toast_Location_Record = z.infer<typeof toast_location_schema>;

/** Reads accessible Toast locations without modifying their source fields. */
export async function get_toast_locations(signal? : AbortSignal, logger? : Logger): Promise<Toast_Location_Record[]> {
  signal?.throwIfAborted();
  const response = await request_toast_authorized_json(
    new URL("/partners/v1/restaurants", env_vars.toast_api_host),
    {
      method : "GET",
      operation : "location discovery",
      signal : signal,
      logger : logger,
      max_response_bytes : 1_048_576,
      headers : {
        Accept : "application/json"
      }
    }
  );

  const validation_result = z.array(toast_location_schema)
    .safeParse(response.data);

  if (!validation_result.success) {
    throw new Toast_Request_Error("location discovery", "Toast returned an invalid location list.");
  }

  signal?.throwIfAborted();
  return validation_result.data;
}

/** Refreshes Raw locations as a snapshot without advancing a time-window watermark. */
export async function ingest_toast_locations(signal : AbortSignal): Promise<Pipeline_Execution_Result> {
  signal.throwIfAborted();

  return execute_pipeline(toast_locations_pipeline_name, "ingestion", async (execution_id, pipeline_logger) => {
    const locations = await get_toast_locations(signal, pipeline_logger);
    const location_guids = locations.map(location => location.restaurantGuid);

    if (
      locations.length === 0 ||
      location_guids.some(guid => !z.uuid().safeParse(guid).success) ||
      new Set(location_guids).size !== location_guids.length
    ) {
      throw new Error("Toast discovery must return a nonempty list of unique valid location GUIDs.");
    }

    let records_changed = 0;
    for (let offset = 0; offset < locations.length; offset += 100) {
      signal.throwIfAborted();
      const location_batch = locations.slice(offset, offset + 100);
      const existing_locations = await warehouse_db
        .select({source_record_id : Raw_Toast_Locations.source_record_id})
        .from(Raw_Toast_Locations)
        .where(and(
          eq(Raw_Toast_Locations.record_source, toast_locations_pipeline_name),
          inArray(Raw_Toast_Locations.source_record_id, location_batch.map(location => location.restaurantGuid))
        ));
      const known_guids = new Set(existing_locations.map(location => location.source_record_id));

      signal.throwIfAborted();
      for (const location of location_batch) {
        if (!known_guids.has(location.restaurantGuid)) {
          pipeline_logger.warn({
            event : "source_location_discovered",
            source_system : "toast",
            location_guid : location.restaurantGuid
          }, "Toast location is new to the warehouse catalog; check whether earlier orders need a historical replay");
        }
      }

      const records = location_batch.map(location => ({
        source_record_id : location.restaurantGuid,
        content : location
      }));
      records_changed += await load_raw_records(Raw_Toast_Locations, execution_id, records);
    }

    signal.throwIfAborted();
    pipeline_logger.info({
      event : "source_location_snapshot_loaded",
      source_system : "toast",
      records_read : locations.length,
      records_changed : records_changed
    }, "Toast location snapshot loaded");
    return {status : "succeeded"};
  });
}

type Raw_Toast_Location = Pick<
  typeof Raw_Toast_Locations.$inferSelect,
  "id" | "source_record_id" | "content" | "content_revision" | "deleted"
>;

type Processed_Toast_Location_Values = {
  raw_record_id : string;
  source_system : string;
  source_record_id : string;
  name : string;
  deleted : boolean;
  raw_content_revision : number;
};

/** Maps one Raw revision without assigning or overwriting its business classification. */
export function map_toast_location(
  raw_location : Raw_Toast_Location
): Processed_Toast_Location_Values {
  const content = raw_location.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new Error("Raw Toast location content must be an object.");
  }

  const location_name = "locationName" in content && typeof content.locationName === "string"
    ? content.locationName.trim()
    : "";
  const restaurant_name = "restaurantName" in content && typeof content.restaurantName === "string"
    ? content.restaurantName.trim()
    : "";
  const name = location_name || restaurant_name;

  if (!name) {
    throw new Error("Raw Toast location has no usable name.");
  }

  if (!("deleted" in content) || typeof content.deleted !== "boolean") {
    throw new Error("Raw Toast location has an invalid deleted flag.");
  }

  return {
    raw_record_id : raw_location.id,
    source_system : toast_source_system_name,
    source_record_id : raw_location.source_record_id,
    name : name,
    deleted : raw_location.deleted || content.deleted,
    raw_content_revision : raw_location.content_revision
  };
}

const location_processing_version = 1;

// Commit output, Raw revision markers and the count together; Raw locks prevent newer revisions being marked done.
async function process_toast_location_batch(execution_id : string) : Promise<number> {
  return warehouse_db.transaction(async transaction => {
    // Match ingestion's history/progress-before-Raw lock order.
    const [execution_record] = await transaction
      .select({pipeline_name : Pipeline_Progress.pipeline_name})
      .from(Pipeline_Execution_History)
      .innerJoin(
        Pipeline_Progress,
        eq(Pipeline_Execution_History.pipeline_progress_id, Pipeline_Progress.id)
      )
      .where(and(
        eq(Pipeline_Execution_History.id, execution_id),
        eq(Pipeline_Execution_History.operation, "processing"),
        eq(Pipeline_Execution_History.status, "running")
      ))
      .for("update");

    if (!execution_record || execution_record.pipeline_name !== toast_locations_pipeline_name) {
      throw new Error("Location processing requires a running processing execution for this pipeline.");
    }

    const raw_locations = await transaction
      .select()
      .from(Raw_Toast_Locations)
      .where(and(
        eq(Raw_Toast_Locations.record_source, toast_locations_pipeline_name),
        eq(Raw_Toast_Locations.processed, false)
      ))
      .orderBy(Raw_Toast_Locations.id)
      .limit(100)
      .for("update");

    if (raw_locations.length === 0) {
      return 0;
    }

    const processed_locations = raw_locations.map(raw_location => ({
      ...map_toast_location(raw_location),
      processing_version : location_processing_version,
      execution_id : execution_id
    }));

    await transaction
      .insert(Processed_Locations)
      .values(processed_locations)
      .onConflictDoUpdate({
        target : [Processed_Locations.source_system, Processed_Locations.source_record_id],
        set : {
          name : sql`excluded.name`,
          deleted : sql`excluded.deleted`,
          raw_content_revision : sql`excluded.raw_content_revision`,
          processing_version : sql`excluded.processing_version`,
          execution_id : sql`excluded.execution_id`,
          updated_at : sql`now()`
        }
      });

    const processed_batch_records = await transaction
      .update(Raw_Toast_Locations)
      .set({processed : true})
      .where(or(...raw_locations.map(raw_location => and(
        eq(Raw_Toast_Locations.id, raw_location.id),
        eq(Raw_Toast_Locations.content_revision, raw_location.content_revision)
      ))))
      .returning({id : Raw_Toast_Locations.id});

    if (processed_batch_records.length !== raw_locations.length) {
      throw new Error("Not every Raw location in the batch was marked as processed.");
    }

    const [execution] = await transaction
      .update(Pipeline_Execution_History)
      .set({
        records_processed : sql`${Pipeline_Execution_History.records_processed} + ${processed_batch_records.length}`
      })
      .where(and(
        eq(Pipeline_Execution_History.id, execution_id),
        eq(Pipeline_Execution_History.operation, "processing"),
        eq(Pipeline_Execution_History.status, "running")
      ))
      .returning({id : Pipeline_Execution_History.id});

    if (!execution) {
      throw new Error("Location processing requires a running processing execution.");
    }

    return processed_batch_records.length;
  });
}

export async function process_toast_locations(
  signal : AbortSignal
) : Promise<Pipeline_Execution_Result> {
  return execute_processing({
    pipeline_name : toast_locations_pipeline_name,
    signal : signal,
    process_batch : process_toast_location_batch,
    finalize_processing : async pipeline_logger => {
      signal.throwIfAborted();

      const locations_updated = await apply_toast_location_types();

      pipeline_logger.info({
        event : "location_types_applied",
        locations_updated : locations_updated
      }, "Toast location types applied");
    }
  });
}

export async function apply_toast_location_types(): Promise<number> {
  if (env_vars.system_environment !== "experimental") {
    throw new Error("Applying location business types currently requires the experimental environment.");
  }

  const mapped_location_types = [...toast_location_type_map];

  if (mapped_location_types.length === 0) {
    throw new Error("No Toast location business types are configured.");
  }

  return warehouse_db.transaction(async transaction => {
    let locations_updated = 0;

    for (const [source_record_id, type] of mapped_location_types) {
      const [location] = await transaction
        .select({
          id : Processed_Locations.id,
          type : Processed_Locations.type
        })
        .from(Processed_Locations)
        .where(and(
          eq(Processed_Locations.source_system, toast_source_system_name),
          eq(Processed_Locations.source_record_id, source_record_id)
        ))
        .for("update");

      if (!location) {
        throw new Error("A mapped Toast location does not exist in Processed.");
      }

      if (location.type === type) {
        continue;
      }

      const updated_locations = await transaction
        .update(Processed_Locations)
        .set({
          type : type,
          updated_at : sql`now()`
        })
        .where(eq(Processed_Locations.id, location.id))
        .returning({id : Processed_Locations.id});

      if (updated_locations.length !== 1) {
        throw new Error("The Toast location type update did not affect exactly one location.");
      }

      locations_updated += 1;
    }

    return locations_updated;
  });
}