import assert from "node:assert/strict";
import {setImmediate as flush_promises} from "node:timers/promises";
import {test} from "node:test";
import pino from "pino";
import {request_toast_json} from "../core/toast/toast-request.ts";

const request_url = new URL("https://example.com/orders?page=2");
const request_settings = {
  method : "GET",
  operation : "location discovery",
  headers : {Authorization : "Bearer synthetic-token"},
  max_response_bytes : 1024
} satisfies Parameters<typeof request_toast_json>[1];

test("retries the identical request and honors numeric/date Retry-After minimums", async context => {
  context.mock.method(Math, "random", () => 0);
  const warnings : string[] = [];
  const logger = pino({}, {write : (line : string) => warnings.push(line)})
    .child({pipeline_name : "toast_orders", execution_id : "synthetic-execution", operation : "ingestion"});
  let calls = 0;
  let cancelled_bodies = 0;
  const requested_at : number[] = [];
  let date_retry_at = 0;
  const settings = {...request_settings, logger : logger, method : "POST", body : '{"synthetic":"login"}'} as const;
  context.mock.method(globalThis, "fetch", async (input : URL, options : RequestInit) => {
    calls++;
    requested_at.push(Date.now());
    assert.equal(input.href, request_url.href);
    assert.equal(options.method, settings.method);
    assert.equal(options.body, settings.body);
    assert.deepEqual(options.headers, settings.headers);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    if (calls === 3) return Response.json({complete : true}, {headers : {link : "synthetic-link"}});
    if (calls === 2) {
      date_retry_at = Math.floor(Date.now() / 1000) * 1000 + 2000;
    }
    return new Response(new ReadableStream({
      cancel() { cancelled_bodies++; }
    }), {
      status : calls === 1 ? 429 : 503,
      headers : {"retry-after" : calls === 1 ? "2" : new Date(date_retry_at).toUTCString()}
    });
  });

  assert.deepEqual((await request_toast_json(request_url, settings)).data, {complete : true});
  const [first_at, second_at, third_at] = requested_at;
  assert.ok(first_at !== undefined && second_at !== undefined && third_at !== undefined);
  assert.ok(second_at - first_at >= 2000, "Retried before the numeric Retry-After minimum.");
  assert.ok(third_at >= date_retry_at, "Retried before the HTTP-date Retry-After minimum.");
  assert.equal(cancelled_bodies, 2);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map(line => {
    const {event, source_operation, operation, execution_id, http_status, next_attempt, wait_ms} = JSON.parse(line);
    assert.ok(Number.isSafeInteger(wait_ms) && wait_ms > 0);
    return [event, source_operation, operation, execution_id, http_status, next_attempt];
  }), [
    ["source_request_retry", "location discovery", "ingestion", "synthetic-execution", 429, 2],
    ["source_request_retry", "location discovery", "ingestion", "synthetic-execution", 503, 3]
  ]);
  assert.ok(warnings.every(message =>
    !message.includes("synthetic-token") && !message.includes("example.com") && !message.includes("login")
  ));
});

test("retryable HTTP statuses stop after three attempts with increasing backoff", async context => {
  context.mock.method(Math, "random", () => 0);
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const requested_at : number[] = [];
    const fetch_mock = context.mock.method(globalThis, "fetch", async () => {
      calls++;
      requested_at.push(Date.now());
      return new Response(null, {status : status});
    });
    await assert.rejects(request_toast_json(request_url, request_settings), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 3);
    const [first_at, second_at, third_at] = requested_at;
    assert.ok(first_at !== undefined && second_at !== undefined && third_at !== undefined);
    assert.ok(second_at - first_at >= 500);
    assert.ok(third_at - second_at >= 1000);
    fetch_mock.mock.restore();
  }
});

test("permanent HTTP, invalid JSON, oversized bodies and excessive/invalid Retry-After fail without retry", async context => {
  const settings = {...request_settings, logger : {warn : () => assert.fail("A permanent error scheduled a retry.")}};
  const responses = [
    ...[400, 401, 403, 404, 501].map(status => () => new Response(null, {status : status})),
    () => new Response("not JSON"),
    () => Response.json({content : "x".repeat(1024)}),
    () => new Response(null, {status : 429, headers : {"retry-after" : "901"}}),
    () => new Response(null, {status : 429, headers : {"retry-after" : "0.5"}}),
    () => new Response(null, {status : 429, headers : {"retry-after" : "-1"}}),
    () => new Response(null, {status : 429, headers : {"retry-after" : "invalid"}})
  ];
  for (const create_response of responses) {
    let calls = 0;
    const fetch_mock = context.mock.method(globalThis, "fetch", async () => {
      calls++;
      return create_response();
    });
    await assert.rejects(request_toast_json(request_url, settings));
    assert.equal(calls, 1);
    fetch_mock.mock.restore();
  }
});

