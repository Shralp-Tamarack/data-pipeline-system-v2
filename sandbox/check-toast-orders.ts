import {env_vars} from "../core/system/system-configuration.ts";
import {get_toast_order_page} from "../core/toast/toast-orders.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const order_page = await get_toast_order_page(
  "30adf260-2cab-4857-8b94-5af40f8bcd13",
  "20261111"
);

console.log(`Orders returned: ${order_page.order_records.length}`);
console.log(`Pagination header present: ${order_page.pagination_header_present}`);

const first_order = order_page.order_records[0];

if (first_order) {
  console.log(`Order field names: ${Object.keys(first_order).join(", ")}`);
} else {
  console.log("No orders returned for the selected restaurant and business date.");
}
