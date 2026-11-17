import {setTimeout as delay} from "node:timers/promises";
import type {Logger} from "pino";
import {read_toast_json_response} from "./toast-response.ts";

type Toast_Request_Settings = {
  operation : "authentication" | "location discovery" | "orders";
  method : "GET" | "POST";
  headers : Record<string, string>;
  body? : string;
  signal? : AbortSignal;
  logger? : Pick<Logger, "warn">;
  max_response_bytes : number;
};

export class Toast_Request_Error extends Error {
  readonly status : number | undefined;

  constructor(operation : Toast_Request_Settings["operation"], message : string, status? : number) {
    super(`Toast ${operation}: ${message}`);
    this.name = "Toast_Request_Error";
    this.status = status;
  }
}

let next_orders_request_at = 0;
let orders_request_queue : Promise<void> = Promise.resolve();

async function wait_for_orders_request(signal? : AbortSignal): Promise<void> {
  const previous = orders_request_queue;
  let release : () => void = () => {};
  orders_request_queue = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    signal?.throwIfAborted();
    const wait = next_orders_request_at - Date.now();
    if (wait > 0) await delay(wait, undefined, {signal : signal});
    signal?.throwIfAborted();
    next_orders_request_at = Date.now() + 5_000;
  } finally {
    release();
  }
}

type Toast_Json_Response = {
  data : unknown;
  headers : Headers;
};

function is_retryable_transport_error(error : unknown): boolean {
  let current_error = error;
  for (let depth = 0; depth < 5 && current_error instanceof Error; depth++) {
    if (
      "code" in current_error &&
      typeof current_error.code === "string" &&
      [
        "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
      ].includes(current_error.code)
    ) {
      return true;
    }
    current_error = current_error.cause;
  }
  return false;
}

function get_retry_delay(retry_after : string | null, attempt : number): number {
  const backoff_milliseconds = 500 * 2 ** (attempt - 1) * (1 + Math.random());
  if (retry_after === null) {
    return backoff_milliseconds;
  }

  const value = retry_after.trim();
  const requested_delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]/.test(value) ? Date.parse(value) - Date.now() : NaN;

  if (!Number.isFinite(requested_delay)) {
    throw new Error("Toast returned an invalid Retry-After header.");
  }
  if (requested_delay > 900_000) {
    throw new Error("Toast Retry-After exceeds the 15-minute retry budget; retry the window later.");
  }
  return Math.max(backoff_milliseconds, requested_delay);
}

/** For Toast reads and token creation only; at most three attempts, with bounded JSON and cancellable waits. */
export async function request_toast_json(
  request_url : URL,
  settings : Toast_Request_Settings
): Promise<Toast_Json_Response> {
  if (request_url.protocol !== "https:" || request_url.username || request_url.password) {
    throw new Error("Toast requests require HTTPS without embedded credentials.");
  }
  if (!Number.isSafeInteger(settings.max_response_bytes) || settings.max_response_bytes <= 0) {
    throw new Error("Toast response byte limit must be a positive safe integer.");
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    settings.signal?.throwIfAborted();
    if (settings.operation === "orders") {
      await wait_for_orders_request(settings.signal);
    }
    const request_timeout = AbortSignal.timeout(20_000);
    let retry_after : string | null = null;
    let http_status : number | undefined;
    let retry_reason : string;

    try {
      const response = await fetch(request_url, {
        method : settings.method,
        headers : settings.headers,
        body : settings.body,
        redirect : "error",
        signal : settings.signal
          ? AbortSignal.any([settings.signal, request_timeout])
          : request_timeout
      });
      settings.signal?.throwIfAborted();

      if (response.ok) {
        const data = await read_toast_json_response(response, settings.max_response_bytes);
        settings.signal?.throwIfAborted();
        return {data : data, headers : response.headers};
      }

      retry_after = response.headers.get("retry-after");
      await response.body?.cancel();
      if (settings.operation === "authentication" && response.status === 429) {
        throw new Toast_Request_Error("authentication", "HTTP 429; stop and allow the rate limit to reset before trying again.", 429);
      }
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Toast_Request_Error(settings.operation, `HTTP ${response.status}.`, response.status);
      }
      retry_reason = `HTTP ${response.status}`;
      http_status = response.status;
    } catch (error) {
      settings.signal?.throwIfAborted();
      if (request_timeout.aborted) {
        retry_reason = "request timeout";
      } else if (is_retryable_transport_error(error)) {
        retry_reason = "temporary connection failure";
      } else if (error instanceof Error && [
        "Toast response contains invalid JSON.",
        "Toast response exceeds the configured byte limit.",
        "Toast response has no body."
      ].includes(error.message)) {
        throw new Toast_Request_Error(settings.operation, error.message);
      } else {
        throw error;
      }

      if (attempt === 3) {
        throw new Toast_Request_Error(settings.operation, `failed after three attempts: ${retry_reason}.`);
      }
    }

    let wait_milliseconds : number;
    try {
      wait_milliseconds = get_retry_delay(retry_after, attempt);
    } catch (error) {
      if (error instanceof Error) {
        throw new Toast_Request_Error(settings.operation, error.message);
      }
      throw error;
    }
    settings.logger?.warn({
      event : "source_request_retry",
      source_system : "toast",
      source_operation : settings.operation,
      retry_reason : http_status === undefined ? retry_reason : "http_status",
      http_status : http_status,
      next_attempt : attempt + 1,
      max_attempts : 3,
      wait_ms : Math.ceil(wait_milliseconds)
    }, "Retrying Toast request");
    await delay(wait_milliseconds, undefined, {signal : settings.signal});
  }

  throw new Error("Toast request exhausted its attempt budget.");
}
