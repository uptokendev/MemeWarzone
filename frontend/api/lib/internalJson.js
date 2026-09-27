/**
 * Calls one of our own route handlers in-process and returns its JSON body, so a feature that needs
 * "what the app shows" (league standings, featured votes, campaign cards) reads the exact same
 * answer instead of re-implementing the query. GET only; never used for writes.
 */
export async function callJson(handler, path, query = {}) {
  const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const url = `${path}${search.toString() ? `?${search}` : ""}`;
  let body = "";
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { body = JSON.stringify(value); this.headersSent = true; return this; },
    send(value) { body = typeof value === "string" ? value : JSON.stringify(value); this.headersSent = true; return this; },
    write(chunk) { body += String(chunk); return true; },
    end(chunk) { if (chunk != null) body += String(chunk); this.headersSent = true; return this; },
  };
  const req = { method: "GET", url, path, originalUrl: url, query: Object.fromEntries(search), headers: {}, get: () => undefined };
  await handler(req, res);
  if (res.statusCode >= 400) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
