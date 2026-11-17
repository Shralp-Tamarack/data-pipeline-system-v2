import pino from "pino";
import pretty from "pino-pretty";
import { env_vars } from "./system-configuration.ts";

const pretty_stream = env_vars.log_format === "pretty"
  ? pretty({
      colorize : process.stdout.isTTY === true,
      translateTime : "UTC:HH:MM:ss",
      hideObject : true,
      messageFormat :
        "{if pipeline_name}{pipeline_name} {end}" +
        "{if execution_id}[{execution_id}] {end}{msg}",
      sync : true
    })
  : undefined;

export const system_logger = pino({
    level : "info",
    base : {
        service : "data-pipeline-system",
        system_environment : env_vars.system_environment
    },
    timestamp : pino.stdTimeFunctions.isoTime,
    formatters : {
        level : label => ({level : label})
    },
    redact : {
        paths : [
            "password",
            "token",
            "authorization",
            "toast_client_secret",
            "data_warehouse_connection_string"
        ],
        censor : "[Redacted]"
    }
}, pretty_stream);