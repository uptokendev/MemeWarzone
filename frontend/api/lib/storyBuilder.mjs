/**
 * Story Mode rules (2026-09-28). Pure: facts in, a story in the shape of shared/storyContract.mjs out.
 * Every chapter comes from one rule over one fact; no fact, no chapter. Copy is short and specific
 * (founder: nothing that reads as AI-written -- no em dashes, no slogan lines).
 *
 * Facts (all optional except identity):
 *   { chainId, token, origin: "launched"|"imported", name, ticker, chainLabel, logoUrl, logoAnimated,
 *     accent, accent2, tokenPath, appUrl, shareBase,
 *     creator: { description, note, socials: { x, telegram, website } },
 *     promotion: { createdAt, views, follows, firstFollowAt },          launched, from Prepare Mode
 *     launch: { at, firstOnMwz, firstOnChain },                          launched
 *     trades: { count, wallets, first: {at, amount, unit, wallet, txUrl}, biggest: {...} },
 *     holders, progress: { percent, targetUsd },                         launched
 *     born: { at },                                                      imported: pool creation
 *     joined: { at, ownerVerified, cleared },                            imported
 *     market: { marketCapUsd, liquidityUsd, holders },                   imported
 *     history: [{ time, high, low, close }] daily market cap,            imported
 *     battles: [{ id, at, mode, won, me: {ticker, points}, rival: {ticker, points, imageUrl} }],
 *     standing: [{ position, label, detail }] }
 */
import { STORY_FULL_SECTIONS, STORY_MAX_CHAPTERS, STORY_SHORT_MAX, validateStory } from "../../shared/storyContract.mjs";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const pad = (n) => String(n).padStart(2, "0");
export const dayLabel = (v) => { const d = toDate(v); return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const shortDay = (v) => { const d = toDate(v); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].charAt(0)}${MONTHS[d.getUTCMonth()].slice(1).toLowerCase()}`; };
const clock = (v, seconds = true) => { const d = toDate(v); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""} UTC`; };
const valid = (v) => v != null && Number.isFinite(toDate(v).getTime());

export function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** "86 SECONDS IN", "4 MINUTES IN", "3 HOURS IN", "ON 26 SEP". */
export function offsetLabel(fromAt, toAt, suffix = "IN") {
  const s = Math.max(0, Math.round((toDate(toAt) - toDate(fromAt)) / 1000));
  if (s < 120) return `${s} SECONDS ${suffix}`;
  if (s < 7200) return `${Math.round(s / 60)} MINUTES ${suffix}`;
  if (s < 86400) return `${Math.round(s / 3600)} HOURS ${suffix}`;
  return `ON ${shortDay(toAt).toUpperCase()}`;
}

