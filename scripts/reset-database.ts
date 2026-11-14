import {lstat, rm} from "node:fs/promises";
import {resolve} from "node:path";
import {createInterface} from "node:readline";
import {stdin, stdout} from "node:process";
import {env_vars} from "../core/system/system-configuration.ts";

async function reset_database(): Promise<void> {
  if (env_vars.system_environment !== "experimental") {
    console.error("Database reset is only permitted in the experimental environment.");
    process.exitCode = 1;
    return;
  }

  if (!stdin.isTTY) {
    console.error("Database reset requires an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "This permanently drops the system, raw, processed, refined, and drizzle schemas."
  );
  console.log("CASCADE may also remove dependent objects outside these schemas.");
  console.log("This also permanently deletes the local drizzle-generated-ddl folder and its contents.");
  console.log("Verify the actual database target and recovery plan before continuing.");
  stdout.write('Type "reset" to continue: ');

  const input = createInterface({input : stdin});
  let confirmation : string | undefined;

  try {
    for await (const line of input) {
      confirmation = line;
      break;
    }
  } finally {
    input.close();
  }

  if (confirmation !== "reset") {
    console.error("Database reset cancelled.");
    process.exitCode = 1;
    return;
  }

  const {warehouse_pool} = await import("../core/system/pgsql-warehouse.ts");
  let database_reset_succeeded = false;

  try {
    await warehouse_pool.query(
      'DROP SCHEMA IF EXISTS "system", "raw", "processed", "refined", "drizzle" CASCADE'
    );
    database_reset_succeeded = true;
  } catch {
    console.error("Database reset failed or its outcome is unknown. Migration files were not deleted.");
    process.exitCode = 1;
  }

  try {
    await warehouse_pool.end();
  } catch {
    console.error("Database connection could not be closed. Migration files were not deleted; inspect the database state.");
    process.exitCode = 1;
    return;
  }

  if (!database_reset_succeeded) {
    return;
  }

  const migration_directory = resolve(import.meta.dirname, "..", "drizzle-generated-ddl");

  try {
    const directory_info = await lstat(migration_directory).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    });

    if (directory_info && (!directory_info.isDirectory() || directory_info.isSymbolicLink())) {
      throw new Error("Migration path is not a regular directory.");
    }

    await rm(migration_directory, {recursive : true, force : true});
    console.log("Experimental database project schemas and local generated migrations reset.");
  } catch {
    console.error("Database reset succeeded, but local generated migrations could not be deleted.");
    process.exitCode = 1;
  }
}

await reset_database();
