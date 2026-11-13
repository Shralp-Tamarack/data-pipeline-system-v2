import {env_vars} from "../core/system/system-configuration.ts";
import {request_toast_access_token} from "../core/toast/toast-authentication.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this check only in the experimental environment.");
}

await request_toast_access_token();

console.log("Toast authentication succeeded. Token not displayed.");