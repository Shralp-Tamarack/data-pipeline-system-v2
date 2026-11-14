import {z} from "zod";
import {env_vars} from "../system/system-configuration.ts";

const toast_authentication_response_schema = z.object({
  status : z.literal("SUCCESS"),
  token : z.object({
    accessToken : z.string().refine(
      access_token => access_token.trim().length > 0
    )
  })
});

/** Requests a Toast token without logging credentials or response contents. */
export async function request_toast_access_token(
  signal? : AbortSignal
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

  const response = await fetch(
    new URL("/authentication/v1/authentication/login", toast_host),
    {
      method : "POST",
      redirect : "error",
      signal : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
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

  if (!response.ok) {
    throw new Error(`Toast authentication failed: HTTP ${response.status}.`);
  }

  let authentication_data : unknown;

  try {
    authentication_data = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Toast authentication returned invalid JSON.");
    }

    throw error;
  }

  const validation_result =
    toast_authentication_response_schema.safeParse(authentication_data);

  if (!validation_result.success) {
    throw new Error("Toast returned an invalid authentication response.");
  }

  return validation_result.data.token.accessToken;
}