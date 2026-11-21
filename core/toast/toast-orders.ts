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
import {
  Processed_Toast_Locations,
  Processed_Toast_Orders,
  Raw_Toast_Orders,
  toast_source_system_name
} from "./toast-schema.ts";
import {and, eq, inArray, sql} from "drizzle-orm";
import type {Processing_Transaction, Raw_Processing_Record} from "../system/processing-types.ts";
import {process_pending_raw_records} from "../system/processing.ts";

const toast_order_ingestion_validator = z.object({
  guid : z.string().refine(
    order_guid => order_guid.trim().length > 0
  ),
  deleted : z.boolean()
}).passthrough();

type Toast_Api_Order = z.infer<typeof toast_order_ingestion_validator>;

const toast_order_processing_validator = z.object({
  guid : z.string().min(1),
  deleted : z.boolean(),
  voided : z.boolean(),
  excessFood : z.boolean(),
  createdInTestMode : z.boolean(),
  businessDate : z.number().int(),
  createdDate : z.string(),
  modifiedDate : z.string(),
  checks : z.array(z.object({
    deleted : z.boolean(),
    voided : z.boolean(),
    amount : z.number(),
    selections : z.array(z.object({
      voided : z.boolean(),
      deferred : z.boolean(),
      selectionType : z.string().nullable(),
      price : z.number()
    })),
    appliedServiceCharges : z.array(z.object({
      chargeAmount : z.number(),
      serviceChargeCategory : z.string().nullable()
    })).nullable()
  }))
});

function convert_to_cents(amount : number) : number {
  return Math.round(amount * 100);
}

// Toast sends offsets like "+0000"; add the colon so parsing is unambiguous.
function parse_toast_timestamp(value : string) : Date {
  const timestamp = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Toast order has an invalid timestamp.");
  }

  return timestamp;
}

function format_business_date(business_date : number) : string {
  const date_text = String(business_date);
  const formatted_date =
    `${date_text.slice(0, 4)}-${date_text.slice(4, 6)}-${date_text.slice(6, 8)}`;

  if (
    !/^\d{8}$/.test(date_text) ||
    Number.isNaN(Date.parse(`${formatted_date}T00:00:00Z`)) ||
    new Date(`${formatted_date}T00:00:00Z`).toISOString().slice(0, 10) !== formatted_date
  ) {
    throw new Error("Toast order has an invalid business date.");
  }

  return formatted_date;
}

type Raw_Toast_Order = Pick<
  typeof Raw_Toast_Orders.$inferSelect,
  "id" | "source_record_id" | "content" | "content_revision" | "deleted"
>;

/** Maps one Raw order to processed values; the writer resolves its location. */
export function map_toast_order(raw_order : Raw_Toast_Order) {
  const validation_result = toast_order_processing_validator.safeParse(raw_order.content);

  if (!validation_result.success) {
    throw new Error("Raw Toast order does not match the processing contract.");
  }

  const order = validation_result.data;

  if (order.guid !== raw_order.source_record_id) {
    throw new Error("Raw Toast order identity does not match its content.");
  }

  const included_checks = order.checks.filter(check => !check.deleted && !check.voided);
  let net_sales_cents = 0;

  for (const check of included_checks) {
    net_sales_cents += convert_to_cents(check.amount);

    for (const selection of check.selections) {
      if (
        !selection.voided &&
        (selection.deferred || selection.selectionType === "HOUSE_ACCOUNT_PAY_BALANCE")
      ) {
        net_sales_cents -= convert_to_cents(selection.price);
      }
    }

    for (const service_charge of check.appliedServiceCharges ?? []) {
      if (service_charge.serviceChargeCategory === "FUNDRAISING_CAMPAIGN") {
        net_sales_cents -= convert_to_cents(service_charge.chargeAmount);
      }
    }
  }

  return {
    raw_record_id : raw_order.id,
    source_system : toast_source_system_name,
    source_record_id : raw_order.source_record_id,
    business_date : format_business_date(order.businessDate),
    voided : order.voided,
    excess_food : order.excessFood,
    created_in_test_mode : order.createdInTestMode,
    net_sales_amount : (net_sales_cents / 100).toFixed(2),
    check_count : included_checks.length,
    source_created_at : parse_toast_timestamp(order.createdDate),
    source_modified_at : parse_toast_timestamp(order.modifiedDate),
    deleted : raw_order.deleted || order.deleted,
    raw_content_revision : raw_order.content_revision
  };
}

const order_processing_version = 1;

function get_order_restaurant_guid(raw_order : Raw_Processing_Record) : string {
  const restaurant_guid = raw_order.source_context?.restaurant_guid;

  if (typeof restaurant_guid !== "string" || !restaurant_guid) {
    throw new Error("Raw Toast order has no restaurant GUID in its source context.");
  }

  return restaurant_guid;
}

async function write_processed_orders(
  transaction : Processing_Transaction,
  raw_orders : Raw_Processing_Record[],
  execution_id : string
) : Promise<void> {
  const restaurant_guids = [...new Set(raw_orders.map(get_order_restaurant_guid))];

  const locations = await transaction
    .select({
      id : Processed_Toast_Locations.id,
      source_record_id : Processed_Toast_Locations.source_record_id
    })
    .from(Processed_Toast_Locations)
    .where(and(
      eq(Processed_Toast_Locations.source_system, toast_source_system_name),
      inArray(Processed_Toast_Locations.source_record_id, restaurant_guids)
    ));

  const location_ids = new Map(
    locations.map(location => [location.source_record_id, location.id])
  );

  const processed_orders = raw_orders.map(raw_order => {
    const location_id = location_ids.get(get_order_restaurant_guid(raw_order));

    if (!location_id) {
      throw new Error("Toast order location has not been processed; process toast-locations first.");
    }

    return {
      ...map_toast_order(raw_order),
      location_id : location_id,
      processing_version : order_processing_version,
      execution_id : execution_id
    };
  });

  await transaction
    .insert(Processed_Toast_Orders)
    .values(processed_orders)
    .onConflictDoUpdate({
      target : [Processed_Toast_Orders.source_system, Processed_Toast_Orders.source_record_id],
      set : {
        business_date : sql`excluded.business_date`,
        voided : sql`excluded.voided`,
        excess_food : sql`excluded.excess_food`,
        created_in_test_mode : sql`excluded.created_in_test_mode`,
        net_sales_amount : sql`excluded.net_sales_amount`,
        check_count : sql`excluded.check_count`,
        source_modified_at : sql`excluded.source_modified_at`,
        deleted : sql`excluded.deleted`,
        raw_content_revision : sql`excluded.raw_content_revision`,
        processing_version : sql`excluded.processing_version`,
        execution_id : sql`excluded.execution_id`,
        updated_at : sql`now()`
      }
    });
}

/** Processes pending raw orders into processed orders in transactional batches */
export async function process_toast_orders(
  signal : AbortSignal
) : Promise<Pipeline_Operation_Result> {
  return process_pending_raw_records({
    raw_table : Raw_Toast_Orders,
    signal : signal,
    write_processed_records : write_processed_orders
  });
}

type Toast_Order_Page = {
  order_records : Toast_Api_Order[];
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

  const validation_result = z.array(toast_order_ingestion_validator)
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
): AsyncGenerator<Toast_Api_Order[], void, unknown> {
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

    const validation_result = z.array(toast_order_ingestion_validator)
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