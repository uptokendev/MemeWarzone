/**
 * Story Mode contract, v1 (2026-09-28). The ONE shape shared by the API (`GET /api/story`) and the
 * player (`frontend/src/components/story/*`). Both sides import this file; the fixtures in
 * `shared/fixtures/story-*.json` are real stories in this shape and are what the player is built on
 * until the endpoint is live.
 *
 * Rules that make it safe and consistent:
 *   - Text fields are PLAIN strings. The only markup is *emphasis* (single asterisks). Never HTML: the
 *     player renders text as text, so a creator can never inject markup or links.
 *   - Links only appear as `href` on `call` buttons, `txUrl` on trades, and are built by the server
 *     (our own pages, the chain explorer, or the socials the owner saved). Never from free text.
 *   - A chapter exists only when its facts exist. The server omits it otherwise; the player never
 *     shows an empty chapter.
 *   - Launched coins: at most 10 chapters. Imported coins: at most 8 (founder, 2026-09-27).
 */

export const STORY_CONTRACT_VERSION = 1;
export const STORY_MAX_CHAPTERS = { launched: 10, imported: 8 };

/** Every chapter kind the player must render. */
export const STORY_CHAPTER_KINDS = Object.freeze([
  "cover",     // title slam + logo (animated if the logo is) + kicker + optional quote
  "text",      // creator prose; style: words | sonar | candle | plain
  "warcry",    // up to 3 short lines that stomp in, screen shake
  "moment",    // a dated event: date, big clock time, title, sub, optional seal
  "counts",    // 1-3 big numbers that count up
  "trades",    // 1-2 notable trades (first buy, biggest buy)
  "clan",      // one dot per wallet: holding vs exited
  "progress",  // graduation progress bar + optional "who dares?" versus
  "chart",     // market-cap line with low and high pins
  "battle",    // two fighters, winner lit, loser knocked
  "standing",  // rank rows (league, featured, ...)
  "call",      // closing buttons
]);

export const STORY_TEXT_STYLES = Object.freeze(["words", "sonar", "candle", "plain"]);

/**
 * @typedef {{ name: string, ticker: string, chainId: number, chainLabel: string,
 *   origin: "launched" | "imported", logoUrl: string, logoAnimated: boolean,
 *   accent: string, accent2: string, tokenPath: string }} StoryCoin
 * @typedef {{ id: string, kind: string, voice: "creator" | "chronicle", stamp: string, durationMs: number }} ChapterBase
 * @typedef {{ version: 1, chainId: number, token: string, generatedAt: string, coin: StoryCoin, chapters: Array<ChapterBase & Record<string, unknown>> }} StoryResponse
 */

const HEX = /^#[0-9a-f]{6}$/i;
const isText = (v) => typeof v === "string" && !/[<>]/.test(v);
const isOptText = (v) => v == null || isText(v);

/**
 * Validates a story against this contract. Returns a list of problems (empty = valid). Used by the API
 * before it serves a story and by the tests that pin the fixtures.
 */
export function validateStory(story) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(story?.version === STORY_CONTRACT_VERSION, "version must be 1");
  const coin = story?.coin || {};
  need(isText(coin.name) && coin.name.length > 0, "coin.name");
  need(isText(coin.ticker) && coin.ticker.length > 0, "coin.ticker");
  need(coin.origin === "launched" || coin.origin === "imported", "coin.origin");
  need(HEX.test(coin.accent || "") && HEX.test(coin.accent2 || ""), "coin.accent/accent2 must be #rrggbb");
  need(typeof coin.logoUrl === "string" && /^https:\/\//.test(coin.logoUrl), "coin.logoUrl must be https");
  need(typeof coin.tokenPath === "string" && coin.tokenPath.startsWith("/token/"), "coin.tokenPath");
  const chapters = Array.isArray(story?.chapters) ? story.chapters : [];
  need(chapters.length >= 2, "at least a cover and a call");
  need(chapters.length <= (STORY_MAX_CHAPTERS[coin.origin] || 0), `at most ${STORY_MAX_CHAPTERS[coin.origin]} chapters for ${coin.origin}`);
  need(chapters[0]?.kind === "cover", "first chapter is the cover");
  need(chapters[chapters.length - 1]?.kind === "call", "last chapter is the call");
  const ids = new Set();
  chapters.forEach((ch, i) => {
    const at = `chapters[${i}] (${ch?.kind})`;
    need(STORY_CHAPTER_KINDS.includes(ch?.kind), `${at}: unknown kind`);
    need(ch?.voice === "creator" || ch?.voice === "chronicle", `${at}: voice`);
    need(isText(ch?.stamp), `${at}: stamp`);
    need(Number.isInteger(ch?.durationMs) && ch.durationMs >= 3000 && ch.durationMs <= 15000, `${at}: durationMs 3000..15000`);
    need(typeof ch?.id === "string" && !ids.has(ch.id), `${at}: unique id`);
    ids.add(ch?.id);
    for (const key of ["title", "sub", "lede", "quote", "kicker", "body", "heading", "date", "time"]) need(isOptText(ch?.[key]), `${at}: ${key} must be plain text`);
    if (ch?.kind === "text") need(STORY_TEXT_STYLES.includes(ch.style), `${at}: style`);
    if (ch?.kind === "warcry") need(Array.isArray(ch.lines) && ch.lines.length >= 1 && ch.lines.length <= 3 && ch.lines.every(isText), `${at}: 1-3 lines`);
    if (ch?.kind === "chart") need(Array.isArray(ch.points) && ch.points.length >= 2 && ch.points.every(Number.isFinite), `${at}: points`);
    if (ch?.kind === "counts") need(Array.isArray(ch.rows) && ch.rows.length >= 1 && ch.rows.length <= 3 && ch.rows.every((r) => Number.isFinite(r.value)), `${at}: 1-3 numeric rows`);
    if (ch?.kind === "call") need(Array.isArray(ch.ctas) && ch.ctas.length >= 1 && ch.ctas.every((c) => /^(\/|https:\/\/)/.test(c.href || "")), `${at}: ctas with safe hrefs`);
    if (ch?.kind === "trades") need(Array.isArray(ch.items) && ch.items.every((t) => t.txUrl == null || /^https:\/\//.test(t.txUrl)), `${at}: trade txUrl`);
  });
  return problems;
}

/** Splits `*emphasis*` markers into parts the player renders as text. Never returns HTML. */
export function emphasisParts(text) {
  return String(text || "").split(/(\*[^*]+\*)/g).filter(Boolean).map((part) =>
    part.startsWith("*") && part.endsWith("*") ? { em: true, text: part.slice(1, -1) } : { em: false, text: part });
}
