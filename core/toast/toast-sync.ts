import {ingest_toast_locations} from "./toast-locations.ts";
import {ingest_toast_orders} from "./toast-orders.ts";

/** Runs the two Raw pipelines in order. An orders failure does not undo the locations refresh. */
export async function run_toast_sync(signal : AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const locations_result = await ingest_toast_locations(signal);
  if (locations_result.status !== "succeeded") {
    throw new Error(
      `Toast locations ended ${locations_result.status}; orders did not start. ` +
      `Execution: ${locations_result.execution_id}`
    );
  }

  signal.throwIfAborted();
  const orders_result = await ingest_toast_orders(signal);
  if (orders_result.status !== "succeeded") {
    throw new Error(
      `Toast orders ended ${orders_result.status}. Execution: ${orders_result.execution_id}`
    );
  }
}
