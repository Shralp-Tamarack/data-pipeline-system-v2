import assert from "node:assert/strict";
import {test} from "node:test";
import {get_toast_next_page_number} from "../core/toast/toast-order-pagination.ts";

function create_request_url(): URL {
  const request_url = new URL("https://example.com/orders/v2/ordersBulk");
  request_url.searchParams.set("startDate", "2026-11-01T00:00:00.000Z");
  request_url.searchParams.set("endDate", "2026-11-02T00:00:00.000Z");
  request_url.searchParams.set("pageSize", "10");
  request_url.searchParams.set("page", "1");
  return request_url;
}

test("reads the next sequential page among other relations", () => {
  const request_url = create_request_url();
  const next_url = new URL(request_url);
  next_url.searchParams.set("page", "2");

  assert.equal(get_toast_next_page_number(
    request_url,
    `<${request_url.href}>; rel="self", <${next_url.href}>; rel="next"`
  ), 2);
});

test("finishes only when a valid header has no next relation or is absent", () => {
  const request_url = create_request_url();
  assert.equal(get_toast_next_page_number(request_url, null), null);
  assert.equal(get_toast_next_page_number(
    request_url,
    `<${request_url.href}>; rel="self"`
  ), null);
});

test("rejects changed targets, filters, duplicate parameters and repeated or skipped pages", () => {
  const request_url = create_request_url();
  const changes : Array<(url : URL) => void> = [
    url => { url.hostname = "other.example"; },
    url => { url.protocol = "http:"; },
    url => { url.pathname = "/another-endpoint"; },
    url => { url.username = "unexpected"; },
    url => { url.hash = "#unexpected"; },
    url => { url.searchParams.set("endDate", "2026-11-03T00:00:00.000Z"); },
    url => { url.searchParams.delete("startDate"); },
    url => { url.searchParams.append("pageSize", "10"); },
    url => { url.searchParams.append("page", "2"); },
    url => { url.searchParams.set("unexpected", "value"); },
    url => { url.searchParams.set("page", "1"); },
    url => { url.searchParams.set("page", "3"); },
    url => { url.searchParams.set("page", "0"); },
    url => { url.searchParams.set("page", "invalid"); },
    url => { url.searchParams.set("page", "9007199254740992"); }
  ];

  for (const change of changes) {
    const next_url = new URL(request_url);
    next_url.searchParams.set("page", "2");
    change(next_url);
    assert.throws(() => get_toast_next_page_number(
      request_url,
      `<${next_url.href}>; rel="next"`
    ));
  }
});

test("rejects malformed, empty and ambiguous headers", () => {
  const request_url = create_request_url();
  const next_url = new URL(request_url);
  next_url.searchParams.set("page", "2");
  const next_link = `<${next_url.href}>; rel="next"`;

  for (const header of ["", "malformed", `${next_link}, ${next_link}`]) {
    assert.throws(() => get_toast_next_page_number(request_url, header));
  }
});
