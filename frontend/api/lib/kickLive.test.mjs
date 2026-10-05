import test from "node:test";
import assert from "node:assert/strict";
import { createKickLiveReader, parseOfficialChannel, parsePublicLivestream } from "./kickLive.js";
import { profileStreamFor, isKickChannelSlug } from "../../shared/profileStreams.mjs";

const DERPY = "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv";
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("only listed profiles have a stream; Solana keys are case-sensitive", () => {
  assert.deepEqual(profileStreamFor(DERPY), { platform: "kick", channel: "derpycryptoshillz" });
  assert.equal(profileStreamFor(DERPY.toLowerCase()), null);
  assert.equal(profileStreamFor("0x0000000000000000000000000000000000000001"), null);
  assert.equal(profileStreamFor(""), null);
  assert.equal(isKickChannelSlug("derpycryptoshillz"), true);
  assert.equal(isKickChannelSlug("../api"), false);
});

test("public endpoint: data null is offline, data object is live", () => {
  assert.equal(parsePublicLivestream({ data: null }).live, false);
  const live = parsePublicLivestream({ data: { session_title: "gm", viewers: 42, created_at: "2026-10-06 12:00:00" } });
  assert.deepEqual(live, { live: true, title: "gm", viewers: 42, startedAt: "2026-10-06 12:00:00" });
});

test("official endpoint reads stream.is_live", () => {
  const body = { data: [{ slug: "derpycryptoshillz", stream_title: "gm", stream: { is_live: true, viewer_count: 7, start_time: "t" } }] };
  assert.deepEqual(parseOfficialChannel(body, "derpycryptoshillz"), { live: true, title: "gm", viewers: 7, startedAt: "t" });
  body.data[0].stream.is_live = false;
  assert.equal(parseOfficialChannel(body, "derpycryptoshillz").live, false);
});

test("caches for the TTL and shares one request between concurrent callers", async () => {
  let t = 0;
  let calls = 0;
  const read = createKickLiveReader({ env: {}, now: () => t, fetchImpl: async () => { calls += 1; return reply(200, { data: null }); } });
  const [a, b] = await Promise.all([read("derpycryptoshillz"), read("derpycryptoshillz")]);
  assert.equal(calls, 1);
  assert.equal(a.live, false);
  assert.equal(b.live, false);
  t = 59_000; await read("derpycryptoshillz"); assert.equal(calls, 1);
  t = 61_000; await read("derpycryptoshillz"); assert.equal(calls, 2);
});

test("a Kick failure is unknown (live null), not offline", async () => {
  const read = createKickLiveReader({ env: {}, fetchImpl: async () => reply(403, {}) });
  const r = await read("derpycryptoshillz");
  assert.equal(r.live, null);
});

test("with credentials it fetches an app token once and uses the official API", async () => {
  const urls = [];
  const read = createKickLiveReader({
    env: { KICK_CLIENT_ID: "id", KICK_CLIENT_SECRET: "secret" },
    ttlMs: 0,
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (String(url).startsWith("https://id.kick.com")) return reply(200, { access_token: "tok", expires_in: 3600 });
      assert.equal(init.headers.authorization, "Bearer tok");
      return reply(200, { data: [{ slug: "derpycryptoshillz", stream: { is_live: true, viewer_count: 3 } }] });
    },
  });
  assert.equal((await read("derpycryptoshillz")).live, true);
  await read("derpycryptoshillz");
  assert.equal(urls.filter((u) => u.startsWith("https://id.kick.com")).length, 1);
});

test("rejects slugs that are not Kick channel names", async () => {
  const read = createKickLiveReader({ env: {}, fetchImpl: async () => reply(200, { data: null }) });
  await assert.rejects(() => read("a/b"));
});
