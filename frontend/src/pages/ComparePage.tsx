/**
 * "MemeWarzone vs X" comparison pages. The copy lives in shared/comparePages.mjs so the API renderer serves the
 * same text to crawlers. Edit the copy there; this file is layout only.
 */
import { Link } from "react-router-dom";
import { ArrowRight, Check, Coins, Info, Rocket, Scale, ShieldCheck, Swords, Trophy } from "lucide-react";

import NotFound from "@/pages/NotFound";
import { BODY, CheckList, EYEBROW, GHOST_BTN, JUMP_BTN, Links, PRIMARY_BTN, QaList, SectionHead } from "@/components/content/ContentBlocks";
import { cp } from "@/components/token/coinPageStyles";
import { cn } from "@/lib/utils";
import { comparePageFor } from "../../shared/comparePages.mjs";

const SECTION_ICONS: Record<string, typeof Rocket> = {
  chains: Coins,
  launch: Rocket,
  fees: Coins,
  compete: Swords,
  trust: ShieldCheck,
  "pumpfun-ahead": Trophy,
  faq: Info,
};

type Row = { feature: string; mwz: string; other: string };

function CompareTable({ rows, competitor }: { rows: Row[]; competitor: string }) {
  return (
    <>
      {/* Desktop: a real table */}
      <div className="mt-5 hidden overflow-hidden rounded-[12px] border border-mw-border md:block">
        <table className="w-full border-collapse text-left text-[14px]">
          <thead>
            <tr className="bg-[#171B20]">
              <th className="w-[22%] px-4 py-3 font-mw-cond text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8D949C]">Feature</th>
              <th className="w-[39%] px-4 py-3 font-mw-cond text-[13px] font-semibold uppercase tracking-[0.08em] text-mw-accent">MemeWarzone</th>
              <th className="w-[39%] px-4 py-3 font-mw-cond text-[13px] font-semibold uppercase tracking-[0.08em] text-[#B9A6FF]">{competitor}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.feature} className="border-t border-mw-border align-top">
                <td className="px-4 py-3 font-semibold text-mw-text">{r.feature}</td>
                <td className="px-4 py-3 leading-6 text-[#D5D9DE]">{r.mwz}</td>
                <td className="px-4 py-3 leading-6 text-mw-muted">{r.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile: one card per feature */}
      <div className="mt-5 space-y-3 md:hidden">
        {rows.map((r) => (
          <div key={r.feature} className="rounded-[12px] border border-mw-border bg-mw-input p-4">
            <div className="font-mw-cond text-lg font-bold text-mw-text">{r.feature}</div>
            <div className="mt-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-mw-accent">MemeWarzone</div>
            <p className={cn("m-0", BODY, "text-[#D5D9DE]")}>{r.mwz}</p>
            <div className="mt-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#B9A6FF]">{competitor}</div>
            <p className={cn("m-0", BODY)}>{r.other}</p>
          </div>
        ))}
      </div>
    </>
  );
}

