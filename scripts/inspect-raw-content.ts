import {sql} from "drizzle-orm";
import {env_vars} from "../core/system/system-configuration.ts";

const raw_table_name = process.argv[2];

if (!raw_table_name || process.argv.length !== 3 || !/^[a-z0-9_]+$/.test(raw_table_name)) {
  throw new Error("Usage: npm run script inspect-raw-content.ts <raw_table_name>");
}

if (env_vars.system_environment !== "experimental") {
  throw new Error("Raw content inspection is only permitted in the experimental environment.");
}

const {warehouse_db, warehouse_pool} = await import("../core/system/pgsql-warehouse.ts");

try {
  const result = await warehouse_db.execute(sql`
    SELECT id, source_record_id, deleted, content_revision, processed, updated_at, content
    FROM ${sql.identifier("raw")}.${sql.identifier(raw_table_name)}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `);
  const [raw_record] = result.rows;

  if (!raw_record) {
    console.log(`No records found in raw.${raw_table_name}.`);
  } else {
    const {content, ...record_metadata} = raw_record;
    console.log(`raw.${raw_table_name}`);
    console.table(record_metadata);
    console.log(JSON.stringify(content, null, 2));
  }
} finally {
  await warehouse_pool.end();
}
