/** Reads bounded JSON without exposing response contents in parse errors. Callers own request timeouts. */
export async function read_toast_json_response(
  response : Response,
  max_response_bytes : number
): Promise<unknown> {
  if (!Number.isSafeInteger(max_response_bytes) || max_response_bytes <= 0) {
    throw new Error("Toast response byte limit must be a positive safe integer.");
  }

  if (!response.body) {
    throw new Error("Toast response has no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let response_bytes = 0;
  let response_text = "";

  try {
    while (true) {
      const {value, done} = await reader.read();

      if (done) break;

      response_bytes += value.byteLength;

      if (response_bytes > max_response_bytes) {
        await reader.cancel();
        throw new Error("Toast response exceeds the configured byte limit.");
      }

      response_text += decoder.decode(value, {stream : true});
    }

    response_text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(response_text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Toast response contains invalid JSON.");
    }

    throw error;
  }
}