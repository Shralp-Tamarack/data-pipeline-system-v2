import {z} from "zod";
import {env_vars} from "../system/system-configuration.ts";
import {system_logger} from "../system/system-logger.ts";
import {request_toast_json, Toast_Request_Error} from "./toast-request.ts";

type Toast_Request_Logger = Parameters<typeof request_toast_json>[1]["logger"];

const toast_authentication_response_schema = z.object({
  status : z.literal("SUCCESS"),
  token : z.object({
    accessToken : z.string().refine(
      access_token => access_token.trim().length > 0
    )
  })
});

let cached_token : {value : string; expires_at : number} | undefined;
let pending_token : Promise<string> | undefined;

/** Requests a Toast token with bounded retries/response size; never logs credentials or token contents. */
export async function request_toast_access_token(
  signal? : AbortSignal,
  logger : Toast_Request_Logger = system_logger
): Promise<string> {
  signal?.throwIfAborted();

  if (!URL.canParse(env_vars.toast_api_host)) {
    throw new Error("Invalid toast_api_host.");
  }

  const toast_host = new URL(env_vars.toast_api_host);

  if (
    toast_host.protocol !== "https:" ||
    toast_host.username ||
    toast_host.password
  ) {
    throw new Error("toast_api_host must be an HTTPS URL without credentials.");
  }

  const response = await request_toast_json(
    new URL("/authentication/v1/authentication/login", toast_host),
    {
      operation : "authentication",
      method : "POST",
      signal : signal,
      logger : logger,
      max_response_bytes : 65_536,
      headers : {
        "Content-Type" : "application/json",
        Accept : "application/json"
      },
      body : JSON.stringify({
        clientId : env_vars.toast_client_id,
        clientSecret : env_vars.toast_client_secret,
        userAccessType : "TOAST_MACHINE_CLIENT"
      })
    }
  );

  const validation_result =
    toast_authentication_response_schema.safeParse(response.data);

  if (!validation_result.success) {
    throw new Toast_Request_Error("authentication", "Toast returned an invalid authentication response.");
  }

  return validation_result.data.token.accessToken;
}

/** Reuses one token across Toast locations, refreshing only near its documented JWT expiry. */
export async function get_toast_access_token(signal? : AbortSignal, logger? : Toast_Request_Logger): Promise<string> {
  signal?.throwIfAborted();
  if (cached_token && Date.now() < cached_token.expires_at - 30_000) {
    return cached_token.value;
  }
  if (!pending_token) {
    pending_token = (async () => {
      const token = await request_toast_access_token(signal, logger);
      const payload = token.split(".")[1];
      let expiration : unknown;
      try {
        if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("Invalid token payload.");
        const decoded : unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (typeof decoded === "object" && decoded !== null && "exp" in decoded) {
          expiration = decoded.exp;
        }
      } catch {
        throw new Toast_Request_Error("authentication", "Toast authentication token does not contain a valid expiry.");
      }
      if (
        typeof expiration !== "number" ||
        !Number.isSafeInteger(expiration) ||
        !Number.isSafeInteger(expiration * 1000) ||
        expiration * 1000 <= Date.now() + 30_000
      ) {
        throw new Toast_Request_Error("authentication", "Toast authentication token has an invalid or expired expiry.");
      }
      cached_token = {value : token, expires_at : expiration * 1000};
      return token;
    })().finally(() => { pending_token = undefined; });
  }
  const token = await pending_token;
  signal?.throwIfAborted();
  return token;
}

/** Retries a rejected token once with a fresh token, without logging credentials. */
export async function request_toast_authorized_json(
  request_url : URL,
  settings : Parameters<typeof request_toast_json>[1]
): ReturnType<typeof request_toast_json> {
  const logger = settings.logger ?? system_logger;
  let token = await get_toast_access_token(settings.signal, logger);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await request_toast_json(request_url, {
        ...settings,
        logger : logger,
        headers : {...settings.headers, Authorization : `Bearer ${token}`}
      });
    } catch (error) {
      if (!(error instanceof Toast_Request_Error) || error.status !== 401) throw error;
      if (cached_token?.value === token) cached_token = undefined;
      if (attempt === 1) throw error;
      settings.signal?.throwIfAborted();
      logger.warn({
        event : "source_token_refresh",
        source_system : "toast",
        source_operation : settings.operation,
        http_status : error.status
      }, "Refreshing rejected Toast token before retrying request");
      token = await get_toast_access_token(settings.signal, logger);
    }
  }
  throw new Error("Toast authorization failed.");
}