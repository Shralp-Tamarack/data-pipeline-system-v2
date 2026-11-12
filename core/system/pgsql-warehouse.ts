import pg from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {env_vars} from "./system-configuration.ts";

const warehouse_pool = new pg.Pool({
  connectionString : env_vars.data_warehouse_connection_string,
  max : 5,
  connectionTimeoutMillis : 10_000,
  statement_timeout : 30_000
});

const warehouse_db = drizzle(warehouse_pool);

export {warehouse_db, warehouse_pool};