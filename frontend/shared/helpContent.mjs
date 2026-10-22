// Help Center content: one source for the public /faq pages, Command Center Support, the API renderer
// (server-rendered text for crawlers), the sitemap, llms.txt and the help assistant. Pure module: no DOM, no I/O.
//
// Articles live in shared/help/<topic>.mjs, one file per topic. Article shape:
//   slug      unique across all topics AND topic ids, lowercase-kebab, <= 64 chars; URL /faq/<slug>
//   q         the question, as a user would ask it
//   a         answer paragraphs (plain sentences, no markdown)
//   steps?    ordered steps, rendered as a numbered list after the paragraphs
//   bullets?  unordered points, rendered after the steps
//   links?    [{ href, text }]: app paths ("/league") or https URLs
//   keywords  extra search words (synonyms, misspellings, other names)
//   popular?  shown on the Help Center front page
//   alsoIn?   other topic ids this article is listed under
//   sources   where each fact was checked (file:line, docs page, or "founder YYYY-MM-DD"); never rendered
//   needsReview? a reason, when a fact could not be verified; never rendered
// Copy rule: plain sentences, concrete facts, no slogans, no dashes used as punctuation.

import gettingStarted from "./help/getting-started.mjs";
import wallets from "./help/wallets.mjs";
import create from "./help/create.mjs";
import trading from "./help/trading.mjs";
import graduation from "./help/graduation.mjs";
import fees from "./help/fees.mjs";
import battles from "./help/battles.mjs";
import leagues from "./help/leagues.mjs";
import rewards from "./help/rewards.mjs";
import imports from "./help/imports.mjs";
import recruiters from "./help/recruiters.mjs";
import promotion from "./help/promotion.mjs";
import social from "./help/social.mjs";
import safety from "./help/safety.mjs";
import troubleshooting from "./help/troubleshooting.mjs";

import { HELP_DESCRIPTION, HELP_PATH, HELP_TITLE } from "./helpMeta.mjs";

export { HELP_DESCRIPTION, HELP_PATH, HELP_TITLE };

const ORIGIN = "https://app.memewar.zone";

/**
 * Topics in display order. `legacy` maps a topic to the Command Center Support categories in src/lib/helpCenter.ts.
 * @type {{ id: string, label: string, description: string, legacy: string }[]}
 */
export const HELP_TOPICS = [
  { id: "getting-started", label: "Getting started", description: "What MemeWarzone is, how to begin and where everything is.", legacy: "community" },
  { id: "wallets", label: "Wallets and chains", description: "Connecting a wallet, switching chains and signing in.", legacy: "wallets" },
  { id: "create", label: "Create and launch", description: "Launching a coin, drafts, scheduled launches and launch rules.", legacy: "create" },
  { id: "trading", label: "Buying and selling", description: "Trading on the bonding curve and after graduation.", legacy: "trading" },
  { id: "graduation", label: "Graduation", description: "When a coin graduates, where it trades and what happens to liquidity.", legacy: "trading" },
  { id: "fees", label: "Fees and earnings", description: "Trading fees, the fee split, creator earnings and fee choices.", legacy: "rewards" },
  { id: "battles", label: "Battles and tournaments", description: "Metrics and vote battles, Boosts, war pools and tournaments.", legacy: "community" },
  { id: "leagues", label: "Leagues", description: "Weekly and monthly leagues and the Major War League.", legacy: "rewards" },
  { id: "rewards", label: "Rewards, claims and airdrops", description: "What you can earn, how claims work and weekly airdrops.", legacy: "rewards" },
  { id: "imports", label: "Importing coins", description: "Bringing a coin from another launchpad and claiming it.", legacy: "create" },
  { id: "recruiters", label: "Recruiters and squads", description: "Referral links, recruiter earnings and squad pools.", legacy: "recruiters" },
  { id: "promotion", label: "UpVotes and promotion", description: "UpVotes, Featured lists, Stories and sponsorships.", legacy: "create" },
  { id: "social", label: "Profiles and the feed", description: "Your profile, posts, follows and notifications.", legacy: "community" },
  { id: "safety", label: "Safety and security", description: "Scams, impersonation, reporting abuse and keeping your wallet safe.", legacy: "safety" },
  { id: "troubleshooting", label: "Troubleshooting", description: "Failed transactions, wallet warnings and things that look wrong.", legacy: "trading" },
];

const BY_TOPIC = {
  "getting-started": gettingStarted,
  wallets,
  create,
  trading,
  graduation,
  fees,
  battles,
  leagues,
  rewards,
  imports,
  recruiters,
  promotion,
  social,
  safety,
  troubleshooting,
};

