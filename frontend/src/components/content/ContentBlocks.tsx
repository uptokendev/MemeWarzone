/**
 * Layout pieces shared by the public content pages (About, comparison pages). Layout only: the copy lives in
 * shared/aboutContent.mjs and shared/comparePages.mjs so the API renderer serves the same text to crawlers.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ExternalLink, HelpCircle, type LucideIcon } from "lucide-react";

import { cp } from "@/components/token/coinPageStyles";
import { cn } from "@/lib/utils";

export type ContentLink = { href: string; text: string };

export const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]";
export const GHOST_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-white/15 bg-black/40 px-4 text-[15px] font-semibold text-mw-text backdrop-blur hover:border-white/30 hover:bg-black/60 hover:text-mw-text";
export const JUMP_BTN =
  "mw-focus inline-flex min-h-10 items-center whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-3.5 text-[14px] font-semibold text-[#C9CED4] hover:border-[#3A424C] hover:bg-[#1F252C] hover:text-mw-text";
export const EYEBROW = "font-mw-cond text-xs font-semibold uppercase tracking-[0.12em] text-[#FF9A4D]";
export const H2 = "m-0 font-mw-cond text-[26px] font-bold leading-tight text-mw-text md:text-[30px]";
export const BODY = "text-[15px] leading-6 text-mw-muted";

export function AnyLink({ link, className, children }: { link: ContentLink; className: string; children?: ReactNode }) {
  if (link.href.startsWith("/")) {
    return (
      <Link to={link.href} className={className}>
        {children ?? link.text}
      </Link>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>
      {children ?? link.text}
      {children ? null : <ExternalLink className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />}
    </a>
  );
}

export function Links({ links }: { links?: ContentLink[] }) {
  if (!links?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {links.map((l) => (
        <AnyLink key={l.href} link={l} className={cp.btn} />
      ))}
    </div>
  );
}

export function SectionHead({ index, heading, icon: Icon }: { index?: number; heading: string; icon: LucideIcon }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        {index ? <div className={EYEBROW}>{String(index).padStart(2, "0")}</div> : null}
        <h2 className={H2}>{heading}</h2>
      </div>
    </div>
  );
}

export function CheckList({ items, icon: Icon = Check }: { items?: string[]; icon?: LucideIcon }) {
  if (!items?.length) return null;
  return (
    <ul className="m-0 list-none space-y-2.5 p-0">
      {items.map((item) => (
        <li key={item} className={cn("flex gap-2.5", BODY)}>
          <Icon className="mt-[3px] h-[18px] w-[18px] shrink-0 text-mw-accent" aria-hidden="true" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Questions as open cards (not collapsed), so the answers are visible text. */
export function QaList({ qa }: { qa?: { q: string; a: string }[] }) {
  if (!qa?.length) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {qa.map((x) => (
        <div key={x.q} className="rounded-[12px] border border-mw-border bg-mw-input p-4">
          <h3 className="m-0 flex gap-2 font-mw-cond text-lg font-bold leading-snug text-mw-text">
            <HelpCircle className="mt-[3px] h-[18px] w-[18px] shrink-0 text-mw-accent" aria-hidden="true" />
            {x.q}
          </h3>
          <p className={cn("m-0 mt-2", BODY)}>{x.a}</p>
        </div>
      ))}
    </div>
  );
}

const SPLIT_COLORS = ["bg-mw-accent text-[#140A02]", "bg-[#7A3A0C] text-[#FFD9B8]", "bg-[#2A2F36] text-[#C9CED4]"];

/** A percentage bar with a legend, e.g. where the buy-ins go. */
export function SplitBar({ title, segments, icon: Icon }: { title: string; segments: { pct: number; label: string }[]; icon: LucideIcon }) {
  return (
    <div className="rounded-[14px] border border-white/10 bg-black/55 p-4 backdrop-blur md:p-5">
      <div className="flex items-center gap-2 font-mw-cond text-lg font-bold text-white">
        <Icon className="h-5 w-5 text-mw-accent" aria-hidden="true" />
        {title}
      </div>
      <div className="mt-3 flex h-10 overflow-hidden rounded-[10px] border border-white/10 font-mw-cond text-[15px] font-bold">
        {segments.map((g, i) => (
          <div
            key={g.label}
            className={cn("flex min-w-[44px] items-center justify-center px-2", SPLIT_COLORS[i] ?? SPLIT_COLORS[2])}
            style={{ width: `${g.pct}%` }}
          >
            {g.pct}%
          </div>
        ))}
      </div>
      <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-[13px] text-mw-muted">
        {segments.map((g, i) => (
          <li key={g.label} className="flex items-center gap-2">
            <span className={cn("h-2.5 w-2.5 rounded-sm", (SPLIT_COLORS[i] ?? SPLIT_COLORS[2]).split(" ")[0])} aria-hidden="true" />
            {g.pct}% {g.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
