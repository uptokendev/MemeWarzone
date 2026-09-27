import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { STORY_MAX_CHAPTERS, emphasisParts, validateStory } from "./storyContract.mjs";

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("both reference stories satisfy the contract", () => {
  assert.deepEqual(validateStory(fixture("story-k88.json")), []);
  assert.deepEqual(validateStory(fixture("story-derpydave.json")), []);
  assert.equal(fixture("story-k88.json").chapters.length, STORY_MAX_CHAPTERS.launched);
  assert.equal(fixture("story-derpydave.json").chapters.length, STORY_MAX_CHAPTERS.imported);
});

test("markup and unsafe links are refused, never rendered", () => {
  const story = fixture("story-derpydave.json");
  story.chapters[1].title = "<img src=x onerror=alert(1)>";
  story.chapters[story.chapters.length - 1].ctas[0].href = "javascript:alert(1)";
  const problems = validateStory(story);
  assert.ok(problems.some((p) => /title must be plain text/.test(p)));
  assert.ok(problems.some((p) => /safe hrefs/.test(p)));
});

test("an imported coin cannot exceed 8 chapters, and cover/call bracket the story", () => {
  const story = fixture("story-derpydave.json");
  story.chapters.splice(1, 0, { ...story.chapters[1], id: "extra" });
  assert.ok(validateStory(story).some((p) => /at most 8/.test(p)));
  const noCall = fixture("story-k88.json");
  noCall.chapters.pop();
  assert.ok(validateStory(noCall).some((p) => /last chapter is the call/.test(p)));
});

test("copy in the reference stories has no em dashes", () => {
  for (const name of ["story-k88.json", "story-derpydave.json"]) assert.ok(!fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").includes("—"), name);
});

test("emphasis becomes text parts, never HTML", () => {
  assert.deepEqual(emphasisParts("Today *$61.4K*, down."), [{ em: false, text: "Today " }, { em: true, text: "$61.4K" }, { em: false, text: ", down." }]);
  assert.deepEqual(emphasisParts("<b>x</b>"), [{ em: false, text: "<b>x</b>" }]);
});
