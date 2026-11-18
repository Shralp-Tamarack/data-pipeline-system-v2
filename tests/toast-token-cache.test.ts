import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Authentication_Module = typeof import("../core/toast/toast-authentication.ts");

test("Toast token reuse and renewal with synthetic responses", async context => {
  const directory = mkdtempSync(join(tmpdir(), "toast-token-test-"));
  try {
    const toast_directory = join(directory, "core", "toast");
    const system_directory = join(directory, "core", "system");
    mkdirSync(toast_directory, {recursive : true});
    mkdirSync(system_directory, {recursive : true});
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(directory, "node_modules"), "junction");
    for (const filename of ["toast-authentication.ts", "toast-request.ts", "toast-response.ts"]) {
      copyFileSync(resolve(import.meta.dirname, "..", "core", "toast", filename), join(toast_directory, filename));
    }
    writeFileSync(join(system_directory, "system-configuration.ts"), `
export const env_vars = {
  toast_api_host : "https://example.com",
  toast_client_id : "synthetic",
  toast_client_secret : "synthetic"
};
`);
    writeFileSync(join(system_directory, "system-logger.ts"), `export const system_logger = {warn() {}};`);
    const {get_toast_access_token, request_toast_authorized_json} : Authentication_Module =
      await import(pathToFileURL(join(toast_directory, "toast-authentication.ts")).href);
    let now = Date.parse("2026-01-01T00:00:00Z");
    context.mock.method(Date, "now", () => now);
    let login_count = 0;
    let reject_count = 0;
    let token_expiry = 3600;
    let invalid_token = false;
    let authorization_headers : string[] = [];
    context.mock.method(globalThis, "fetch", async (input : URL, options : RequestInit) => {
      if (input.pathname === "/authentication/v1/authentication/login") {
        login_count++;
        const token = invalid_token ? "invalid-token"
          : `header.${Buffer.from(JSON.stringify({
            exp : Math.floor(now / 1000) + token_expiry, serial : login_count
          })).toString("base64url")}.signature`;
        return Response.json({status : "SUCCESS", token : {accessToken : token}});
      }
      authorization_headers.push(new Headers(options.headers).get("Authorization") ?? "");
      if (reject_count > 0) {
        reject_count--;
        return new Response(null, {status : 401});
      }
      return Response.json({ok : true});
    });
    const url = new URL("https://example.com/partners/v1/restaurants");
    const settings = {operation : "location discovery", method : "GET", headers : {}, max_response_bytes : 1024} as const;

    await context.test("shares one login across concurrent callers and future requests", async () => {
      const [first, second] = await Promise.all([get_toast_access_token(), get_toast_access_token()]);
      assert.equal(first, second);
      await request_toast_authorized_json(url, settings);
      await request_toast_authorized_json(url, settings);
      assert.equal(login_count, 1);
      assert.deepEqual(authorization_headers, [`Bearer ${first}`, `Bearer ${first}`]);
    });

    await context.test("renews only near JWT expiry", async () => {
      now += 3_569_000;
      await get_toast_access_token();
      assert.equal(login_count, 1);
      now += 2_000;
      await get_toast_access_token();
      assert.equal(login_count, 2);
    });

    await context.test("a 401 discards the rejected token and retries once", async () => {
      const warnings : object[] = [];
      const request_settings = {...settings, logger : {warn : (fields : object) => warnings.push(fields)}};
      authorization_headers = [];
      reject_count = 1;
      await request_toast_authorized_json(url, request_settings);
      assert.equal(login_count, 3);
      assert.equal(authorization_headers.length, 2);
      assert.notEqual(authorization_headers[0], authorization_headers[1]);
      reject_count = 2;
      await assert.rejects(request_toast_authorized_json(url, request_settings), /HTTP 401/);
      assert.equal(login_count, 4);
      const expected_warning = {
        event : "source_token_refresh",
        source_system : "toast",
        source_operation : "location discovery",
        http_status : 401
      };
      assert.deepEqual(warnings, [expected_warning, expected_warning]);
    });

    await context.test("invalid or already-expiring tokens fail without being cached", async () => {
      invalid_token = true;
      await assert.rejects(get_toast_access_token(), /valid expiry/);
      invalid_token = false;
      token_expiry = 20;
      await assert.rejects(get_toast_access_token(), /invalid or expired expiry/);
      token_expiry = 3600;
      await get_toast_access_token();
      assert.equal(login_count, 7);
    });
  } finally {
    context.mock.restoreAll();
    rmSync(directory, {recursive : true, force : true});
  }
});