test("temporary connection and response-body failures retry without retrying unrelated errors", async context => {
  context.mock.method(Math, "random", () => 0);
  for (const stage of ["headers", "body"]) {
    let calls = 0;
    const fetch_mock = context.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls > 1) return Response.json({recovered : true});
      const error = Object.assign(new Error("Synthetic socket failure."), {code : "ECONNRESET"});
      if (stage === "headers") throw new TypeError("fetch failed", {cause : error});
      return new Response(new ReadableStream({
        pull(controller) { controller.error(error); }
      }));
    });
    assert.deepEqual((await request_toast_json(request_url, request_settings)).data, {recovered : true});
    assert.equal(calls, 2);
    fetch_mock.mock.restore();
  }
  const fetch_mock = context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Synthetic non-transport failure.");
  });
  await assert.rejects(request_toast_json(request_url, request_settings), /non-transport failure/);
  assert.equal(fetch_mock.mock.callCount(), 1);
});

test("request timeouts retry, while caller cancellation interrupts requests and retry waits", async context => {
  context.mock.method(Math, "random", () => 0);
  const timeout_controllers : AbortController[] = [];
  const timeout_mock = context.mock.method(AbortSignal, "timeout", (milliseconds : number) => {
    assert.equal(milliseconds, 20_000);
    const controller = new AbortController();
    timeout_controllers.push(controller);
    return controller.signal;
  });

  let calls = 0;
  let fetch_mock = context.mock.method(globalThis, "fetch", async (_input : URL, options : RequestInit) => {
    calls++;
    if (calls > 1) return Response.json({recovered : true});
    return new Promise<Response>((resolve_response, reject_response) => {
      options.signal?.addEventListener("abort", () => reject_response(options.signal?.reason), {once : true});
    });

  });
  const result = request_toast_json(request_url, request_settings);
  timeout_controllers[0]?.abort(new DOMException("Synthetic timeout.", "TimeoutError"));
  assert.deepEqual((await result).data, {recovered : true});
  fetch_mock.mock.restore();
  timeout_mock.mock.restore();

  for (const stage of ["request", "wait", "before"]) {
    const controller = new AbortController();
    calls = 0;
    fetch_mock = context.mock.method(globalThis, "fetch", async (_input : URL, options : RequestInit) => {
      calls++;
      if (stage === "wait") return new Response(null, {status : 503});
      return new Promise<Response>((resolve_response, reject_response) => {
        options.signal?.addEventListener("abort", () => reject_response(options.signal?.reason), {once : true});
      });
    });
    if (stage === "before") controller.abort();
    const rejected = assert.rejects(request_toast_json(request_url, {
      ...request_settings, signal : controller.signal
    }), {name : "AbortError"});
    await flush_promises();
    controller.abort();
    await rejected;
    assert.equal(calls, stage === "before" ? 0 : 1);
    fetch_mock.mock.restore();
  }
});

test("historical orders requests are spaced at least five seconds and waiting can be cancelled", async context => {
  const times : number[] = [];
  context.mock.method(globalThis, "fetch", async () => {
    times.push(Date.now());
    return Response.json({ok : true});
  });
  const settings = {...request_settings, operation : "orders"} as const;
  await request_toast_json(request_url, settings);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    request_toast_json(request_url, {...settings, signal : controller.signal}),
    {name : "AbortError"}
  );
  controller.abort();
  await cancelled;
  await request_toast_json(request_url, settings);
  assert.equal(times.length, 2);
  const [first_at, second_at] = times;
  assert.ok(first_at !== undefined && second_at !== undefined);
  assert.ok(second_at - first_at >= 5_000);
});

test("authentication rate limiting fails immediately without repeated logins", async context => {
  const fetch_mock = context.mock.method(globalThis, "fetch", async () =>
    new Response(null, {status : 429}));
  await assert.rejects(request_toast_json(request_url, {
    ...request_settings, operation : "authentication", method : "POST"
  }), /authentication: HTTP 429/);
  assert.equal(fetch_mock.mock.callCount(), 1);
});
