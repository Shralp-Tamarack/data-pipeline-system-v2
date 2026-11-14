export type Ingestion_Window = {
  start_at : Date;
  end_at : Date;
};

/** Yields consecutive source-time windows; does not fetch data or advance progress. */
export function* create_ingestion_windows(
  start_at : Date,
  end_at : Date,
  ingestion_window_hours : number = 24
): Generator<Ingestion_Window, void, unknown> {
  const start_timestamp = start_at.getTime();
  const end_timestamp = end_at.getTime();

  if (
    !Number.isFinite(start_timestamp) ||
    !Number.isFinite(end_timestamp)
  ) {
    throw new Error("Ingestion range requires valid dates.");
  }

  if (end_timestamp < start_timestamp) {
    throw new Error("Ingestion range end must not precede its start.");
  }

  const window_milliseconds = ingestion_window_hours * 3_600_000;

  if (
    !Number.isFinite(ingestion_window_hours) ||
    ingestion_window_hours <= 0 ||
    !Number.isSafeInteger(window_milliseconds) ||
    window_milliseconds < 1
  ) {
    throw new Error(
      "ingestion_window_hours must produce a positive whole-millisecond duration."
    );
  }

  let current_timestamp = start_timestamp;

  while (current_timestamp < end_timestamp) {
    const next_timestamp = Math.min(
      current_timestamp + window_milliseconds,
      end_timestamp
    );

    yield {
      start_at : new Date(current_timestamp),
      end_at : new Date(next_timestamp)
    };

    current_timestamp = next_timestamp;
  }
}