import {z} from "zod";
import {env_vars} from "../system/system-configuration.ts";
import {request_toast_access_token} from "./toast-authentication.ts";
import {read_toast_json_response} from "./toast-response.ts";

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