import {z} from "zod";
import {execute_ingestion} from "../system/ingestion-executer.ts";
import {toast_configuration} from "./toast-configuration.ts";
import {get_toast_restaurants} from "./toast-restaurants.ts";
import {extract_toast_raw_order_window} from "./toast-orders.ts";
import {Raw_Toast_Orders} from "./toast-schema.ts";

/** Ingests orders for all discovered restaurants, resuming the shared pipeline watermark. */
export async function ingest_toast_orders(signal : AbortSignal): Promise<string> {
  let restaurant_guids : string[] | undefined;

  return execute_ingestion({
    raw_table : Raw_Toast_Orders,
    operation : "ingestion",
    source_configuration : toast_configuration,
    signal : signal,
    extract_window : async function* (window, extraction_signal) {
      if (!restaurant_guids) {
        const restaurants = await get_toast_restaurants(extraction_signal);
        restaurant_guids = restaurants.map(restaurant => restaurant.restaurantGuid);
        if (
          restaurant_guids.length === 0 ||
          restaurant_guids.some(guid => !z.uuid().safeParse(guid).success) ||
          new Set(restaurant_guids).size !== restaurant_guids.length
        ) {
          throw new Error("Toast discovery must return a nonempty list of unique valid restaurant GUIDs.");
        }
      }

      for (const restaurant_guid of restaurant_guids) {
        extraction_signal.throwIfAborted();
        yield* extract_toast_raw_order_window(restaurant_guid, window, extraction_signal);
      }
    }
  });
}
