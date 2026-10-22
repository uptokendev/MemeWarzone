// Builds /llms.txt (a short map for AI tools, llmstxt.org format) and /llms-full.txt (the full text) from the same
// content modules the pages use. Pure: returns strings. scripts/generate-llms.mjs writes them to public/, and
// shared/llmsTxt.test.mjs fails when the committed files are out of date.

import {
  ABOUT_CHAINS, ABOUT_DESCRIPTION, ABOUT_DISAMBIGUATION, ABOUT_INTRO, ABOUT_NEXT_CHAIN, ABOUT_PATH, ABOUT_SECTIONS, ABOUT_TITLE,
} from "./aboutContent.mjs";
import { COMPARE_PAGES } from "./comparePages.mjs";
import { HELP_ARTICLES, HELP_DESCRIPTION, HELP_PATH, HELP_TITLE, HELP_TOPICS, helpAnswerText, helpArticlesForTopic } from "./helpContent.mjs";

const ORIGIN = "https://app.memewar.zone";
const url = (path) => `${ORIGIN}${path}`;

export function buildLlmsTxt() {
  const lines = [
    "# MemeWarzone",
    "",
    `> ${ABOUT_DESCRIPTION} ${ABOUT_DISAMBIGUATION}`,
    "",
    ...ABOUT_INTRO,
    "",
    `Live on ${ABOUT_CHAINS.join(", ")}. Next: ${ABOUT_NEXT_CHAIN.name}. ${ABOUT_NEXT_CHAIN.text}`,
    "",
    "## Key pages",
    "",
    `- [${ABOUT_TITLE}](${url(ABOUT_PATH)}): what MemeWarzone is, battles, leagues, fees, contracts, roadmap and team`,
    `- [${HELP_TITLE}](${url(HELP_PATH)}): ${HELP_DESCRIPTION}`,
    ...COMPARE_PAGES.map((c) => `- [${c.title}](${url(c.path)}): ${c.description}`),
    `- [Launch a coin](${url("/create")})`,
    `- [Coins](${url("/coins")})`,
    `- [Warzone battles](${url("/warzone/battles")})`,
    `- [League standings](${url("/league")})`,
    `- [Docs](https://docs.memewar.zone)`,
    "",
    "## Help Center topics",
    "",
    ...HELP_TOPICS.map((t) => `- [${t.label}](${url(`${HELP_PATH}/${t.id}`)}): ${t.description}`),
    "",
    "## Optional",
    "",
    `- [Full text for AI tools](${url("/llms-full.txt")}): About, comparisons and every Help Center answer in one file`,
    `- [Sitemap](${url("/sitemap.xml")})`,
    "",
  ];
  return lines.join("\n");
}

function sectionText(s) {
  const out = [`## ${s.heading}`, ""];
  if (s.lead) out.push(s.lead, "");
  for (const x of s.steps || []) out.push(`- ${x.title}: ${x.text}`);
  if (s.steps?.length) out.push("");
  if (s.chips?.length) out.push(`${s.chipsLabel ? `${s.chipsLabel}: ` : ""}${s.chips.join(", ")}`, "");
  for (const m of s.modes || []) out.push(`- ${m.name} (${m.durations.join(", ")}): ${m.text}`);
  if (s.modes?.length) out.push("");
  for (const x of s.splits || []) out.push(`${x.title}: ${x.segments.map((g) => `${g.pct}% ${g.label}`).join(", ")}.`, "");
  for (const i of s.items || []) out.push(`- ${i}`);
  if (s.items?.length) out.push("");
  for (const c of s.categories || []) out.push(`- ${c.name}: ${c.text}`);
  if (s.categories?.length) out.push("");
  for (const m of s.members || []) out.push(`- ${m.name}, ${m.role}`);
  if (s.members?.length) out.push("");
  for (const c of s.contracts || []) {
    out.push(`${c.chain} (${c.audit}):`);
    for (const e of c.entries) out.push(`- ${e.label}: ${e.address}`);
    out.push("");
  }
  for (const q of s.qa || []) out.push(`### ${q.q}`, "", q.a, "");
  for (const r of s.rows || []) out.push(`- ${r.feature}. MemeWarzone: ${r.mwz} Other: ${r.other}`);
  if (s.rows?.length) out.push("");
  if (s.note) out.push(s.note, "");
  return out;
}

export function buildLlmsFullTxt() {
  const out = [
    "# MemeWarzone: full text",
    "",
    `> ${ABOUT_DESCRIPTION} ${ABOUT_DISAMBIGUATION} Source: ${ORIGIN}. Generated from the same content as the pages.`,
    "",
    `# ${ABOUT_TITLE}`,
    "",
    `URL: ${url(ABOUT_PATH)}`,
    "",
    ...ABOUT_INTRO.flatMap((t) => [t, ""]),
    `Live on ${ABOUT_CHAINS.join(", ")}. Next: ${ABOUT_NEXT_CHAIN.name}. ${ABOUT_NEXT_CHAIN.text}`,
    "",
    ...ABOUT_SECTIONS.flatMap(sectionText),
  ];
  for (const c of COMPARE_PAGES) {
    out.push(`# ${c.title}`, "", `URL: ${url(c.path)}. Checked ${c.checkedOn}.`, "", ...c.intro.flatMap((t) => [t, ""]));
    for (const v of c.verdicts) out.push(`## ${v.title}`, "", ...v.items.map((i) => `- ${i}`), "");
    out.push(...c.sections.flatMap(sectionText));
    out.push("Sources:", ...c.sources.map((x) => `- ${x.text}: ${x.href} (${x.date})`), "");
  }
  out.push(`# ${HELP_TITLE}`, "", `URL: ${url(HELP_PATH)}`, "");
  for (const t of HELP_TOPICS) {
    const list = helpArticlesForTopic(t.id).filter((a) => a.topic === t.id);
    if (!list.length) continue;
    out.push(`## ${t.label}`, "");
    for (const a of list) out.push(`### ${a.q}`, "", helpAnswerText(a), "", `URL: ${url(`${HELP_PATH}/${a.slug}`)}`, "");
  }
  out.push(`(${HELP_ARTICLES.length} Help Center answers)`, "");
  return out.join("\n");
}
