import type {Source_System_Configuration} from "../system/ingestion-types.ts";

type Toast_Configuration = Source_System_Configuration & {
  request_page_size : number;
  orders_ingestion_lookback_days? : number;
};

export const toast_configuration : Toast_Configuration = {
  data_start_date : new Date("2026-06-01T00:00:00.000Z"),
  window_size_in_days : 28,
  request_page_size : 100
};

// A 28-day window stays within Toast's one-month limit across February.
const window_milliseconds = Math.round(toast_configuration.window_size_in_days * 86_400_000);
if (
  !Number.isFinite(toast_configuration.window_size_in_days) ||
  toast_configuration.window_size_in_days <= 0 ||
  toast_configuration.window_size_in_days > 28 ||
  !Number.isSafeInteger(window_milliseconds) ||
  window_milliseconds < 1
) {
  throw new Error("Toast window_size_in_days must be positive, at most 28, and round to at least one millisecond.");
}

if (
  !Number.isSafeInteger(toast_configuration.request_page_size) ||
  toast_configuration.request_page_size < 1 ||
  toast_configuration.request_page_size > 100
) {
  throw new Error("Toast request_page_size must be a whole number between 1 and 100.");
}
