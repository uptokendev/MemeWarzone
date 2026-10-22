import test from "node:test";
import assert from "node:assert/strict";
import { HELP_ARTICLES, HELP_TOPICS, helpArticlesForTopic, helpHead, helpJsonLd, searchHelp, helpAnswerText } from "./helpContent.mjs";

const TOPIC_IDS = new Set(HELP_TOPICS.map((t) => t.id));
const LEGACY = new Set(["wallets", "create", "trading", "rewards", "community", "recruiters", "safety"]);

test("every article is well formed", () => {
  const seen = new Set();
  for (const a of HELP_ARTICLES) {
    assert.match(a.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, a.slug);
    assert.ok(a.slug.length <= 64, a.slug);
    assert.ok(!seen.has(a.slug), `duplicate slug ${a.slug}`);
    assert.ok(!TOPIC_IDS.has(a.slug), `slug equals a topic id: ${a.slug}`);
    seen.add(a.slug);
    assert.ok(a.q && a.q.trim().length >= 8, a.slug);
    assert.ok(Array.isArray(a.a) && a.a.length >= 1, `${a.slug} has no answer`);
    assert.ok(Array.isArray(a.sources) && a.sources.length >= 1, `${a.slug} has no sources`);
    assert.ok(Array.isArray(a.keywords), `${a.slug} keywords`);
    for (const t of a.alsoIn || []) assert.ok(TOPIC_IDS.has(t), `${a.slug} alsoIn ${t}`);
    for (const l of a.links || []) assert.match(l.href, /^(\/$|\/[a-z0-9]|https:\/\/|mailto:)/, `${a.slug} link ${l.href}`);
  }
});

test("copy rules: no dashes as punctuation, no markdown", () => {
  for (const a of HELP_ARTICLES) {
    const text = [a.q, ...a.a, ...(a.steps || []), ...(a.bullets || []), ...(a.links || []).map((l) => l.text)].join(" ");
    assert.doesNotMatch(text, /[–—]/, a.slug);
    assert.doesNotMatch(text, /\*\*|\]\(|^#/m, a.slug);
  }
});

test("topics map to Command Center categories and have articles", () => {
  for (const t of HELP_TOPICS) assert.ok(LEGACY.has(t.legacy), t.id);
  assert.equal(TOPIC_IDS.size, HELP_TOPICS.length);
});

test("head, JSON-LD and search", () => {
  const first = HELP_ARTICLES[0];
  if (!first) return;
  const head = helpHead(first.slug);
  assert.equal(head.kind, "article");
  assert.ok(head.description.length <= 160, head.description);
  const ld = helpJsonLd(head);
  assert.equal(ld[0]["@type"], "FAQPage");
  assert.equal(ld[0].mainEntity[0].name, first.q);
  assert.equal(ld[0].mainEntity[0].acceptedAnswer.text, helpAnswerText(first));
  assert.equal(helpHead("no-such-answer-anywhere"), null);
  assert.equal(helpHead(HELP_TOPICS[0].id).kind, "topic");
  assert.ok(helpArticlesForTopic(first.topic).some((a) => a.slug === first.slug));
  assert.equal(searchHelp(first.q)[0].slug, first.slug, "a question finds itself first");
  assert.deepEqual(searchHelp("   "), []);
});
