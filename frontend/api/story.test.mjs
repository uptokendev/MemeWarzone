import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://story-test:x@127.0.0.1:1/none";
const { cardSvg } = await import("./story.js");
const { accentsFromPixels, FALLBACK_ACCENTS } = await import("./lib/storyImages.js");
const story = JSON.parse(fs.readFileSync(new URL("../shared/fixtures/story-derpydave.json", import.meta.url), "utf8"));

test("the share card escapes coin text and carries name, ticker and hook", () => {
  const svg = cardSvg({ ...story, coin: { ...story.coin, name: "Dave <script>" } }, null);
  assert.ok(!svg.includes("<script>"));
  assert.match(svg, /DAVE &lt;SCRIPT&gt;/);
  assert.match(svg, /\$DERPYDAVE · SOLANA/);
  assert.match(svg, /went 5\.2x/);
  assert.ok(!svg.includes("Watch the story."), "the hook drops the call to action; the button says it");
});

test("colours come from the logo's vivid pixels, with a MemeWarzone fallback", () => {
  const yellow = Buffer.from(Array.from({ length: 30 }, () => [252, 241, 68]).flat());
  assert.equal(accentsFromPixels(yellow).accent, "#fcf144");
  assert.deepEqual(accentsFromPixels(Buffer.from([10, 10, 10, 200, 200, 200])), { ...FALLBACK_ACCENTS });
});

test("share links live outside /api and the story route is mounted", () => {
  const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /app\.get\("\/s\/:chainId\/:token", wrap\(storySharePage\)\)/);
  assert.match(server, /router\.all\(\/\^\\\/story\(\?:\\\/\.\*\)\?\$\/, wrap\(story\)\)/);
  assert.ok(server.indexOf('app.get("/s/:chainId/:token"') < server.indexOf('app.use("/api", router)'));
});

test("story writes are strict wallet-signed actions by the verified owner", () => {
  const src = fs.readFileSync(new URL("./story.js", import.meta.url), "utf8");
  assert.match(src, /action: "story_profile_update"[\s\S]*strict: true/);
  assert.match(src, /ownership_status === "ownership_verified"/);
});
