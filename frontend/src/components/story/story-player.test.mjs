import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STORY_CHAPTER_KINDS } from "../../../shared/storyContract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const storyDir = here;
const appPath = path.join(here, "../../App.tsx");
const registryPath = path.join(here, "sceneRegistry.ts");
const playerPath = path.join(here, "StoryPlayer.tsx");
const fitPath = path.join(here, "fitSlide.ts");
const fullPath = path.join(here, "FullStoryPage.tsx");
const callPath = path.join(here, "scenes/CallScene.tsx");
const sharePath = path.join(here, "ShareSheet.tsx");

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = walk(storyDir).filter((f) => !f.endsWith(".test.mjs"));
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const all = Object.values(sources).join("\n");

test("every kind in STORY_CHAPTER_KINDS has an entry in sceneRegistry.ts", () => {
  const registry = fs.readFileSync(registryPath, "utf8");
  for (const kind of STORY_CHAPTER_KINDS) {
    assert.match(registry, new RegExp(`\\b${kind}\\s*:`), kind);
  }
});

test("no file under components/story/ contains dangerouslySetInnerHTML or innerHTML", () => {
  for (const [file, src] of Object.entries(sources)) {
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
    assert.doesNotMatch(src, /\.innerHTML/);
    assert.ok(!file.includes("unused"));
  }
});

test("StoryPlayer.tsx handles Escape, ArrowLeft, ArrowRight, and visibilitychange", () => {
  const src = fs.readFileSync(playerPath, "utf8");
  assert.match(src, /Escape/);
  assert.match(src, /ArrowLeft/);
  assert.match(src, /ArrowRight/);
  assert.match(src, /visibilitychange/);
});

test("the fit logic exists (scrollWidth/clientWidth and scrollHeight/clientHeight)", () => {
  const src = fs.readFileSync(fitPath, "utf8");
  assert.match(src, /function fitSlide/);
  assert.match(src, /scrollWidth/);
  assert.match(src, /clientWidth/);
  assert.match(src, /scrollHeight/);
  assert.match(src, /clientHeight/);
});

test("App.tsx registers /story/:chainId/:token", () => {
  const src = fs.readFileSync(appPath, "utf8");
  assert.match(src, /\/story\/:chainId\/:token/);
});

test("no em dash (U+2014) in any file under components/story/", () => {
  for (const [file, src] of Object.entries(sources)) {
    assert.ok(!src.includes("\u2014"), file);
  }
});

test("FullStoryPage.tsx renders section.heading / section.body through emphasisParts", () => {
  const src = fs.readFileSync(fullPath, "utf8");
  assert.match(src, /emphasisParts/);
  assert.match(src, /section\.heading/);
  assert.match(src, /section\.body/);
  const call = fs.readFileSync(callPath, "utf8");
  assert.match(call, /Read the full story/);
  assert.match(call, /story\.fullStory/);
  assert.ok(call.indexOf("story.fullStory") < call.indexOf("Read the full story"));
});

test("the share sheet builds X and Telegram links from share.url / share.text only", () => {
  const src = fs.readFileSync(sharePath, "utf8");
  assert.match(src, /x\.com\/intent\/post/);
  assert.match(src, /t\.me\/share\/url/);
  assert.match(src, /share\.text/);
  assert.match(src, /share\.url/);
  const hosts = [...all.matchAll(/https:\/\/([a-z0-9.-]+)\/share/gi)].map((m) => m[1]);
  const extra = hosts.filter((h) => h !== "x.com" && h !== "t.me");
  assert.deepEqual(extra, []);
  assert.doesNotMatch(all, /twitter\.com\/intent/);
  assert.doesNotMatch(all, /facebook\.com/);
  assert.doesNotMatch(all, /wa\.me/);
});