/** Every article with its home topic attached, in topic order. */
export const HELP_ARTICLES = HELP_TOPICS.flatMap((t) => (BY_TOPIC[t.id] || []).map((a) => ({ ...a, topic: t.id })));

export function helpTopic(id) {
  return HELP_TOPICS.find((t) => t.id === id) || null;
}

export function helpArticle(slug) {
  return HELP_ARTICLES.find((a) => a.slug === slug) || null;
}

/** Articles listed under a topic: its own plus those that name it in alsoIn. */
export function helpArticlesForTopic(id) {
  const own = HELP_ARTICLES.filter((a) => a.topic === id);
  const listed = HELP_ARTICLES.filter((a) => a.topic !== id && (a.alsoIn || []).includes(id));
  return [...own, ...listed];
}

export function helpPopular() {
  return HELP_ARTICLES.filter((a) => a.popular);
}

/** The full answer as plain text: paragraphs, steps and bullets. */
export function helpAnswerText(a) {
  return [...(a.a || []), ...(a.steps || []).map((s, i) => `${i + 1}. ${s}`), ...(a.bullets || [])].join(" ");
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9$%. ]+/g, " ");
const STOP = new Set(["the", "a", "an", "i", "is", "are", "do", "does", "can", "how", "what", "my", "to", "of", "on", "in", "for", "and", "or", "it", "be", "with", "me", "you", "your", "when", "why", "where", "which", "who"]);

/**
 * Ranked search. Title words weigh most, then keywords, then the answer. Every query word must match somewhere
 * (prefix match, so "grad" finds "graduation"). Used by the Help Center and by the assistant's retrieval.
 */
export function searchHelp(query, limit = 50) {
  const words = norm(query).split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length) return [];
  const scored = [];
  for (const a of HELP_ARTICLES) {
    const title = norm(a.q).split(/\s+/);
    const keys = norm((a.keywords || []).join(" ")).split(/\s+/);
    const body = norm(helpAnswerText(a)).split(/\s+/);
    let score = 0;
    let all = true;
    for (const w of words) {
      const hit = (list) => list.some((t) => t.startsWith(w));
      const s = (hit(title) ? 6 : 0) + (hit(keys) ? 4 : 0) + (hit(body) ? 1 : 0);
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) scored.push({ a, score: score + (a.popular ? 0.5 : 0) });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit).map((x) => x.a);
}

/** Related articles: same topic first, then shared keywords. */
export function helpRelated(article, limit = 5) {
  const keys = new Set((article.keywords || []).map((k) => k.toLowerCase()));
  return HELP_ARTICLES.filter((a) => a.slug !== article.slug)
    .map((a) => ({ a, score: (a.topic === article.topic ? 3 : 0) + (a.keywords || []).filter((k) => keys.has(k.toLowerCase())).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.a);
}

/** A meta description from the answer: whole sentences up to about 155 characters. */
export function helpSnippet(text, max = 155) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}...`;
}

/** Head for /faq/<slug>: a topic or an article, or null when the slug is unknown. */
export function helpHead(slug) {
  const topic = helpTopic(slug);
  if (topic) {
    return { kind: "topic", topic, title: `${topic.label} · ${HELP_TITLE}`, description: helpSnippet(`${topic.description} ${helpArticlesForTopic(topic.id).length} answers in the MemeWarzone Help Center.`) };
  }
  const article = helpArticle(slug);
  if (article) return { kind: "article", article, topic: helpTopic(article.topic), title: article.q, description: helpSnippet((article.a || []).join(" ")) };
  return null;
}

export function helpJsonLd(head, origin = ORIGIN) {
  const crumbs = [
    { "@type": "ListItem", position: 1, name: "MemeWarzone", item: `${origin}/` },
    { "@type": "ListItem", position: 2, name: HELP_TITLE, item: `${origin}${HELP_PATH}` },
  ];
  if (!head) return [{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs }];
  if (head.kind === "topic") {
    crumbs.push({ "@type": "ListItem", position: 3, name: head.topic.label, item: `${origin}${HELP_PATH}/${head.topic.id}` });
    return [{ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs }];
  }
  crumbs.push({ "@type": "ListItem", position: 3, name: head.topic.label, item: `${origin}${HELP_PATH}/${head.topic.id}` });
  crumbs.push({ "@type": "ListItem", position: 4, name: head.article.q, item: `${origin}${HELP_PATH}/${head.article.slug}` });
  return [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: head.article.q, acceptedAnswer: { "@type": "Answer", text: helpAnswerText(head.article) } }],
    },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs },
  ];
}
