import {sql} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";
import {warehouse_db, warehouse_pool} from "../core/system/pgsql-warehouse.ts";

if (env_vars.system_environment !== "experimental") {
  throw new Error("Run this connection check only in the experimental environment.");
}

try {
  await warehouse_db.execute(sql`SELECT 1`);
  console.log("Experimental warehouse connection succeeded.");
} finally {
  await warehouse_pool.end();
}