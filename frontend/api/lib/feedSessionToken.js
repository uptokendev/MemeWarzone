import crypto from "node:crypto";

export const FEED_SESSION_ACTION = "feed_open_session";
export const FEED_SESSION_SCOPE = "Scope: post,fire,repost,reply,comment";

export function hashFeedSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function createFeedSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}
