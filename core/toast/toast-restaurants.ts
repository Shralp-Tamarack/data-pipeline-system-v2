import {z} from "zod";
import {env_vars} from "../system/system-configuration.ts";
import {request_toast_access_token} from "./toast-authentication.ts";
import {read_toast_json_response} from "./toast-response.ts";

const toast_restaurant_schema = z.object({
  restaurantGuid : z.string().refine(
    restaurant_guid => restaurant_guid.trim().length > 0
  )
}).passthrough();

type Toast_Restaurant_Record = z.infer<typeof toast_restaurant_schema>;

/** Reads accessible restaurant connections without modifying their source fields. */
export async function get_toast_restaurants(signal? : AbortSignal): Promise<Toast_Restaurant_Record[]> {
  signal?.throwIfAborted();
  const access_token = await request_toast_access_token(signal);

  const response = await fetch(
    new URL("/partners/v1/restaurants", env_vars.toast_api_host),
    {
      method : "GET",
      redirect : "error",
      signal : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
      headers : {
        Authorization : `Bearer ${access_token}`,
        Accept : "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Toast restaurant request failed: HTTP ${response.status}.`);
  }

  const restaurant_data = await read_toast_json_response(response, 1_048_576);
  const validation_result = z.array(toast_restaurant_schema)
    .safeParse(restaurant_data);

  if (!validation_result.success) {
    throw new Error("Toast returned an invalid restaurant list.");
  }

  signal?.throwIfAborted();
  return validation_result.data;
}