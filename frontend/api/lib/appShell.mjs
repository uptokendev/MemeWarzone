// Fetches the live app shell (built index.html of app.memewar.zone).
// Never use a local dist/index.html: every app redeploy renames the hashed
// assets and deletes the old ones, so a stale shell would reference deleted files.
// Every get() revalidates with a conditional GET; failures return the last good body.

const isValidShell = (body) =>
  typeof body === "string" && body.includes("<head") && body.includes('<div id="root"></div>');

export function createAppShell({
  url = process.env.APP_SHELL_URL || "https://app.memewar.zone/index.html",
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
  now = Date.now,
} = {}) {
  let body = null;
  let etag = null;
  let lastModified = null;
  let checkedAt = 0;
  let inflight = null;

  async function revalidate() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {};
      if (body && etag) headers["If-None-Match"] = etag;
      if (body && lastModified) headers["If-Modified-Since"] = lastModified;
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 304 && body) {
        checkedAt = now();
      } else if (res.status === 200) {
        const text = await res.text();
        if (isValidShell(text)) {
          body = text;
          etag = res.headers.get("etag") || null;
          lastModified = res.headers.get("last-modified") || null;
          checkedAt = now();
        }
      }
    } catch {
      // timeout or network error: keep the last good body
    } finally {
      clearTimeout(timer);
    }
    return body;
  }

  async function get() {
    if (!inflight) {
      inflight = revalidate().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return { get };
}
