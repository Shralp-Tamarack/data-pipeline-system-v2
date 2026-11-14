import {z} from "zod";
import {env_vars} from "../system/system-configuration.ts";
import {request_toast_access_token} from "./toast-authentication.ts";
import {read_toast_json_response} from "./toast-response.ts";
import type {Ingestion_Window} from "../system/ingestion-windows.ts";
import {get_toast_next_page_number} from "./toast-order-pagination.ts";
import type { Raw_Record_Input } from "../system/ingestion-types.ts";

const toast_order_schema = z.object({
  guid : z.string().refine(order_guid => order_guid.trim().length > 0)
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

  const access_token = await request_toast_access_token();

  const request_url = new URL(
    "/orders/v2/ordersBulk",
    env_vars.toast_api_host
  );

  request_url.searchParams.set("businessDate", business_date);
  request_url.searchParams.set("page", "1");
  request_url.searchParams.set("pageSize", "10");

  const response = await fetch(request_url, {
    method : "GET",
    redirect : "error",
    signal : AbortSignal.timeout(20_000),
    headers : {
      Authorization : `Bearer ${access_token}`,
      "Toast-Restaurant-External-ID" : restaurant_guid,
      Accept : "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Toast order request failed: HTTP ${response.status}.`);
  }

  const order_data = await read_toast_json_response(response, 4_194_304);
  const validation_result = z.array(toast_order_schema)
    .max(10)
    .safeParse(order_data);

  if (!validation_result.success) {
    throw new Error("Toast returned an invalid order page.");
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
  signal : AbortSignal
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

  signal.throwIfAborted();
  const access_token = await request_toast_access_token(signal);
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
    request_url.searchParams.set("pageSize", "10");

    const response = await fetch(request_url, {
      method : "GET",
      redirect : "error",
      signal : AbortSignal.any([
        signal,
        AbortSignal.timeout(20_000)
      ]),
      headers : {
        Authorization : `Bearer ${access_token}`,
        "Toast-Restaurant-External-ID" : restaurant_guid,
        Accept : "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Toast order request failed: HTTP ${response.status}.`);
    }

    const order_data = await read_toast_json_response(
      response,
      4_194_304
    );

    const validation_result = z.array(toast_order_schema)
      .max(10)
      .safeParse(order_data);

    if (!validation_result.success) {
      throw new Error("Toast returned an invalid order page.");
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
  signal : AbortSignal
): AsyncGenerator<Raw_Record_Input[], void, unknown> {
  for await (const orders of extract_toast_order_window(
    restaurant_guid,
    window,
    signal
  )) {
    yield orders.map(order => ({
      source_record_id : order.guid,
      source_context : {restaurant_guid : restaurant_guid},
      content : order
    }));
  }
}