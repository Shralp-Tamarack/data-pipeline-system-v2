export type Ingestion_Window = {
  start_at : Date;
  end_at : Date;
};

export const default_ingestion_window_days = 7;

/** Yields consecutive windows of seven elapsed days by default; the final window can be shorter. */
export function* create_ingestion_windows(
  start_at : Date,
  end_at : Date,
  ingestion_window_days : number = default_ingestion_window_days
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

  const window_milliseconds = Math.round(ingestion_window_days * 86_400_000);

  if (
    !Number.isFinite(ingestion_window_days) ||
    ingestion_window_days <= 0 ||
    !Number.isSafeInteger(window_milliseconds) ||
    window_milliseconds < 1
  ) {
    throw new Error(
      "ingestion_window_days must be positive and round to at least one millisecond."
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