/**
 * GET /api/launch-status -> { canary: boolean }
 * Tells the web whether creation is limited to the launch team. Never returns the wallet list.
 */
import { json, badMethod } from "../server/http.js";
import { isCreateCanaryActive } from "./lib/createCanary.js";

export function createLaunchStatusHandler({ env = process.env } = {}) {
  return async function launchStatus(req, res) {
    if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
    res.setHeader?.("cache-control", "no-store");
    return json(res, 200, { canary: isCreateCanaryActive(env) });
  };
}

export default createLaunchStatusHandler();
