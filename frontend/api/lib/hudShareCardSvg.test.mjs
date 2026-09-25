import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hudShareCardSvg, presentHudShareMetrics } from "./hudShareCardSvg.mjs";
import { tokenSharePayload } from "../token-share-card.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Prepare cards still render soldiers / heat / built-by by default", () => {
  const data = {
    name: "Alpha",
    ticker: "ALPHA",
    chain: "BNB CHAIN",
    status: "DRAFT",
    recruits: "12",
    heat: "40%",
    creator: "0xABCD",
    link: "app.memewar.zone/prepare/alpha",
  };
  assert.deepEqual(presentHudShareMetrics(data).map((row) => row.label), ["SOLDIERS FOLLOWS", "HEAT", "BUILT BY"]);
  const svg = hudShareCardSvg(data);
  assert.match(svg, /<svg width="1002"/);
  assert.match(svg, /clipPath id="logoClip"/);
});

test("Token cards swap the metric row to MCAP, HOLDERS, VOLUME", () => {
  const payload = tokenSharePayload({
    name: "Derpy Dave",
    ticker: "DERPYDAVE",
    chain: "SOLANA",
    status: "LIVE",
    mcap: "$59.8K",
    holders: "159",
    volume: "$12.7",
    link: "app.memewar.zone/token/abc",
  });
  assert.deepEqual(presentHudShareMetrics(payload).map((row) => row.label), ["MCAP", "HOLDERS", "VOLUME"]);
  assert.equal(presentHudShareMetrics(payload)[0].value, "$59.8K");
  const svg = hudShareCardSvg(payload);
  assert.match(svg, /<svg width="1002"/);
  assert.equal(payload.right.label, "TOKEN PAGE");
});

test("Prepare handler still uses the shared HUD renderer", () => {
  const src = fs.readFileSync(path.join(here, "../prepare-share-card.js"), "utf8");
  assert.match(src, /hudShareCardSvg/);
  assert.match(src, /embedShareCardImage/);
});

test("share-card image fetch refuses private, internal and credentialed URLs", async () => {
  const { assertPublicImageUrl, isPrivateAddress } = await import("./hudShareCardSvg.mjs");
  const publicDns = async () => [{ address: "104.18.1.1" }];
  const privateDns = async () => [{ address: "10.0.0.7" }];
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:3000/a.png",
    "http://[::1]/a.png",
    "http://metadata.google.internal/",
    "http://user:pw@example.com/a.png",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(() => assertPublicImageUrl(url, publicDns), url);
  }
  await assert.rejects(() => assertPublicImageUrl("https://cdn.example.com/a.png", privateDns));
  await assertPublicImageUrl("https://cdn.example.com/a.png", publicDns);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});
