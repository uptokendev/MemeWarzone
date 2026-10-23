import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLlmsFullTxt, buildLlmsTxt } from "./llmsTxt.mjs";

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("public/llms.txt and llms-full.txt match the content modules (run scripts/generate-llms.mjs)", () => {
  assert.equal(read("llms.txt"), buildLlmsTxt());
  assert.equal(read("llms-full.txt"), buildLlmsFullTxt());
});

test("llms.txt follows the llmstxt.org shape and has no dashes as punctuation", () => {
  const t = buildLlmsTxt();
  assert.match(t, /^# MemeWarzone\n\n> /);
  assert.match(t, /\n## Key pages\n/);
  assert.doesNotMatch(t + buildLlmsFullTxt(), /[–—]/);
});
