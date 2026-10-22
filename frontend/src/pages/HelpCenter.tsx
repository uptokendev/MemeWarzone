/**
 * Help Center: /faq (search, topics, popular questions), /faq/<topic> and /faq/<article>.
 * Content lives in shared/helpContent.mjs (also used by the API renderer, the sitemap, llms.txt, Command Center
 * Support and the help assistant). This file is layout only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  ChevronRight,
  Coins,
  GraduationCap,
  HelpCircle,
  Import,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageCircle,
  Rocket,
  Search,
  ShieldCheck,
  Swords,
  Trophy,
  UserRound,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import NotFound from "@/pages/NotFound";
import { BODY, EYEBROW } from "@/components/content/ContentBlocks";
import { cp } from "@/components/token/coinPageStyles";
import { useSeoOverride } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";
import {
  HELP_ARTICLES,
  HELP_DESCRIPTION,
  HELP_PATH,
  HELP_TITLE,
  HELP_TOPICS,
  helpArticlesForTopic,
  helpHead,
  helpPopular,
  helpRelated,
  helpSnippet,
  searchHelp,
} from "../../shared/helpContent.mjs";

type Topic = (typeof HELP_TOPICS)[number];
type Article = (typeof HELP_ARTICLES)[number];

const TOPIC_ICONS: Record<string, LucideIcon> = {
  "getting-started": Rocket,
  wallets: Wallet,
  create: Coins,
  trading: BadgeDollarSign,
  graduation: GraduationCap,
  fees: BadgeDollarSign,
  battles: Swords,
  leagues: Trophy,
  rewards: Trophy,
  imports: Import,
  recruiters: Users,
  promotion: Megaphone,
  social: UserRound,
  safety: ShieldCheck,
  troubleshooting: Wrench,
};

const iconFor = (id: string) => TOPIC_ICONS[id] ?? HelpCircle;
const articlePath = (slug: string) => `${HELP_PATH}/${slug}`;

const DISCORD_URL = "https://discord.gg/aXTkn3Asu";
const SUPPORT_EMAIL = "support@memewar.zone";

/* ------------------------------------------------------------------ shared pieces */

