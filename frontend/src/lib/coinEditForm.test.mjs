import test from "node:test";
import assert from "node:assert/strict";
import { diffCoinProfile } from "./coinEditForm.mjs";

const stored = {
  bannerUrl: null, bio: null, founderNote: "old note", websiteUrl: null, xUrl: "https://x.com/k88", telegramUrl: null, discordUrl: null,
  tags: ["kaiju"], pinnedPostId: null, shareUpdatesToFeed: true, showAutoUpdates: true, sectionImages: {},
};
const formOf = (over = {}) => ({
  bannerUrl: "", bio: "", founderNote: "old note", websiteUrl: "", xUrl: "https://x.com/k88", telegramUrl: "", discordUrl: "",
  tags: "kaiju", pinnedPostId: "", shareUpdatesToFeed: true, showAutoUpdates: true, sectionImages: {}, ...over,
});

test("nothing touched → nothing sent", () => {
  assert.deepEqual(diffCoinProfile(stored, formOf()), {});
});

test("only the fields that changed are sent; clearing sends empty", () => {
  assert.deepEqual(diffCoinProfile(stored, formOf({ founderNote: " new ", xUrl: "" })), { founderNote: "new", xUrl: "" });
  assert.deepEqual(diffCoinProfile(stored, formOf({ tags: "Kaiju, monsters" })), { tags: ["kaiju", "monsters"] });
  assert.deepEqual(diffCoinProfile(stored, formOf({ showAutoUpdates: false })), { showAutoUpdates: false });
  assert.deepEqual(diffCoinProfile(stored, formOf({ sectionImages: { origin: "https://a/b.png" } })), { sectionImages: { origin: "https://a/b.png" } });
});

test("imported coins never send a bio (D4)", () => {
  assert.deepEqual(diffCoinProfile(stored, formOf({ bio: "hello" }), { imported: true }), {});
  assert.deepEqual(diffCoinProfile(stored, formOf({ bio: "hello" })), { bio: "hello" });
});
