import {z} from "zod";
import type {Logger} from "pino";
import {env_vars} from "../system/system-configuration.ts";
import {request_toast_authorized_json} from "./toast-authentication.ts";
import {Toast_Request_Error} from "./toast-request.ts";
import {toast_configuration} from "./toast-configuration.ts";
import type {Ingestion_Window} from "../system/ingestion-windows.ts";
import {get_toast_next_page_number} from "./toast-order-pagination.ts";
import type { Raw_Record_Input } from "../system/ingestion-types.ts";
import {execute_ingestion} from "../system/ingestion.ts";
import type {Pipeline_Operation_Result} from "../system/pipeline-types.ts";
import {get_toast_locations} from "./toast-locations.ts";
import {Raw_Toast_Orders} from "./toast-schema.ts";

const toast_order_schema = z.object({
  guid : z.string().refine(
    order_guid => order_guid.trim().length > 0
  ),
  deleted : z.boolean()
}).passthrough();

type Toast_Order_Record = z.infer<typeof toast_order_schema>;

type Toast_Order_Page = {
  order_records : Toast_Order_Record[];
  pagination_header_present : boolean;
};

/** Reads one bounded page; does not establish complete coverage or update progress. */
export async function get_toast_order_page(
  restaurant_guid : string,
  business_date : string
): Promise<Toast_Order_Page> {
  if (!z.uuid().safeParse(restaurant_guid).success) {
    throw new Error("A valid Toast restaurant GUID is required.");
  }

  if (!/^\d{8}$/.test(business_date)) {
    throw new Error("Toast business date must use YYYYMMDD.");
  }

  const request_url = new URL(
    "/orders/v2/ordersBulk",
    env_vars.toast_api_host
  );

  request_url.searchParams.set("businessDate", business_date);
  request_url.searchParams.set("page", "1");
  request_url.searchParams.set("pageSize", "10");

  const response = await request_toast_authorized_json(request_url, {
    method : "GET",
    operation : "orders",
    max_response_bytes : 4_194_304,
    headers : {
      "Toast-Restaurant-External-ID" : restaurant_guid,
      Accept : "application/json"
    }
  });

  const validation_result = z.array(toast_order_schema)
    .max(10)
    .safeParse(response.data);

  if (!validation_result.success) {
    throw new Toast_Request_Error("orders", "Toast returned an invalid order page.");
  }

  return {
    order_records : validation_result.data,
    pagination_header_present : response.headers.has("link")
  };
}

/** Yields bounded pages for one modification-time window; does not write or checkpoint. */
export async function* extract_toast_order_window(
  restaurant_guid : string,
  window : Ingestion_Window,
  signal : AbortSignal,
  logger? : Logger
): AsyncGenerator<Toast_Order_Record[], void, unknown> {
  if (!z.uuid().safeParse(restaurant_guid).success) {
    throw new Error("A valid Toast restaurant GUID is required.");
  }

  const start_timestamp = window.start_at.getTime();
  const end_timestamp = window.end_at.getTime();

  if (
    !Number.isFinite(start_timestamp) ||
    !Number.isFinite(end_timestamp) ||
    end_timestamp <= start_timestamp
  ) {
    throw new Error("Toast extraction requires a valid non-empty time window.");
  }

  if (start_timestamp <= Date.parse("2015-12-01T00:00:00.000Z")) {
    throw new Error("Toast extraction start must be after 2015-12-01.");
  }

  const start_date = window.start_at.toISOString();
  const end_date = window.end_at.toISOString();
  const page_size = toast_configuration.request_page_size;

  signal.throwIfAborted();
  let page_number : number | null = 1;

  while (page_number !== null) {
    signal.throwIfAborted();

    const request_url = new URL(
      "/orders/v2/ordersBulk",
      env_vars.toast_api_host
    );

    request_url.searchParams.set("startDate", start_date);
    request_url.searchParams.set("endDate", end_date);
    request_url.searchParams.set("page", String(page_number));
    request_url.searchParams.set("pageSize", String(page_size));

    const response = await request_toast_authorized_json(request_url, {
      method : "GET",
      operation : "orders",
      signal : signal,
      logger : logger,
      max_response_bytes : 4_194_304,
      headers : {
        "Toast-Restaurant-External-ID" : restaurant_guid,
        Accept : "application/json"
      }
    });

    const validation_result = z.array(toast_order_schema)
      .max(page_size)
      .safeParse(response.data);

    if (!validation_result.success) {
      throw new Toast_Request_Error("orders", "Toast returned an invalid order page.");
    }

    const order_records = validation_result.data;
    const source_ids = order_records.map(order => order.guid);

    if (new Set(source_ids).size !== source_ids.length) {
      throw new Error("Toast returned duplicate order identities within a page.");
    }

    const next_page = get_toast_next_page_number(
      request_url,
      response.headers.get("link")
    );

    if (order_records.length === 0 && next_page !== null) {
      throw new Error("Toast returned an empty page with a next-page link.");
    }

    signal.throwIfAborted();

    if (order_records.length > 0) {
      yield order_records;
    }

    page_number = next_page;
  }

  signal.throwIfAborted();
}

/** Adds extraction context without modifying the original Toast order payload. */
export async function* extract_toast_raw_order_window(
  restaurant_guid : string,
  window : Ingestion_Window,
  signal : AbortSignal,
  logger? : Logger
): AsyncGenerator<Raw_Record_Input[], void, unknown> {
  for await (const orders of extract_toast_order_window(
    restaurant_guid,
    window,
    signal,
    logger
  )) {
    yield orders.map(order => ({
      source_record_id : order.guid,
      source_context : {restaurant_guid : restaurant_guid},
      content : order,
      deleted : order.deleted
    }));
  }
}

/** Ingests orders for all discovered locations, resuming the shared pipeline watermark. */
export async function ingest_toast_orders(signal : AbortSignal): Promise<Pipeline_Operation_Result> {
  let location_guids : string[] | undefined;

  return execute_ingestion({
    raw_table : Raw_Toast_Orders,
    operation : "ingestion",
    source_configuration : toast_configuration,
    ingestion_window_days : toast_configuration.window_size_in_days,
    ingestion_lookback_days : toast_configuration.orders_ingestion_lookback_days,
    signal : signal,
    extract_window : async function* (window, extraction_signal, pipeline_logger) {
      if (!location_guids) {
        const locations = await get_toast_locations(extraction_signal, pipeline_logger);
        location_guids = locations.map(location => location.restaurantGuid);
        if (
          location_guids.length === 0 ||
          location_guids.some(guid => !z.uuid().safeParse(guid).success) ||
          new Set(location_guids).size !== location_guids.length
        ) {
          throw new Error("Toast discovery must return a nonempty list of unique valid location GUIDs.");
        }
        pipeline_logger.info({
          event : "source_locations_selected",
          source_system : "toast",
          location_count : location_guids.length
        }, "Selected Toast locations for orders ingestion");
      }

      for (const [index, location_guid] of location_guids.entries()) {
        extraction_signal.throwIfAborted();
        yield* extract_toast_raw_order_window(location_guid, window, extraction_signal, pipeline_logger);
        pipeline_logger.info({
          event : "source_location_window_completed",
          source_system : "toast",
          location_guid : location_guid,
          location_number : index + 1,
          location_count : location_guids.length,
          window_start_at : window.start_at,
          window_end_at : window.end_at
        }, "Completed Toast orders window for location");
      }
    }
  });
}