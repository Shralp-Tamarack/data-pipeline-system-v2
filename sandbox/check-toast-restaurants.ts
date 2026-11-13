import {env_vars} from "../core/system/system-configuration.ts";
import {get_toast_restaurants} from "../core/toast/toast-restaurants.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

const restaurant_records = await get_toast_restaurants();

if (restaurant_records.length === 0) {
  throw new Error("Toast returned no accessible restaurants.");
}

console.table(
  restaurant_records.map(restaurant_record => ({
    restaurant_guid : restaurant_record.restaurantGuid,
    restaurant_name : typeof restaurant_record.restaurantName === "string"
      ? restaurant_record.restaurantName
      : "Not supplied",
    location_name : typeof restaurant_record.locationName === "string"
      ? restaurant_record.locationName
      : "Not supplied"
  }))
);

console.log(`Toast restaurant discovery succeeded: ${restaurant_records.length} restaurants.`);