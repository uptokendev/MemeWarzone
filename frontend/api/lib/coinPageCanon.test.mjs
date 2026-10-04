import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutoUpdates,
  coinImagePath,
  normalizeTags,
  parseImageSlot,
  profileFromRow,
  socialUrlOrEmpty,
  validateCoinPostInput,
  validateCoinProfileInput,
} from "./coinPageCanon.js";

test("links: https only, shorthand handles expand, junk refused", () => {
  assert.equal(socialUrlOrEmpty("x", "@kaiju88"), "https://x.com/kaiju88");
  assert.equal(socialUrlOrEmpty("telegram", "t.me/kaiju88"), "https://t.me/kaiju88");
  assert.equal(socialUrlOrEmpty("discord", "discord.gg/abc"), "https://discord.gg/abc");
  assert.equal(socialUrlOrEmpty("website", "kaiju88.xyz"), "https://kaiju88.xyz/");
  assert.equal(socialUrlOrEmpty("website", "http://kaiju88.xyz"), null);
  assert.equal(socialUrlOrEmpty("website", "javascript:alert(1)"), null);
  assert.equal(socialUrlOrEmpty("website", ""), "");
});

test("tags: lowercase, deduped, at most 5", () => {
  assert.deepEqual(normalizeTags("Kaiju, monsters,  community , kaiju"), ["kaiju", "monsters", "community"]);
  assert.equal(normalizeTags(["a", "b", "c", "d", "e", "f"]), null);
  assert.equal(normalizeTags(["<script>"]), null);
  assert.deepEqual(normalizeTags(""), []);
});

test("profile: only sent fields are written; empty clears", () => {
  const r = validateCoinProfileInput({ founderNote: "  The only monster that eats red candles.  ", xUrl: "" }, "launched");
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { founder_note: "The only monster that eats red candles.", x_url: null });
  assert.equal("bio" in r.values, false);
});

test("profile: bio is for launched coins; imported coins use the project details (D4)", () => {
  assert.equal(validateCoinProfileInput({ bio: "hello" }, "launched").values.bio, "hello");
  assert.equal(validateCoinProfileInput({ bio: "hello" }, "imported").code, "COIN_BIO_IMPORTS_USE_PROJECT");
  assert.equal(validateCoinProfileInput({ bio: "" }, "imported").values.bio, null);
  assert.equal(validateCoinProfileInput({ bio: "x".repeat(1201) }, "launched").code, "COIN_BIO_TOO_LONG");
});

test("profile: limits and types", () => {
  assert.equal(validateCoinProfileInput({ founderNote: "x".repeat(141) }, "launched").code, "COIN_NOTE_TOO_LONG");
  assert.equal(validateCoinProfileInput({ showAutoUpdates: "yes" }, "launched").code, "COIN_TOGGLE_INVALID");
  assert.equal(validateCoinProfileInput({ pinnedPostId: "1; drop" }, "launched").code, "COIN_PIN_INVALID");
  assert.equal(validateCoinProfileInput({ sectionImages: { secret: "https://a.b/c.png" } }, "launched").code, "COIN_SECTION_UNKNOWN");
  assert.deepEqual(validateCoinProfileInput({ sectionImages: { origin: "https://a.b/c.png", next: "" } }, "launched").values.section_images, { origin: "https://a.b/c.png" });
  assert.equal(validateCoinProfileInput({}, "launched").code, "COIN_PROFILE_EMPTY");
});

test("posts: 1..280 characters, https image, share defaults on", () => {
  assert.equal(validateCoinPostInput({ body: "  " }).code, "COIN_POST_EMPTY");
  assert.equal(validateCoinPostInput({ body: "x".repeat(281) }).code, "COIN_POST_TOO_LONG");
  // Founder 2026-10-04: up to 4 images per update; media_urls is empty for a post without extra images.
  assert.deepEqual(validateCoinPostInput({ body: " gm " }).values, { body: "gm", media_url: null, media_urls: [], share_to_feed: true });
  assert.equal(validateCoinPostInput({ body: "gm", shareToFeed: false }).values.share_to_feed, false);
  assert.equal(validateCoinPostInput({ body: "gm", mediaUrl: "http://x.y/z.png" }).code, "COIN_LINK_INVALID");
  const four = ["https://a.b/1.png", "https://a.b/2.png", "https://a.b/3.png", "https://a.b/4.png"];
  assert.deepEqual(validateCoinPostInput({ body: "gm", mediaUrls: four }).values.media_urls, four);
  assert.equal(validateCoinPostInput({ body: "gm", mediaUrls: four }).values.media_url, four[0]);
  assert.equal(validateCoinPostInput({ body: "gm", mediaUrls: [...four, "https://a.b/5.png"] }).code, "COIN_POST_IMAGES");
});

test("image slots and storage path", () => {
  assert.equal(parseImageSlot("banner"), "banner");
  assert.equal(parseImageSlot("section:origin"), "section:origin");
  assert.equal(parseImageSlot("section:nope"), null);
  assert.equal(parseImageSlot("../x"), null);
  assert.equal(
    coinImagePath({ chainId: 101, token: "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77", slot: "section:origin", uuid: "u1", ext: "png" }),
    "coin-pages/101/4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77/section-origin-u1.png",
  );
});

test("profile row defaults: toggles on, empty collections", () => {
  const p = profileFromRow(null);
  assert.equal(p.showAutoUpdates, true);
  assert.equal(p.shareUpdatesToFeed, true);
  assert.deepEqual(p.tags, []);
  assert.deepEqual(p.sectionImages, {});
  assert.equal(profileFromRow({ show_auto_updates: false }).showAutoUpdates, false);
});

test("auto updates come from existing facts, newest first", () => {
  const list = buildAutoUpdates({
    launchedAt: "2026-09-25T13:57:27Z",
    graduatedAt: null,
    battles: [{ id: "arena-1", at: "2026-09-27T10:00:00Z", won: true, rivalTicker: "$ASK", mode: "vote" }],
  });
  assert.deepEqual(list.map((x) => x.kind), ["battle", "launch"]);
  assert.equal(list[0].text, "Won the vote battle against $ASK.");
  assert.deepEqual(buildAutoUpdates({}), []);
});

test("images must be this coin's own uploads", async () => {
  const { isOwnCoinImage } = await import("./coinPageCanon.js");
  const ctx = { storageBase: "https://abc.supabase.co", chainId: 101, token: "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77" };
  const good = "https://abc.supabase.co/storage/v1/object/public/MEMEBATTLES/coin-pages/101/4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77/banner-u.png";
  assert.equal(isOwnCoinImage(good, ctx), true);
  assert.equal(isOwnCoinImage(good.replace("/101/", "/56/"), ctx), false);
  assert.equal(isOwnCoinImage("https://evil.example/coin-pages/101/x/banner.png", ctx), false);
  assert.equal(isOwnCoinImage(good.replace("banner-u.png", "../../other/x.png"), ctx), false);
  assert.equal(isOwnCoinImage(good, { ...ctx, storageBase: "" }), false);
});
