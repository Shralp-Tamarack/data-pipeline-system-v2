import {env_vars} from "../core/system/system-configuration.ts";
import {create_ingestion_windows} from "../core/system/ingestion-windows.ts";
import {extract_toast_order_window} from "../core/toast/toast-orders.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const restaurant_guid = "30adf260-2cab-4857-8b94-5af40f8bcd13";

const start_at = new Date("2026-11-11T00:00:00.000Z");
const end_at = new Date("2026-11-12T00:00:00.000Z");

const signal = AbortSignal.timeout(120_000);

let nonempty_pages_read = 0;
let records_read = 0;

try {
  for (const window of create_ingestion_windows(start_at, end_at)) {
    console.log(
      `Reading window: ${window.start_at.toISOString()} → ${window.end_at.toISOString()}`
    );

    for await (const records of extract_toast_order_window(
      restaurant_guid,
      window,
      signal
    )) {
      nonempty_pages_read++;
      records_read += records.length;

      console.log(
        `Batch ${nonempty_pages_read}: ${records.length} orders. Total: ${records_read}.`
      );
    }
  }

  console.log(
    `Toast window traversal completed: ${nonempty_pages_read} nonempty pages, ${records_read} orders.`
  );
  console.log("Read-only check. No warehouse writes or progress changes.");
} catch (error) {
  if (signal.aborted) {
    console.error("Toast window check exceeded its two-minute deadline.");
  } else if (error instanceof Error) {
    console.error(`Toast window check failed: ${error.message}`);
  } else {
    console.error("Toast window check failed.");
  }

  process.exitCode = 1;
}