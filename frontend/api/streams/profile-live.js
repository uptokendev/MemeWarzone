import { json } from "../../server/http.js";
import { profileStreamFor } from "../../shared/profileStreams.mjs";
import { readKickLive } from "../lib/kickLive.js";

// GET /api/streams/profile-live?wallet=<address>
// { stream: null } for profiles without a stream; otherwise the channel and whether it is live.
// Only channels listed in shared/profileStreams.mjs are looked up, so this is not an open Kick proxy.
export default async function profileLive(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  const query = req.query || Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  const wallet = String(query.wallet ?? "").trim();
  const stream = profileStreamFor(wallet);
  res.setHeader("cache-control", "public, max-age=30");
  if (!stream) return json(res, 200, { stream: null });
  try {
    const status = await readKickLive(stream.channel);
    return json(res, 200, {
      stream: {
        platform: stream.platform,
        channel: stream.channel,
        live: status.live,
        title: status.title,
        viewers: status.viewers,
        startedAt: status.startedAt,
      },
    });
  } catch {
    return json(res, 200, { stream: { platform: stream.platform, channel: stream.channel, live: null, title: null, viewers: null, startedAt: null } });
  }
}