function SearchBox({ value, onChange, autoFocus, large }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; large?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="relative">
      <Search className={cn("pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-mw-muted", large ? "h-5 w-5" : "h-4 w-4")} aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search for answers, for example: graduation, Boost, Phantom, fees"
        aria-label="Search the Help Center"
        className={cn(
          "mw-focus w-full rounded-[12px] border border-mw-edge bg-[#0E1114] pr-11 text-mw-text placeholder:text-[#6B737C] focus:border-mw-accent focus:outline-none",
          large ? "h-14 pl-12 text-[16px] md:text-[17px]" : "h-11 pl-10 text-[15px]",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="mw-focus absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-mw-muted hover:bg-[#1F252C] hover:text-mw-text"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ArticleRow({ a, showTopic }: { a: Article; showTopic?: boolean }) {
  const topic = HELP_TOPICS.find((t: Topic) => t.id === a.topic);
  return (
    <Link
      to={articlePath(a.slug)}
      className="group flex items-start gap-3 rounded-[12px] border border-mw-border bg-mw-input p-4 hover:border-[#3A424C] hover:bg-[#171B20]"
    >
      <HelpCircle className="mt-[2px] h-[18px] w-[18px] shrink-0 text-mw-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-snug text-mw-text group-hover:text-mw-accent-soft">{a.q}</span>
        <span className="mt-1 line-clamp-2 block text-[14px] leading-5 text-mw-muted">{helpSnippet((a.a || []).join(" "), 160)}</span>
        {showTopic && topic ? <span className="mt-2 inline-block text-[12px] font-semibold uppercase tracking-[0.06em] text-[#8D949C]">{topic.label}</span> : null}
      </span>
      <ChevronRight className="mt-[2px] h-4 w-4 shrink-0 text-mw-muted group-hover:text-mw-text" aria-hidden="true" />
    </Link>
  );
}

function StillNeedHelp() {
  return (
    <section className={cn(cp.card, "p-5 md:p-6")}>
      <div className="flex items-center gap-2.5">
        <LifeBuoy className="h-5 w-5 text-mw-accent" aria-hidden="true" />
        <h2 className="m-0 font-mw-cond text-xl font-bold text-mw-text">Still need help?</h2>
      </div>
      <p className={cn("m-0 mt-2", BODY)}>
        Ask the community and the team on Discord, or email us. We never ask for your seed phrase or private key.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className={cp.btn}>
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          Discord
        </a>
        <a href={`mailto:${SUPPORT_EMAIL}`} className={cp.btn}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          {SUPPORT_EMAIL}
        </a>
        <Link to="/about" className={cp.btn}>
          About MemeWarzone
        </Link>
      </div>
    </section>
  );
}

function Breadcrumbs({ items }: { items: { to?: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] text-mw-muted">
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-1.5">
          {i > 0 ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          {it.to ? (
            <Link to={it.to} className="hover:text-mw-text">
              {it.label}
            </Link>
          ) : (
            <span className="text-[#C9CED4]">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function TopicNav({ current }: { current?: string }) {
  return (
    <nav aria-label="Help topics" className={cn(cp.card, "p-3")}>
      <div className={cn(EYEBROW, "px-2 pb-2 pt-1")}>Topics</div>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {HELP_TOPICS.map((t: Topic) => {
          const Icon = iconFor(t.id);
          const on = t.id === current;
          return (
            <li key={t.id}>
              <Link
                to={articlePath(t.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-[8px] px-2 py-2 text-[14px]",
                  on ? "bg-[#2A1609] font-semibold text-mw-accent-soft" : "text-[#C9CED4] hover:bg-[#171B20] hover:text-mw-text",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                <span className="text-[12px] text-[#6B737C]">{helpArticlesForTopic(t.id).length}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20">
      <div className="mx-auto w-full max-w-[1180px] space-y-4 px-1 pb-14 pt-4 font-mw-body text-mw-text md:space-y-5 md:px-2 md:pt-6">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ /faq */

function HelpIndex() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const results = useMemo(() => (query.trim() ? searchHelp(query, 40) : []), [query]);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (query.trim()) next.set("q", query.trim());
      else next.delete("q");
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useSeoOverride({ title: HELP_TITLE, description: HELP_DESCRIPTION });
  const popular = helpPopular();

  return (
    <PageShell>
      <section className="relative isolate overflow-hidden rounded-[18px] border border-mw-border">
        <img src="/assets/about/battles-bg.webp" alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-45" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[#0B0D10]/50 via-[#0B0D10]/85 to-[#0B0D10]" />
        <div className="mx-auto max-w-[760px] px-5 py-9 text-center md:py-14">
          <div className={EYEBROW}>Support</div>
          <h1 className="m-0 mt-2 font-mw-cond text-[38px] font-bold uppercase leading-none text-white md:text-[52px]">{HELP_TITLE}</h1>
          <p className="mx-auto mb-0 mt-3 max-w-[600px] text-[15px] leading-6 text-[#C9CED4] md:text-[16px]">
            {HELP_ARTICLES.length} answers about wallets, launching, trading, battles, leagues, rewards, fees and safety.
          </p>
          <div className="mt-6 text-left">
            <SearchBox value={query} onChange={setQuery} large />
          </div>
          {!query ? (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["graduation", "Boost", "fees", "Phantom", "import", "airdrop"].map((w) => (
                <button key={w} type="button" onClick={() => setQuery(w)} className={cn(cp.chip, "hover:border-[#3A424C] hover:text-mw-text")}>
                  {w}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {query.trim() ? (
        <section className={cn(cp.card, "p-5 md:p-6")} aria-live="polite">
          <h2 className="m-0 font-mw-cond text-xl font-bold text-mw-text">
            {results.length ? `${results.length} answer${results.length === 1 ? "" : "s"} for "${query.trim()}"` : `No answers for "${query.trim()}"`}
          </h2>
          {results.length ? (
            <div className="mt-4 grid gap-2.5 md:grid-cols-2">
              {results.map((a: Article) => (
                <ArticleRow key={a.slug} a={a} showTopic />
              ))}
            </div>
          ) : (
            <p className={cn("m-0 mt-2", BODY)}>Try fewer or other words, or pick a topic below. You can also ask on Discord.</p>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="m-0 mb-3 font-mw-cond text-2xl font-bold text-mw-text">Browse by topic</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {HELP_TOPICS.map((t: Topic) => {
            const Icon = iconFor(t.id);
            const n = helpArticlesForTopic(t.id).length;
            return (
              <Link
                key={t.id}
                to={articlePath(t.id)}
                className="group flex gap-3 rounded-[14px] border border-mw-border bg-mw-surface p-4 hover:border-[#7A3A0C] hover:bg-[#171B20]"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 font-mw-cond text-lg font-bold text-mw-text group-hover:text-mw-accent-soft">
                    {t.label}
                    <span className="text-[13px] font-semibold text-[#6B737C]">{n}</span>
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-mw-muted">{t.description}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {popular.length ? (
        <section className={cn(cp.card, "p-5 md:p-6")}>
          <h2 className="m-0 font-mw-cond text-2xl font-bold text-mw-text">Popular questions</h2>
          <div className="mt-4 grid gap-2.5 md:grid-cols-2">
            {popular.map((a: Article) => (
              <ArticleRow key={a.slug} a={a} showTopic />
            ))}
          </div>
        </section>
      ) : null}

      <StillNeedHelp />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ /faq/<topic> */

function TopicPage({ topic }: { topic: Topic }) {
  const [query, setQuery] = useState("");
  const all = helpArticlesForTopic(topic.id);
  const list = useMemo(() => {
    if (!query.trim()) return all;
    const hits = new Set(searchHelp(query, 500).map((a: Article) => a.slug));
    return all.filter((a: Article) => hits.has(a.slug));
  }, [query, all]);
  const head = helpHead(topic.id);
  useSeoOverride({ title: head?.title || topic.label, description: head?.description });
  const Icon = iconFor(topic.id);

  return (
    <PageShell>
      <Breadcrumbs items={[{ to: HELP_PATH, label: HELP_TITLE }, { label: topic.label }]} />
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-5">
        <aside className="hidden lg:block">
          <div className="sticky top-2">
            <TopicNav current={topic.id} />
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          <section className={cn(cp.card, "p-5 md:p-7")}>
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] border border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft">
                <Icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className={EYEBROW}>{all.length} answers</div>
                <h1 className="m-0 font-mw-cond text-[30px] font-bold leading-tight text-mw-text md:text-[36px]">{topic.label}</h1>
              </div>
            </div>
            <p className={cn("m-0 mt-3", BODY)}>{topic.description}</p>
            <div className="mt-4">
              <SearchBox value={query} onChange={setQuery} />
            </div>
          </section>
          <div className="grid gap-2.5">
            {list.map((a: Article) => (
              <ArticleRow key={a.slug} a={a} />
            ))}
            {!list.length ? <p className={BODY}>No answers in this topic match your search.</p> : null}
          </div>
          <StillNeedHelp />
        </div>
      </div>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ /faq/<article> */

function ArticlePage({ article }: { article: Article }) {
  const navigate = useNavigate();
  const head = helpHead(article.slug);
  const topic = HELP_TOPICS.find((t: Topic) => t.id === article.topic) as Topic;
  const related = helpRelated(article, 6);
  useSeoOverride({ title: article.q, description: head?.description });

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) navigate(-1);
    else navigate(articlePath(topic.id));
  };

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumbs items={[{ to: HELP_PATH, label: HELP_TITLE }, { to: articlePath(topic.id), label: topic.label }, { label: "Answer" }]} />
        <button type="button" onClick={goBack} className={cn(cp.btn, "min-h-9 px-3 text-[14px]")}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <article className={cn(cp.card, "min-w-0 p-5 md:p-8")}>
          <div className={EYEBROW}>{topic.label}</div>
          <h1 className="m-0 mt-2 font-mw-cond text-[28px] font-bold leading-tight text-mw-text md:text-[36px]">{article.q}</h1>
          <div className="mt-4 space-y-3 text-[16px] leading-7 text-[#D5D9DE]">
            {(article.a || []).map((t: string) => (
              <p key={t} className="m-0">
                {t}
              </p>
            ))}
          </div>
          {article.steps?.length ? (
            <ol className="m-0 mt-5 list-none space-y-2.5 p-0">
              {article.steps.map((s: string, i: number) => (
                <li key={s} className="flex gap-3 rounded-[12px] border border-mw-border bg-mw-input p-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-mw-accent bg-[#2A1609] font-mw-cond text-[14px] font-bold text-mw-accent-soft">
                    {i + 1}
                  </span>
                  <span className="min-w-0 pt-0.5 text-[15px] leading-6 text-[#D5D9DE]">{s}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {article.bullets?.length ? (
            <ul className="m-0 mt-5 list-none space-y-2 p-0">
              {article.bullets.map((b: string) => (
                <li key={b} className="flex gap-2.5 text-[15px] leading-6 text-[#D5D9DE]">
                  <span className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-mw-accent" aria-hidden="true" />
                  <span className="min-w-0">{b}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {article.links?.length ? (
            <div className="mt-6 flex flex-wrap gap-2">
              {article.links.map((l: { href: string; text: string }) =>
                l.href.startsWith("/") ? (
                  <Link key={l.href} to={l.href} className={cp.btn}>
                    {l.text}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : (
                  <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={cp.btn}>
                    {l.text}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ),
              )}
            </div>
          ) : null}
        </article>

        <aside className="space-y-4">
          {related.length ? (
            <section className={cn(cp.card, "p-4")}>
              <h2 className="m-0 px-1 font-mw-cond text-lg font-bold text-mw-text">Related questions</h2>
              <ul className="m-0 mt-2 list-none space-y-0.5 p-0">
                {related.map((a: Article) => (
                  <li key={a.slug}>
                    <Link to={articlePath(a.slug)} className="flex gap-2 rounded-[8px] px-2 py-2 text-[14px] leading-5 text-[#C9CED4] hover:bg-[#171B20] hover:text-mw-text">
                      <HelpCircle className="mt-[2px] h-4 w-4 shrink-0 text-mw-accent" aria-hidden="true" />
                      <span className="min-w-0">{a.q}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="hidden lg:block">
            <TopicNav current={topic.id} />
          </div>
        </aside>
      </div>
      <StillNeedHelp />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ router */

const HelpCenter = () => {
  const { slug } = useParams();
  if (!slug) return <HelpIndex />;
  const head = helpHead(slug);
  if (!head) return <NotFound />;
  if (head.kind === "topic") return <TopicPage topic={head.topic} />;
  return <ArticlePage article={head.article} />;
};

export default HelpCenter;
