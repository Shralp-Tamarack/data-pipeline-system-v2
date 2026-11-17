import assert from "node:assert/strict";
import {test} from "node:test";
import {create_ingestion_windows} from "../core/system/ingestion-windows.ts";

test("defaults to seven days with consecutive boundaries and a shorter final window", () => {
  const windows = [...create_ingestion_windows(
    new Date("2026-11-01T00:00:00.000Z"),
    new Date("2026-11-16T12:00:00.000Z")
  )];

  assert.deepEqual(
    windows.map(window => ({
      start_at : window.start_at.toISOString(),
      end_at : window.end_at.toISOString()
    })),
    [
      {
        start_at : "2026-11-01T00:00:00.000Z",
        end_at : "2026-11-08T00:00:00.000Z"
      },
      {
        start_at : "2026-11-08T00:00:00.000Z",
        end_at : "2026-11-15T00:00:00.000Z"
      },
      {
        start_at : "2026-11-15T00:00:00.000Z",
        end_at : "2026-11-16T12:00:00.000Z"
      }
    ]
  );
});

test("accepts a pipeline override without adding a window at the exact end", () => {
  const windows = [...create_ingestion_windows(
    new Date("2026-11-01T00:00:00.000Z"),
    new Date("2026-11-01T01:00:00.000Z"),
    1 / 48
  )];

  assert.equal(windows.length, 2);
  assert.equal(
    windows[0]?.end_at.toISOString(),
    "2026-11-01T00:30:00.000Z"
  );
  assert.equal(
    windows[1]?.start_at.toISOString(),
    "2026-11-01T00:30:00.000Z"
  );
  assert.equal(
    windows[1]?.end_at.toISOString(),
    "2026-11-01T01:00:00.000Z"
  );
});

test("rounds fractional days to millisecond precision", () => {
  const windows = [...create_ingestion_windows(
    new Date("2026-11-01T00:00:00.000Z"),
    new Date("2026-11-01T00:00:22.000Z"),
    11 / 86_400
  )];

  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.end_at.toISOString(), "2026-11-01T00:00:11.000Z");
  assert.equal(windows[1]?.end_at.toISOString(), "2026-11-01T00:00:22.000Z");
});

test("an empty range produces no windows", () => {
  const timestamp = new Date("2026-11-01T00:00:00.000Z");

  assert.deepEqual(
    [...create_ingestion_windows(timestamp, timestamp)],
    []
  );
});

test("rejects invalid ranges and durations", () => {
  const start_at = new Date("2026-11-01T00:00:00.000Z");
  const end_at = new Date("2026-11-02T00:00:00.000Z");

  assert.throws(
    () => [...create_ingestion_windows(new Date("invalid"), end_at)],
    /valid dates/
  );

  assert.throws(
    () => [...create_ingestion_windows(start_at, new Date("invalid"))],
    /valid dates/
  );

  assert.throws(
    () => [...create_ingestion_windows(end_at, start_at)],
    /must not precede/
  );

  for (const days of [0, -1, NaN, Infinity, Number.MAX_VALUE, 1e-12]) {
    assert.throws(
      () => [...create_ingestion_windows(start_at, end_at, days)],
      /ingestion_window_days/
    );
  }
});