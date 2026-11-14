import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

test("reset protects the database and migration files until confirmed and the database reset succeeds", () => {
  const test_directory = mkdtempSync(join(tmpdir(), "reset-database-test-"));

  try {
    mkdirSync(join(test_directory, "scripts"));
    mkdirSync(join(test_directory, "core", "system"), {recursive : true});
    copyFileSync(
      resolve(import.meta.dirname, "../scripts/reset-database.ts"),
      join(test_directory, "scripts", "reset-database.ts")
    );
    writeFileSync(join(test_directory, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(test_directory, "core", "system", "system-configuration.ts"),
      "export const env_vars = {system_environment: process.env.TEST_ENV};\n"
    );
    writeFileSync(
      join(test_directory, "core", "system", "pgsql-warehouse.ts"),
      `import {appendFileSync} from "node:fs";
export const warehouse_pool = {
  query: async (sql: string) => {
    appendFileSync(process.env.TEST_LOG!, sql + "\\n");
    if (process.env.TEST_FAIL === "yes") throw new Error("Synthetic database failure.");
  },
  end: async () => {
    if (process.env.TEST_END_FAIL === "yes") throw new Error("Synthetic close failure.");
  }
};\n`
    );
    const terminal_module = join(test_directory, "terminal.mjs");
    writeFileSync(
      terminal_module,
      'Object.defineProperty(process.stdin, "isTTY", {value: true});\n'
    );

    const cases = [
      {environment : "operational", input : "reset\n", terminal : true, allowed : false, message : "only permitted"},
      {environment : "experimental", input : "no\n", terminal : true, allowed : false, message : "cancelled"},
      {environment : "experimental", input : "RESET\n", terminal : true, allowed : false, message : "cancelled"},
      {environment : "experimental", input : "reset \n", terminal : true, allowed : false, message : "cancelled"},
      {environment : "experimental", input : "", terminal : true, allowed : false, message : "cancelled"},
      {environment : "experimental", input : "reset\n", terminal : false, allowed : false, message : "interactive terminal"},
      {environment : "experimental", input : "reset\n", terminal : true, allowed : true, message : "migrations reset"},
      {environment : "experimental", input : "reset\n", terminal : true, allowed : false, database_failure : true, message : "outcome is unknown"},
      {environment : "experimental", input : "reset\n", terminal : true, allowed : false, close_failure : true, message : "could not be closed"},
      {environment : "experimental", input : "reset\n", terminal : true, allowed : false, invalid_migration_path : true, message : "could not be deleted"}
    ];

    for (const [index, test_case] of cases.entries()) {
      const log_path = join(test_directory, `query-${index}.txt`);
      const migration_path = join(test_directory, "drizzle-generated-ddl");
      if (test_case.invalid_migration_path) {
        writeFileSync(migration_path, "synthetic");
      } else {
        mkdirSync(join(migration_path, "meta"), {recursive : true});
        writeFileSync(join(migration_path, "meta", "synthetic.json"), "{}");
      }
      const result = spawnSync(process.execPath, [
        ...(test_case.terminal ? ["--import", pathToFileURL(terminal_module).href] : []),
        join(test_directory, "scripts", "reset-database.ts")
      ], {
        input : test_case.input,
        encoding : "utf8",
        timeout : 15_000,
        env : {
          PATH : process.env.PATH,
          SystemRoot : process.env.SystemRoot,
          TEST_ENV : test_case.environment,
          TEST_LOG : log_path,
          TEST_FAIL : test_case.database_failure ? "yes" : "no",
          TEST_END_FAIL : test_case.close_failure ? "yes" : "no"
        }
      });

      assert.equal(result.status, test_case.allowed ? 0 : 1);
      assert.match(result.stdout + result.stderr, new RegExp(test_case.message));
      const queries = existsSync(log_path) ? readFileSync(log_path, "utf8") : "";
      assert.equal(
        queries,
        test_case.allowed || test_case.database_failure || test_case.close_failure || test_case.invalid_migration_path
          ? 'DROP SCHEMA IF EXISTS "system", "raw", "processed", "refined", "drizzle" CASCADE\n'
          : ""
      );
      assert.equal(existsSync(migration_path), !test_case.allowed);
      if (!test_case.allowed) {
        rmSync(migration_path, {recursive : true, force : true});
      }
    }
  } finally {
    rmSync(test_directory, {recursive : true, force : true});
  }
});
