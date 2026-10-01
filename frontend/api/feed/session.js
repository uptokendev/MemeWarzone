import { badMethod, json, readJson } from "../../server/http.js";
import { pool } from "../../server/db.js";
import { createFeedSessionAuth } from "../lib/feedSessionAuth.js";

const auth = createFeedSessionAuth({ pool });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return badMethod(res);
    if (!req.body || typeof req.body !== "object") {
      req.body = await readJson(req);
    }
    const opened = await auth.openSession(req, res);
    if (!opened) return;
    return json(res, 200, opened);
  } catch (e) {
    console.error("[api/feed/session]", e);
    if (e?.code === "42P01" || e?.code === "42703") {
      return json(res, 503, { error: "Feed session is not migrated yet", code: "FEED_SESSION_UNAVAILABLE" });
    }
    return json(res, 500, { error: "Server error" });
  }
}
