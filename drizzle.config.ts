import {defineConfig} from "drizzle-kit";
import {env_vars} from "./core/system/system-configuration.ts";

export default defineConfig({
  dialect : "postgresql",
  schema : "./core/system/system-schema.ts",
  out : "./drizzle-generated-ddl",
  dbCredentials : {
    url : env_vars.data_warehouse_connection_string
  }
});