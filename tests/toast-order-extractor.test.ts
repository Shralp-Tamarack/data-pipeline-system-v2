import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
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
      "toast-locations.ts",
      "toast-location-type-map.ts",
      "toast-authentication.ts",
      "toast-response.ts",
      "toast-request.ts",
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
    writeFileSync(join(toast_directory, "toast-configuration.ts"), `
export const toast_configuration = {request_page_size : 100};
`);
    writeFileSync(join(toast_directory, "toast-schema.ts"), `
export const Raw_Toast_Orders = {};
export const Raw_Toast_Locations = {};
export const Processed_Locations = {};
export const toast_locations_pipeline_name = "toast_locations";
export const toast_source_system_name = "toast";
`);
    writeFileSync(join(system_directory, "system-schema.ts"), `
export const Pipeline_Execution_History = {};
export const Pipeline_Progress = {};
`);
    writeFileSync(join(system_directory, "pgsql-warehouse.ts"), `
export const warehouse_db = {
  select() {throw new Error("Unexpected catalog lookup in extraction test.");}
};
`);
    for (const [filename, export_name] of [
      ["ingestion-executer.ts", "execute_ingestion"],
      ["processing-executer.ts", "execute_processing"],
      ["pipeline-orchestrator.ts", "execute_pipeline"],
      ["raw-pipeline-loader.ts", "load_raw_records"]
    ] as const) {
      writeFileSync(join(system_directory, filename), `
export function ${export_name}() {
  throw new Error("Unexpected persistence call in extraction test.");
}
`);
    }

    writeFileSync(join(system_directory, "system-logger.ts"), `export const system_logger = {warn() {}};`);
    const {extract_toast_order_window, extract_toast_raw_order_window, get_toast_order_page} : Toast_Orders_Module =
      await import(pathToFileURL(join(toast_directory, "toast-orders.ts")).href);
    const {request_toast_access_token} : Toast_Authentication_Module =
      await import(pathToFileURL(join(toast_directory, "toast-authentication.ts")).href);
    const {toast_configuration} : typeof import("../core/toast/toast-configuration.ts") =
      await import(pathToFileURL(join(toast_directory, "toast-configuration.ts")).href);

    await context.test("validates Toast configuration limits before use", async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, "..", "core", "toast", "toast-configuration.ts"), "utf8"
      );
      const validation_file = join(toast_directory, "toast-configuration-validation.ts");
      const cases = [
        {days : "1", page : "1", error : null},
        {days : "28", page : "100", error : null},
        {days : "0", page : "100", error : /window_size_in_days/},
        {days : "29", page : "100", error : /window_size_in_days/},
        {days : "1.5", page : "100", error : null},
        {days : "1 / 24", page : "100", error : null},
        {days : "1e-12", page : "100", error : /window_size_in_days/},
        {days : "NaN", page : "100", error : /window_size_in_days/},
        {days : "28", page : "0", error : /request_page_size/},
        {days : "28", page : "101", error : /request_page_size/},
        {days : "28", page : "1.5", error : /request_page_size/},
        {days : "28", page : "NaN", error : /request_page_size/}
      ];
      for (const [index, scenario] of cases.entries()) {
        const test_source = source
          .replace(/^([ \t]*window_size_in_days[ \t]*:[ \t]*)[0-9.]+([ \t]*,?[ \t]*)\r?$/m, `$1${scenario.days}$2`)
          .replace(/^([ \t]*request_page_size[ \t]*:[ \t]*)[0-9.]+([ \t]*,?[ \t]*)\r?$/m, `$1${scenario.page}$2`);
        writeFileSync(validation_file, test_source);
        const import_config = import(`${pathToFileURL(validation_file).href}?case=${index}`);
        if (scenario.error) {
          await assert.rejects(import_config, scenario.error);
        } else {
          await import_config;
        }
      }
    });

    const restaurant_guid = "11111111-1111-4111-8111-111111111111";
    const window = {
      start_at : new Date("2026-11-01T00:00:00.000Z"),
      end_at : new Date("2026-11-02T00:00:00.000Z")
    };
    let login_count = 0;
    let order_count = 0;
    const now = Date.now();
    const synthetic_token = `header.${Buffer.from(JSON.stringify({exp : Math.floor(now / 1000) + 86_400})).toString("base64url")}.signature`;
    context.mock.method(Date, "now", () => now + order_count * 5_000);
    let handle_orders : (url : URL) => Response = () => {
      throw new Error("Unexpected synthetic order request.");
    };
    let handle_login : (signal : AbortSignal) => Promise<Response> = async () =>
      Response.json({status : "SUCCESS", token : {accessToken : synthetic_token}});

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
      assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${synthetic_token}`);
      assert.equal(new Headers(options.headers).get("Toast-Restaurant-External-ID"), restaurant_guid);
      order_count++;
      return handle_orders(url);
    });

    await context.test("fetches lazily, reuses one token and preserves window filters and records", async () => {
      const first_record = {guid : "synthetic-order-1", nested : {source_field : "unchanged"}};
      handle_orders = url => {
        assert.equal(url.searchParams.get("startDate"), window.start_at.toISOString());
        assert.equal(url.searchParams.get("endDate"), window.end_at.toISOString());
        assert.equal(url.searchParams.get("pageSize"), "100");
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

    await context.test("reads a full 100-order page and follows the next page", async () => {
      const full_page = Array.from({length : 100}, (_, index) => ({guid : `order-${index}`}));
      handle_orders = url => {
        assert.equal(url.searchParams.get("pageSize"), "100");
        if (url.searchParams.get("page") === "1") {
          const next_url = new URL(url);
          next_url.searchParams.set("page", "2");
          return Response.json(full_page, {headers : {link : `<${next_url.href}>; rel="next"`}});
        }
        assert.equal(url.searchParams.get("page"), "2");
        return Response.json([{guid : "order-100"}]);
      };
      const pages = extract_toast_order_window(restaurant_guid, window, new AbortController().signal);
      assert.deepEqual((await pages.next()).value, full_page);
      assert.deepEqual((await pages.next()).value, [{guid : "order-100"}]);
      assert.equal((await pages.next()).done, true);
    });

    await context.test("uses the configured page size for requests and response validation", async () => {
      const original_size = toast_configuration.request_page_size;
      toast_configuration.request_page_size = 7;
      try {
        handle_orders = url => {
          assert.equal(url.searchParams.get("pageSize"), "7");
          return Response.json(Array.from({length : 7}, (_, index) => ({guid : `order-${index}`})));
        };
        const pages = extract_toast_order_window(restaurant_guid, window, new AbortController().signal);
        const first_page = await pages.next();
        assert.ok(Array.isArray(first_page.value));
        assert.equal(first_page.value.length, 7);
        handle_orders = () => Response.json(Array.from({length : 8}, (_, index) => ({guid : `order-${index}`})));
        await assert.rejects(
          extract_toast_order_window(restaurant_guid, window, new AbortController().signal).next(),
          /invalid order page/
        );
      } finally {
        toast_configuration.request_page_size = original_size;
      }
    });

    await context.test("maps a full page into one loader-compatible batch with intact content", async () => {
      const orders = Array.from({length : 100}, (_, index) => ({
        guid : `order-${index}`, nested : {source_value : index}
      }));
      handle_orders = () => Response.json(orders);
      const batches = extract_toast_raw_order_window(restaurant_guid, window, new AbortController().signal);
      const batch = await batches.next();
      assert.deepEqual(batch.value, orders.map(order => ({
        source_record_id : order.guid,
        source_context : {restaurant_guid : restaurant_guid},
        content : order
      })));
      assert.equal((await batches.next()).done, true);
    });

    await context.test("rejects a 100-order response exceeding the byte limit without yielding records", async () => {
      handle_orders = () => Response.json(
        Array.from({length : 100}, (_, index) => ({
          guid : `order-${index}`,
          content : "x".repeat(42_000)
        }))
      );
      await assert.rejects(
        extract_toast_order_window(restaurant_guid, window, new AbortController().signal).next(),
        /exceeds the configured byte limit/
      );
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
            : scenario === "oversize" ? Array.from({length : 101}, (_, index) => ({guid : `order-${index}`}))
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

    await context.test("retries only the failed page without yielding earlier records again", async () => {
      const requested_pages : string[] = [];
      handle_orders = url => {
        assert.equal(url.searchParams.get("startDate"), window.start_at.toISOString());
        assert.equal(url.searchParams.get("endDate"), window.end_at.toISOString());
        const page = url.searchParams.get("page") ?? "";
        requested_pages.push(page);
        if (page === "1") {
          const next_url = new URL(url);
          next_url.searchParams.set("page", "2");
          return Response.json([{guid : "first-page"}], {
            headers : {link : `<${next_url.href}>; rel="next"`}
          });
        }
        if (requested_pages.length === 2) return new Response(null, {status : 503});
        return Response.json([{guid : "second-page"}]);
      };
      const records = [];
      for await (const page of extract_toast_order_window(restaurant_guid, window, new AbortController().signal)) {
        records.push(...page);
      }
      assert.deepEqual(records, [{guid : "first-page"}, {guid : "second-page"}]);
      assert.deepEqual(requested_pages, ["1", "2", "2"]);
    });

    await context.test("cancellation between pages prevents another request", async () => {
      handle_orders = url => {
        const next_url = new URL(url);
        next_url.searchParams.set("page", "2");
        return Response.json([{guid : "synthetic-order"}], {
          headers : {link : `<${next_url.href}>; rel="next"`}
        });
      };
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
        assert.equal(url.searchParams.get("pageSize"), "10");
        return Response.json([{guid : "synthetic-order"}]);
      };
      assert.deepEqual(await get_toast_order_page(restaurant_guid, "20261101"), {
        order_records : [{guid : "synthetic-order"}],
        pagination_header_present : false
      });
    });

    await context.test("authentication responses are byte-bounded and invalid tokens are not retried", async () => {
      const original_login = handle_login;
      try {
        for (const scenario of ["oversize", "invalid"]) {
          const logins_before = login_count;
          handle_login = async () => Response.json({
            status : "SUCCESS",
            token : {accessToken : scenario === "oversize" ? "x".repeat(65_536) : ""}
          });
          await assert.rejects(request_toast_access_token(), /byte limit|invalid authentication response/);
          assert.equal(login_count, logins_before + 1);
        }
      } finally {
        handle_login = original_login;
      }
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
