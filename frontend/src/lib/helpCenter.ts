/**
 * Command Center Support view of the Help Center. The articles live in shared/helpContent.mjs (the public /faq
 * pages, the API renderer and the help assistant read the same file); this module keeps the shape and the eight
 * categories Command Center Support has always used.
 */
import {
  HELP_ARTICLES as SHARED_ARTICLES,
  HELP_TOPICS,
  helpAnswerText,
  searchHelp,
} from "../../shared/helpContent.mjs";

export type HelpCategoryId =
  | "popular"
  | "wallets"
  | "create"
  | "trading"
  | "rewards"
  | "community"
  | "recruiters"
  | "safety";

export type HelpArticle = {
  id: string;
  title: string;
  body: string;
  categories: HelpCategoryId[];
  keywords: string[];
  popular?: boolean;
};

export const HELP_CATEGORIES: { id: HelpCategoryId; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "wallets", label: "Wallets" },
  { id: "create", label: "Create & Launch" },
  { id: "trading", label: "Trading" },
  { id: "rewards", label: "Rewards" },
  { id: "community", label: "Community" },
  { id: "recruiters", label: "Recruiters & Squads" },
  { id: "safety", label: "Safety" },
];

const LEGACY: Record<string, HelpCategoryId> = Object.fromEntries(
  HELP_TOPICS.map((t: { id: string; legacy: string }) => [t.id, t.legacy as HelpCategoryId]),
);

function toLegacy(a: { slug: string; q: string; topic: string; alsoIn?: string[]; keywords?: string[]; popular?: boolean }): HelpArticle {
  const categories = Array.from(new Set([a.topic, ...(a.alsoIn || [])].map((t) => LEGACY[t]).filter(Boolean)));
  return {
    id: a.slug,
    title: a.q,
    body: helpAnswerText(a),
    categories,
    keywords: a.keywords || [],
    popular: Boolean(a.popular),
  };
}

export const HELP_ARTICLES: HelpArticle[] = SHARED_ARTICLES.map(toLegacy);

export const DISCORD_SUPPORT_URL = "https://discord.gg/aXTkn3Asu";

export function searchHelpArticles(query: string, category: HelpCategoryId = "popular"): HelpArticle[] {
  const needle = String(query || "").trim();
  if (needle) {
    const ids = new Set(searchHelp(needle, 500).map((a: { slug: string }) => a.slug));
    return HELP_ARTICLES.filter((article) => ids.has(article.id));
  }
  if (category === "popular") return HELP_ARTICLES.filter((article) => article.popular);
  return HELP_ARTICLES.filter((article) => article.categories.includes(category));
}