/** Plain text only: no markup survives, markdown bold becomes the contract's *emphasis*. */
export function cleanText(v) {
  return String(v || "")
    .replace(/\r/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .trim();
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function clip(text, max) {
  if (text.length <= max) return text;
  let out = "";
  for (const s of sentences(text)) {
    if ((out + " " + s).trim().length > max) break;
    out = (out + " " + s).trim();
  }
  return out || `${text.slice(0, max - 1).trimEnd()}.`;
}

function isShout(paragraph) {
  const bare = paragraph.replace(/\*/g, "");
  const letters = bare.replace(/[^A-Za-z]/g, "");
  const allBold = /^\*[^*]+\*$/.test(paragraph.trim());
  return bare.length >= 12 && letters.length > 0 && ((letters.match(/[A-Z]/g) || []).length / letters.length > 0.8 || allBold);
}

/** Creator chapters from the creator's own text: a lead paragraph, a second, and a war cry. */
export function creatorChapters(description) {
  const text = cleanText(description);
  if (!text) return [];
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  const shout = paras.find(isShout);
  const prose = paras.filter((p) => p !== shout);
  if (prose[0]) {
    const [first, ...rest] = sentences(prose[0]);
    const lead = first && first.length <= 110 && rest.length;
    out.push({ id: "creator-1", kind: "text", voice: "creator", stamp: "Written by the creator", durationMs: 8000, style: "sonar",
      heading: lead ? first.replace(/\*/g, "") : null, body: clip(lead ? rest.join(" ") : prose[0], 300), priority: 9 });
  }
  if (prose[1]) {
    out.push({ id: "creator-2", kind: "text", voice: "creator", stamp: "Written by the creator", durationMs: 8000, style: "candle",
      heading: null, body: clip(prose[1], 300), priority: 6 });
  }
  if (shout) {
    const lines = sentences(shout.replace(/\*/g, "")).map((l) => l.toUpperCase()).filter((l) => l.length <= 60).slice(0, 3);
    if (lines.length) out.push({ id: "creator-warcry", kind: "warcry", voice: "creator", stamp: "Written by the creator", durationMs: 6500, lines, priority: 8 });
  }
  return out;
}

function chartChapter(history, name) {
  const items = (history || []).filter((r) => [r.high, r.low, r.close].every((v) => Number.isFinite(Number(v)) && Number(v) > 0));
  if (items.length < 14) return null;
  const hiI = items.reduce((best, r, i) => (Number(r.high) > Number(items[best].high) ? i : best), 0);
  const loI = items.slice(0, hiI + 1).reduce((best, r, i) => (Number(r.low) < Number(items[best].low) ? i : best), 0);
  const hi = Number(items[hiI].high), lo = Number(items[loI].low), now = Number(items[items.length - 1].close);
  const step = Math.max(1, Math.floor(items.length / 60));
  const points = items.filter((_, i) => i % step === 0).map((r) => Math.round(Number(r.close) * 100) / 100);
  if (points[points.length - 1] !== Math.round(now * 100) / 100) points.push(Math.round(now * 100) / 100);
  const idx = (i) => Math.min(points.length - 1, Math.round(i / step));
  const days = Math.round((toDate(items[hiI].time) - toDate(items[loI].time)) / 86400000);
  const mult = lo > 0 ? hi / lo : 0;
  const drop = hi > 0 ? Math.round((1 - now / hi) * 100) : 0;
  return {
    id: "history", kind: "chart", voice: "chronicle", stamp: "Chronicle · market history", durationMs: 9000, priority: 10,
    title: mult >= 2 && days > 0 ? `${mult.toFixed(1)}× in ${days} days.` : "The ride so far.",
    sub: `${usd(lo)} on ${shortDay(items[loI].time)}. ${usd(hi)} on ${shortDay(items[hiI].time)}.`,
    points, low: { index: idx(loI), label: usd(lo), date: shortDay(items[loI].time) }, high: { index: idx(hiI), label: usd(hi), date: shortDay(items[hiI].time) },
    fromLabel: `${MONTHS[toDate(items[0].time).getUTCMonth()]} ${toDate(items[0].time).getUTCFullYear()}`, toLabel: "TODAY",
    lede: drop > 0 ? `Today it sits at *${usd(now)}*, ${drop}% under that top.` : `Today it sits at *${usd(now)}*, right at the top.`,
    _mult: mult, _days: days, _name: name,
  };
}

function battleChapter(b, facts) {
  if (!b || !b.rival?.ticker) return null;
  const votes = b.mode === "vote";
  const pts = (p) => (Number.isFinite(Number(p)) ? Number(p) : null);
  const me = pts(b.me?.points), them = pts(b.rival?.points);
  const score = me != null && them != null ? (votes ? `${me} to ${them} votes` : `${me} to ${them} points`) : null;
  return {
    id: `battle-${b.id}`, kind: "battle", voice: "chronicle", stamp: "Chronicle · the arena", durationMs: 8000, priority: b.won ? 9 : 7,
    date: valid(b.at) ? dayLabel(b.at) : null,
    title: b.won ? `Beat $${b.rival.ticker}.` : `Lost to $${b.rival.ticker}.`,
    sub: `${votes ? "Vote battle" : "Battle"}${score ? `, ${score}` : ""}.`,
    left: { ticker: facts.ticker, imageUrl: facts.logoUrl, won: Boolean(b.won) },
    right: { ticker: b.rival.ticker, imageUrl: b.rival.imageUrl || facts.logoUrl, won: !b.won },
    resultLabel: `$${b.won ? facts.ticker : b.rival.ticker} WON`,
    lede: b.won ? "That one stays on the record." : `${facts.name} can call a rematch from the Battle Wall.`,
  };
}

function shareText(facts, chart) {
  const t = facts.ticker;
  if (facts.launch?.firstOnMwz) {
    const bits = [`${facts.name} was the first coin ever launched on MemeWarzone.`];
    if (facts.trades?.wallets) bits.push(`${facts.trades.wallets} wallets in${facts.progress?.percent != null ? `, ${facts.progress.percent}% to graduation` : ""}.`);
    return `${bits.join(" ")} Watch the story.`;
  }
  if (chart && chart._mult >= 2 && chart._days > 0) return `${facts.name} went ${chart._mult.toFixed(1)}x in ${chart._days} days. Now $${t} is in the Warzone. Watch the story.`;
  const won = (facts.battles || []).filter((b) => b.won).length;
  if (won) return `$${t} has won ${won} battle${won > 1 ? "s" : ""} on MemeWarzone. Watch the story.`;
  if (facts.progress?.percent != null) return `$${t} is ${facts.progress.percent}% of the way to graduation on MemeWarzone. Watch the story.`;
  return `The story of $${t} on MemeWarzone.`;
}

/** The creator's full story: only filled boxes, in our order, under our headings, within each box's limit. */
export function fullStoryFrom(profile) {
  const answers = profile?.sections || {};
  const images = profile?.sectionImages || {};
  const sections = STORY_FULL_SECTIONS.map((def) => {
    const body = clip(cleanText(answers[def.key]).replace(/\*/g, ""), def.max);
    if (!body) return null;
    // One image per box, uploaded on the coin page (founder B1, 2026-10-02); https only.
    const image = String(images[def.key] || "");
    return /^https:\/\/[^\s<>"']+$/.test(image) ? { key: def.key, heading: def.heading, body, imageUrl: image } : { key: def.key, heading: def.heading, body };
  }).filter(Boolean);
  return sections.length ? { updatedAt: toDate(profile.updatedAt || Date.now()).toISOString(), sections } : null;
}

/** Keeps cover first and call last; drops the lowest-priority chapters until the origin's cap fits. */
function fitChapters(chapters, max) {
  const middle = chapters.slice(1, -1);
  while (middle.length + 2 > max) {
    let drop = 0;
    middle.forEach((c, i) => { if ((c.priority ?? 5) < (middle[drop].priority ?? 5)) drop = i; });
    middle.splice(drop, 1);
  }
  return [chapters[0], ...middle, chapters[chapters.length - 1]].map(({ priority, _mult, _days, _name, ...c }) => c);
}

export function buildStory(facts, { now = new Date() } = {}) {
  const f = facts;
  const launched = f.origin === "launched";
  const creator = creatorChapters(f.creator?.description);
  const note = cleanText(f.creator?.note);
  const chapters = [];

  chapters.push({
    id: "cover", kind: "cover", voice: creator.length || note ? "creator" : "chronicle",
    stamp: creator.length || note ? "Written by the creator" : "A MemeWarzone story", durationMs: 6500,
    kicker: launched ? (f.launch?.firstOnMwz ? "First coin of the Warzone" : `Launched on MemeWarzone · ${f.chainLabel}`) : `Imported · ${f.chainLabel}`,
    quote: note && note.length <= 140 ? note.replace(/\*/g, "") : null,
  });
  chapters.push(...creator);
  // Imported coins: the owner's short story is their one editable chapter.
  const short = clip(cleanText(f.storyProfile?.shortStory), STORY_SHORT_MAX);
  if (!launched && short) {
    chapters.push({ id: "creator-short", kind: "text", voice: "creator", stamp: "Written by the owner", durationMs: 8000, style: "words", heading: null, body: short, priority: 9 });
  }

  let chart = null;
  if (launched) {
    const p = f.promotion;
    if (p && valid(p.createdAt) && (Number(p.views) > 0 || Number(p.follows) > 0)) {
      const rows = [];
      if (Number(p.views) > 0) rows.push({ value: Number(p.views), decimals: 0, prefix: "", suffix: "", label: "people watched", tone: "plain" });
      if (Number(p.follows) > 0) rows.push({ value: Number(p.follows), decimals: 0, prefix: "", suffix: "", label: "followed before launch", tone: "ember" });
      const firstMin = valid(p.firstFollowAt) ? Math.round((toDate(p.firstFollowAt) - toDate(p.createdAt)) / 60000) : null;
      chapters.push({ id: "promotion", kind: "counts", voice: "chronicle", stamp: "Chronicle · MemeWarzone", durationMs: 7000, priority: 6,
        date: `${dayLabel(p.createdAt)} · ${clock(p.createdAt, false)}`, title: "The call went out.", sub: "Before a single token existed.", rows,
        lede: firstMin != null && firstMin >= 0 && firstMin < 1440 ? `The first follower showed up ${firstMin} minute${firstMin === 1 ? "" : "s"} after the page went live.` : null });
    }
    if (f.launch && valid(f.launch.at)) {
      chapters.push({ id: "launch", kind: "moment", voice: "chronicle", stamp: "Chronicle · on chain", durationMs: 7000, priority: 10,
        date: dayLabel(f.launch.at), time: clock(f.launch.at), title: `${f.name} launched.`,
        sub: f.launch.firstOnMwz ? `The first coin ever launched on MemeWarzone${f.launch.firstOnChain ? `, and the first on ${f.chainLabel}` : ""}.`
          : f.launch.firstOnChain ? `The first coin launched on MemeWarzone on ${f.chainLabel}.` : `Launched on MemeWarzone, ${f.chainLabel}.`,
        seal: f.launch.firstOnMwz ? ["FIRST", "COIN", "EVER"] : f.launch.firstOnChain ? ["FIRST", "ON", f.chainLabel.toUpperCase()] : null, lede: null });
    }
    const tr = f.trades;
    if (tr?.first && f.launch && valid(f.launch.at)) {
      const items = [{ offsetLabel: offsetLabel(f.launch.at, tr.first.at), amount: tr.first.amount, decimals: tr.first.amount < 10 ? 2 : 1, unit: tr.first.unit, wallet: tr.first.wallet, note: "The first buy.", txUrl: tr.first.txUrl || null, tone: "plain" }];
      if (tr.biggest && tr.biggest.txUrl !== tr.first.txUrl && tr.biggest.amount > tr.first.amount) {
        items.push({ offsetLabel: offsetLabel(tr.first.at, tr.biggest.at, "LATER"), amount: tr.biggest.amount, decimals: tr.biggest.amount < 10 ? 2 : 1, unit: tr.biggest.unit, wallet: tr.biggest.wallet, note: "Still the biggest single buy.", txUrl: tr.biggest.txUrl || null, tone: "accent" });
      }
      chapters.push({ id: "first-trades", kind: "trades", voice: "chronicle", stamp: "Chronicle · on chain", durationMs: 8000, priority: 9, items });
    }
    if (tr?.wallets && f.holders != null) {
      chapters.push({ id: "clan", kind: "clan", voice: "chronicle", stamp: "Chronicle · today", durationMs: 7500, priority: 7,
        title: "The army.", sub: "One dot per wallet that traded.", holding: Math.min(f.holders, tr.wallets), exited: Math.max(0, tr.wallets - f.holders),
        lede: `*${tr.wallets} wallets* have traded $${f.ticker}, *${tr.count} trades* so far.` });
    }
    if (f.progress?.percent != null) {
      const fought = (f.battles || []).length, won = (f.battles || []).filter((b) => b.won).length;
      chapters.push({ id: "road", kind: "progress", voice: "chronicle", stamp: "Chronicle · the mission", durationMs: 8000, priority: 8,
        title: "Road to graduation", percent: Math.round(Number(f.progress.percent) * 10) / 10, fromLabel: "LAUNCH",
        toLabel: f.progress.targetUsd ? `${usd(f.progress.targetUsd)} TARGET` : "GRADUATION", rival: null,
        lede: fought ? `Arena record so far: ${won}W / ${fought - won}L.` : `No coin has challenged ${f.name} yet. *Who's first?*` });
    }
  } else {
    if (f.born && valid(f.born.at)) {
      const b = toDate(f.born.at), afternoon = b.getUTCHours() >= 12 && b.getUTCHours() < 18;
      chapters.push({ id: "born", kind: "moment", voice: "chronicle", stamp: "Chronicle · on chain", durationMs: 6500, priority: 8,
        date: dayLabel(b), time: clock(b), title: `${f.name} was born.`,
        sub: afternoon ? `First pool on ${f.chainLabel}. A ${DAYS[b.getUTCDay()]} afternoon.` : `First pool on ${f.chainLabel}, on a ${DAYS[b.getUTCDay()]}.`, seal: null, lede: null });
    }
    chart = chartChapter(f.history, f.name);
    if (chart) chapters.push(chart);
    const m = f.market || {};
    const rows = [];
    if (Number(m.holders) > 0) rows.push({ value: Number(m.holders), decimals: 0, prefix: "", suffix: "", label: "holders", tone: "accent" });
    if (Number(m.marketCapUsd) > 0) rows.push({ value: Math.round(Number(m.marketCapUsd) / 100) / 10, decimals: 1, prefix: "$", suffix: "K", label: "market cap", tone: "plain" });
    if (Number(m.liquidityUsd) > 0) rows.push({ value: Math.round(Number(m.liquidityUsd) / 100) / 10, decimals: 1, prefix: "$", suffix: "K", label: "liquidity", tone: "plain" });
    if (rows.length) chapters.push({ id: "today", kind: "counts", voice: "chronicle", stamp: "Chronicle · today", durationMs: 7000, priority: 7, date: null, title: "The army today.", sub: `Counted on ${shortDay(now)}.`, rows, lede: null });
    if (f.joined && valid(f.joined.at)) {
      chapters.push({ id: "joined", kind: "moment", voice: "chronicle", stamp: "Chronicle · MemeWarzone", durationMs: 6500, priority: 8,
        date: dayLabel(f.joined.at), time: clock(f.joined.at, false), title: `${f.name} joined the Warzone.`,
        sub: f.joined.cleared ? "Brought in by the owner and cleared to fight." : "Brought in by the owner.", seal: f.joined.ownerVerified ? ["OWNER", "VERIFIED"] : null, lede: null });
    }
  }

  for (const b of (f.battles || []).slice(0, 2)) { const ch = battleChapter(b, f); if (ch) chapters.push(ch); }
  if (f.standing?.length) chapters.push({ id: "standing", kind: "standing", voice: "chronicle", stamp: "Chronicle · standing", durationMs: 7000, priority: 5, title: "Where it stands.", sub: `Rankings on ${shortDay(now)}.`, rows: f.standing.slice(0, 3) });

  const ctas = [{ label: `BUY $${f.ticker}`, href: f.tokenPath, primary: true }];
  if (launched) ctas.push({ label: "WAR ROOM", href: f.tokenPath, primary: false });
  ctas.push({ label: `CHALLENGE $${f.ticker}`, href: "/warzone/battles", primary: false });
  if (!launched) ctas.push({ label: "UPVOTE", href: f.tokenPath, primary: false });
  for (const [key, label] of [["x", "X"], ["telegram", "TELEGRAM"], ["website", "WEBSITE"]]) {
    const href = String(f.creator?.socials?.[key] || "");
    if (/^https:\/\//i.test(href)) ctas.push({ label, href, primary: false });
  }
  chapters.push({ id: "call", kind: "call", voice: "chronicle", stamp: "Your turn", durationMs: 12000, title: `Get in on $${f.ticker}.`, ctas });

  const story = {
    version: 1, chainId: f.chainId, token: f.token, generatedAt: toDate(now).toISOString(),
    coin: { name: f.name, ticker: f.ticker, chainId: f.chainId, chainLabel: f.chainLabel, origin: f.origin, logoUrl: f.logoUrl, logoAnimated: Boolean(f.logoAnimated), accent: f.accent, accent2: f.accent2, tokenPath: f.tokenPath },
    share: { url: `${f.shareBase}/s/${f.chainId}/${f.token}`, text: shareText(f, chart).slice(0, 240), imageUrl: `${f.shareBase}/api/story/card/${f.chainId}/${f.token}.png` },
    fullStory: fullStoryFrom(f.storyProfile),
    chapters: fitChapters(chapters, STORY_MAX_CHAPTERS[f.origin]),
  };
  return { story, problems: validateStory(story) };
}
