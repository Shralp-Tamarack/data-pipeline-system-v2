/** Validates Toast's documented Link format and returns the next sequential page. */
export function get_toast_next_page_number(
  request_url : URL,
  link_header : string | null
): number | null {
  if (link_header === null) {
    return null;
  }

  if (!link_header.trim()) {
    throw new Error("Toast returned an empty pagination header.");
  }

  let next_url : URL | undefined;

  for (const link of link_header.split(/,\s*(?=<)/)) {
    const match = link.trim().match(
      /^<([^<>]+)>\s*;\s*rel=(?:"([^"]+)"|([a-z]+))\s*$/i
    );

    if (!match) {
      throw new Error("Toast returned an unsupported pagination header.");
    }

    const relations = (match[2] ?? match[3] ?? "").split(/\s+/);

    if (!relations.includes("next")) {
      continue;
    }

    if (next_url) {
      throw new Error("Toast returned multiple next-page links.");
    }

    const next_reference = match[1];

    if (!next_reference || !URL.canParse(next_reference, request_url)) {
      throw new Error("Toast returned an invalid next-page URL.");
    }

    next_url = new URL(next_reference, request_url);
  }

  if (!next_url) {
    return null;
  }

  if (
    next_url.protocol !== "https:" ||
    next_url.origin !== request_url.origin ||
    next_url.pathname !== request_url.pathname ||
    next_url.username ||
    next_url.password ||
    next_url.hash
  ) {
    throw new Error("Toast next-page URL changed the permitted request target.");
  }

  const current_page_text = request_url.searchParams.get("page");
  const next_page_text = next_url.searchParams.get("page");

  if (
    !current_page_text ||
    !next_page_text ||
    !/^[1-9]\d*$/.test(current_page_text) ||
    !/^[1-9]\d*$/.test(next_page_text) ||
    next_url.searchParams.getAll("page").length !== 1
  ) {
    throw new Error("Toast returned an invalid next-page number.");
  }

  const current_page = Number(current_page_text);
  const next_page = Number(next_page_text);

  if (
    !Number.isSafeInteger(current_page) ||
    !Number.isSafeInteger(next_page) ||
    next_page !== current_page + 1
  ) {
    throw new Error("Toast pagination did not advance by one page.");
  }

  for (const [name, value] of request_url.searchParams) {
    if (name === "page") {
      continue;
    }

    const next_values = next_url.searchParams.getAll(name);

    if (next_values.length !== 1 || next_values[0] !== value) {
      throw new Error("Toast next-page URL changed the extraction filters.");
    }
  }

  for (const name of next_url.searchParams.keys()) {
    if (!request_url.searchParams.has(name)) {
      throw new Error("Toast next-page URL added an unexpected parameter.");
    }
  }

  return next_page;
}