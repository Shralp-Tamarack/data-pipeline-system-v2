import assert from "node:assert/strict";
import {test} from "node:test";
import {read_toast_json_response} from "../core/toast/toast-response.ts";

test("preserves JSON at the byte limit with UTF-8 split across chunks", async () => {
  const expected_record = {name : "caf\u00e9", nested : {source_field : "preserved"}};
  const encoded_record = new TextEncoder().encode(JSON.stringify(expected_record));
  const split_position = encoded_record.indexOf(0xc3) + 1;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded_record.slice(0, split_position));
      controller.enqueue(encoded_record.slice(split_position));
      controller.close();
    }
  }));

  assert.deepEqual(
    await read_toast_json_response(response, encoded_record.byteLength),
    expected_record
  );
  assert.equal(response.body?.locked, false);
});

test("rejects and cancels a body one byte over the limit", async () => {
  let was_cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      was_cancelled = true;
    }
  }));

  await assert.rejects(
    read_toast_json_response(response, 1),
    /exceeds the configured byte limit/
  );
  assert.equal(was_cancelled, true);
  assert.equal(response.body?.locked, false);
});

test("invalid JSON fails without including response contents", async () => {
  await assert.rejects(
    read_toast_json_response(new Response("synthetic_private_payload"), 100),
    {
      name : "Error",
      message : "Toast response contains invalid JSON."
    }
  );
});

test("rejects absent bodies and invalid byte limits", async () => {
  await assert.rejects(
    read_toast_json_response(new Response(null), 100),
    /has no body/
  );

  for (const max_response_bytes of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(
      read_toast_json_response(new Response("{}"), max_response_bytes),
      /must be a positive safe integer/
    );
  }
});