const ComparePage = ({ path }: { path: string }) => {
  const page = comparePageFor(path);
  if (!page) return <NotFound />;

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20">
      <div className="mx-auto w-full max-w-[1180px] space-y-4 px-1 pb-14 pt-4 font-mw-body text-mw-text md:space-y-5 md:px-2 md:pt-6">
        {/* Hero */}
        <section className="relative isolate overflow-hidden rounded-[18px] border border-mw-border">
          <img src="/assets/about/battles-bg.webp" alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-60" />
          <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[#0B0D10]/60 via-[#0B0D10]/85 to-[#0B0D10]" />
          <div className="px-5 py-8 text-center md:px-9 md:py-12">
            <div className={EYEBROW}>Launchpad comparison · Checked {page.checkedOn}</div>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3 md:gap-5">
              <span className="rounded-[12px] border-2 border-mw-accent bg-[#2A1609] px-5 py-2.5 font-mw-cond text-2xl font-bold text-mw-accent-soft md:text-3xl">
                MemeWarzone
              </span>
              <span className="font-mw-cond text-2xl font-bold text-[#8D949C]">VS</span>
              <span className="rounded-[12px] border-2 border-[#7B5CF0] bg-[#1A1430] px-5 py-2.5 font-mw-cond text-2xl font-bold text-[#C9B8FF] md:text-3xl">
                {page.competitor}
              </span>
            </div>
            <h1 className="m-0 mt-5 font-mw-cond text-[34px] font-bold uppercase leading-none text-white md:text-[48px]">{page.title}</h1>
            <div className="mx-auto mt-4 max-w-[720px] space-y-3 text-[16px] leading-7 text-[#D5D9DE]">
              {page.intro.map((line: string) => (
                <p key={line} className="m-0">
                  {line}
                </p>
              ))}
            </div>
            <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
              <Link to="/create" className={PRIMARY_BTN}>
                Launch a coin <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link to="/about" className={GHOST_BTN}>
                About MemeWarzone
              </Link>
            </div>
          </div>
        </section>

        <p className="m-0 flex gap-2 rounded-[12px] border border-mw-border bg-mw-surface p-4 text-[13px] leading-5 text-mw-muted">
          <Info className="mt-[2px] h-4 w-4 shrink-0 text-mw-accent" aria-hidden="true" />
          {page.disclaimer}
        </p>

        {/* Verdict */}
        <div className="grid gap-3 md:grid-cols-2">
          {page.verdicts.map((v: { who: string; title: string; items: string[] }) => {
            const mine = v.who === "mwz";
            return (
              <div
                key={v.title}
                className={cn(
                  "rounded-[14px] border p-5 md:p-6",
                  mine ? "border-[#7A3A0C] bg-[#1C1007]" : "border-[#3B2F66] bg-[#130F22]",
                )}
              >
                <div className={cn("font-mw-cond text-xl font-bold", mine ? "text-mw-accent-soft" : "text-[#C9B8FF]")}>{v.title}</div>
                <ul className="m-0 mt-3 list-none space-y-2 p-0">
                  {v.items.map((item) => (
                    <li key={item} className={cn("flex gap-2.5", BODY, "text-[#D5D9DE]")}>
                      <Check className={cn("mt-[3px] h-[18px] w-[18px] shrink-0", mine ? "text-mw-accent" : "text-[#9C85F5]")} aria-hidden="true" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <nav
          className="sticky top-0 z-20 -mx-1 flex gap-2 overflow-x-auto bg-[#0B0D10]/90 px-1 py-2 backdrop-blur md:mx-0 md:flex-wrap md:px-0"
          aria-label="Comparison sections"
        >
          {page.sections.map((s: { id: string; nav: string }) => (
            <a key={s.id} href={`#${s.id}`} className={JUMP_BTN}>
              {s.nav}
            </a>
          ))}
        </nav>

        {page.sections.map((s: any, i: number) => (
          <section key={s.id} id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7")}>
            <SectionHead index={i + 1} heading={s.heading} icon={SECTION_ICONS[s.id] ?? Scale} />
            {s.lead ? <p className={cn("m-0 mt-3 max-w-3xl", BODY)}>{s.lead}</p> : null}
            {s.rows?.length ? <CompareTable rows={s.rows} competitor={page.competitor} /> : null}
            {s.items?.length ? (
              <div className="mt-4">
                <CheckList items={s.items} />
              </div>
            ) : null}
            {s.qa?.length ? (
              <div className="mt-5">
                <QaList qa={s.qa} />
              </div>
            ) : null}
            {s.note ? <p className={cn("m-0 mt-4", BODY)}>{s.note}</p> : null}
            {s.links?.length ? (
              <div className="mt-4">
                <Links links={s.links} />
              </div>
            ) : null}
          </section>
        ))}

        <section className={cn(cp.card, "p-5 md:p-7")}>
          <h2 className="m-0 font-mw-cond text-xl font-bold text-mw-text">Sources</h2>
          <ul className="m-0 mt-3 list-none space-y-1.5 p-0 text-[14px]">
            {page.sources.map((x: { text: string; href: string; date: string }) => (
              <li key={x.href} className="text-mw-muted">
                <a href={x.href} target="_blank" rel="noopener noreferrer" className="text-mw-text underline-offset-2 hover:text-mw-accent-soft hover:underline">
                  {x.text}
                </a>{" "}
                ({x.date})
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

export default ComparePage;
