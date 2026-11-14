import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

type Toast_Orders_Module = typeof import("../core/toast/toast-orders.ts");
type Toast_Authentication_Module = typeof import("../core/toast/toast-authentication.ts");

test("Toast window extraction with synthetic configuration and mocked fetch", async context => {
  const test_directory = mkdtempSync(join(tmpdir(), "toast-extractor-test-"));

  try {
    const toast_directory = join(test_directory, "core", "toast");
    const system_directory = join(test_directory, "core", "system");
    mkdirSync(toast_directory, {recursive : true});
    mkdirSync(system_directory, {recursive : true});
    writeFileSync(join(test_directory, "package.json"), '{"type":"module"}');
    symlinkSync(
      resolve(import.meta.dirname, "..", "node_modules"),
      join(test_directory, "node_modules"),
      "junction"
    );
    for (const filename of [
      "toast-orders.ts",
      "toast-authentication.ts",
      "toast-response.ts",
      "toast-order-pagination.ts"
    ]) {
      copyFileSync(
        resolve(import.meta.dirname, "..", "core", "toast", filename),
        join(toast_directory, filename)
      );
    }
    writeFileSync(
      join(system_directory, "system-configuration.ts"),
      `export const env_vars = {
  toast_api_host : "https://example.com",
  toast_client_id : "synthetic-client",
  toast_client_secret : "synthetic-secret"
};`
    );

    const {extract_toast_order_window, get_toast_order_page} : Toast_Orders_Module =
      await import(pathToFileURL(join(toast_directory, "toast-orders.ts")).href);
    const {request_toast_access_token} : Toast_Authentication_Module =
      await import(pathToFileURL(join(toast_directory, "toast-authentication.ts")).href);

    const restaurant_guid = "11111111-1111-4111-8111-111111111111";
    const window = {
      start_at : new Date("2026-11-01T00:00:00.000Z"),
      end_at : new Date("2026-11-02T00:00:00.000Z")
    };
    let login_count = 0;
    let order_count = 0;
    let handle_orders : (url : URL) => Response = () => {
      throw new Error("Unexpected synthetic order request.");
    };
    let handle_login : (signal : AbortSignal) => Promise<Response> = async () =>
      Response.json({status : "SUCCESS", token : {accessToken : "synthetic-token"}});

    context.mock.method(globalThis, "fetch", async (
      input : string | URL | Request,
      options? : RequestInit
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, "https://example.com");
      assert.ok(options?.signal);
      assert.equal(options.redirect, "error");
      if (url.pathname === "/authentication/v1/authentication/login") {
        login_count++;
        return handle_login(options.signal);
      }
      assert.equal(url.pathname, "/orders/v2/ordersBulk");
      assert.equal(new Headers(options.headers).get("Authorization"), "Bearer synthetic-token");
      assert.equal(new Headers(options.headers).get("Toast-Restaurant-External-ID"), restaurant_guid);
      order_count++;
      return handle_orders(url);
    });

    await context.test("fetches lazily, reuses one token and preserves window filters and records", async () => {
      const first_record = {guid : "synthetic-order-1", nested : {source_field : "unchanged"}};
      handle_orders = url => {
        assert.equal(url.searchParams.get("startDate"), window.start_at.toISOString());
        assert.equal(url.searchParams.get("endDate"), window.end_at.toISOString());
        assert.equal(url.searchParams.get("pageSize"), "10");
        assert.equal(url.searchParams.has("businessDate"), false);
        if (url.searchParams.get("page") === "1") {
          const next_url = new URL(url);
          next_url.searchParams.set("page", "2");
          return Response.json([first_record], {
            headers : {link : `<${next_url.href}>; rel="next"`}
          });
        }
        assert.equal(url.searchParams.get("page"), "2");
        return Response.json([{guid : "synthetic-order-2"}]);
      };

      const pages = extract_toast_order_window(restaurant_guid, window, new AbortController().signal);
      assert.equal(login_count, 0);
      const first_page = await pages.next();
      assert.deepEqual(first_page.value, [first_record]);
      assert.equal(order_count, 1);
      const second_page = await pages.next();
      assert.deepEqual(second_page.value, [{guid : "synthetic-order-2"}]);
      assert.equal((await pages.next()).done, true);
      assert.equal(login_count, 1);
      assert.equal(order_count, 2);
    });

    await context.test("rejects invalid bounds and pre-aborted requests before login", async () => {
      const previous_logins = login_count;
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        extract_toast_order_window(restaurant_guid, window, controller.signal).next(),
        {name : "AbortError"}
      );
      await assert.rejects(
        extract_toast_order_window(restaurant_guid, {
          start_at : window.end_at,
          end_at : window.start_at
        }, new AbortController().signal).next(),
        /valid non-empty time window/
      );
      assert.equal(login_count, previous_logins);
    });

    await context.test("rejects empty continuing pages, invalid data, duplicates and unsafe links", async () => {
      for (const scenario of ["empty", "invalid", "duplicate", "unsafe", "oversize"]) {
        handle_orders = url => {
          const next_url = new URL(url);
          next_url.searchParams.set("page", "2");
          if (scenario === "unsafe") next_url.hostname = "other.example";
          const records = scenario === "empty" ? []
            : scenario === "invalid" ? [{}]
            : scenario === "duplicate" ? [{guid : "same"}, {guid : "same"}]
            : scenario === "oversize" ? Array.from({length : 11}, (_, index) => ({guid : `order-${index}`}))
            : [{guid : "synthetic-order"}];
          return Response.json(records, {headers : {link : `<${next_url.href}>; rel="next"`}});
        };
        await assert.rejects(
          extract_toast_order_window(restaurant_guid, window, new AbortController().signal).next(),
          /empty page|invalid order page|duplicate order|permitted request target/
        );
      }
    });

    await context.test("later HTTP errors fail extraction instead of reporting completion", async () => {
      handle_orders = url => {
        if (url.searchParams.get("page") === "2") return new Response(null, {status : 503});
        const next_url = new URL(url);
        next_url.searchParams.set("page", "2");
        return Response.json([{guid : "synthetic-order"}], {
          headers : {link : `<${next_url.href}>; rel="next"`}
        });
      };
      const pages = extract_toast_order_window(restaurant_guid, window, new AbortController().signal);
      assert.equal((await pages.next()).done, false);
      await assert.rejects(pages.next(), /HTTP 503/);
    });

    await context.test("cancellation between pages prevents another request", async () => {
      const controller = new AbortController();
      const pages = extract_toast_order_window(restaurant_guid, window, controller.signal);
      await pages.next();
      const previous_order_count = order_count;
      controller.abort();
      await assert.rejects(pages.next(), {name : "AbortError"});
      assert.equal(order_count, previous_order_count);
    });

    await context.test("preserves the original business-date page reader", async () => {
      handle_orders = url => {
        assert.equal(url.searchParams.get("businessDate"), "20261101");
        assert.equal(url.searchParams.has("startDate"), false);
        return Response.json([{guid : "synthetic-order"}]);
      };
      assert.deepEqual(await get_toast_order_page(restaurant_guid, "20261101"), {
        order_records : [{guid : "synthetic-order"}],
        pagination_header_present : false
      });
    });

    await context.test("cancels an in-flight login using the caller signal", async () => {
      const controller = new AbortController();
      handle_login = signal => new Promise((resolve_login, reject_login) => {
        signal.addEventListener("abort", () => reject_login(signal.reason), {once : true});
        controller.abort();
      });
      await assert.rejects(request_toast_access_token(controller.signal), {name : "AbortError"});
    });
  } finally {
    context.mock.restoreAll();
    rmSync(test_directory, {recursive : true, force : true});
  }
});
