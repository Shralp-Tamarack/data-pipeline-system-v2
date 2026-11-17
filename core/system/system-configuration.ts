import dotenv from "dotenv";
import {resolve} from "node:path";

const configuration_directory =
  typeof __dirname === "string" ? __dirname : import.meta.dirname;

dotenv.config({
  path : resolve(configuration_directory, "..", "..", ".env"),
  quiet : true
});

const log_format = process.env.log_format ?? "json";
if (log_format !== "json" && log_format !== "pretty") {
  throw new Error("log_format must be json or pretty.");
}

type Env_Vars = {
  system_environment : string;
  log_format : "json" | "pretty";
  data_warehouse_connection_string : string;
  toast_api_host : string; 
  toast_client_id : string;
  toast_client_secret : string;
};

const env_vars : Env_Vars = {
  system_environment : process.env.system_environment ?? "",
  log_format : log_format,
  data_warehouse_connection_string : process.env.data_warehouse_connection_string ?? "",
  toast_api_host : process.env.toast_api_host ?? "",
  toast_client_id : process.env.toast_client_id ?? "",
  toast_client_secret : process.env.toast_client_secret ?? "",
};

if (Object.values(env_vars).some(value => !value.trim())) {
  throw new Error("A required environment variable is missing.");
}

if (env_vars.system_environment !== "experimental" && env_vars.system_environment !== "operational") {
  throw new Error("system_environment must be experimental or operational.");
}

export {env_vars};