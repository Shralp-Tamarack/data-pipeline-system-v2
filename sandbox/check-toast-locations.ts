import {env_vars} from "../core/system/system-configuration.ts";
import {get_toast_locations} from "../core/toast/toast-locations.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const location_records = await get_toast_locations();

if (location_records.length === 0) {
  throw new Error("Toast returned no accessible locations.");
}

console.table(
  location_records.map(location_record => ({
    location_guid : location_record.restaurantGuid,
    restaurant_name : typeof location_record.restaurantName === "string"
      ? location_record.restaurantName
      : "Not supplied",
    location_name : typeof location_record.locationName === "string"
      ? location_record.locationName
      : "Not supplied"
  }))
);

console.log(`Toast location discovery succeeded: ${location_records.length} locations.`);