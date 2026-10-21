/**
 * About: what MemeWarzone is, how a coin's life works, battles, leagues, creators, recruiters, safety and who runs it.
 * The copy lives in shared/aboutContent.mjs so the API renderer serves the same text to crawlers.
 * Edit the copy there; this file is layout only.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Check,
  Crown,
  ExternalLink,
  GraduationCap,
  LineChart,
  Rocket,
  Scale,
  ShieldCheck,
  Swords,
  Trophy,
  Users,
  Vote,
} from "lucide-react";

import { cp } from "@/components/token/coinPageStyles";
import { socialLinks } from "@/constants/navigation";
import { cn } from "@/lib/utils";
import {
  ABOUT_CHAINS,
  ABOUT_DISAMBIGUATION,
  ABOUT_HERO_LINKS,
  ABOUT_HIGHLIGHTS,
  ABOUT_INTRO,
  ABOUT_SECTIONS,
  ABOUT_TITLE,
} from "../../shared/aboutContent.mjs";

type AboutLink = { href: string; text: string };
type Section = (typeof ABOUT_SECTIONS)[number];

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]";
const GHOST_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-white/15 bg-black/40 px-4 text-[15px] font-semibold text-mw-text backdrop-blur hover:border-white/30 hover:bg-black/60 hover:text-mw-text";
const JUMP_BTN =
  "mw-focus inline-flex min-h-10 items-center whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-3.5 text-[14px] font-semibold text-[#C9CED4] hover:border-[#3A424C] hover:bg-[#1F252C] hover:text-mw-text";
const EYEBROW = "font-mw-cond text-xs font-semibold uppercase tracking-[0.12em] text-[#FF9A4D]";
const H2 = "m-0 font-mw-cond text-[26px] font-bold leading-tight text-mw-text md:text-[30px]";
const BODY = "text-[15px] leading-6 text-mw-muted";

const STEP_ICONS = [Rocket, LineChart, GraduationCap, Swords];
const MODE_ICONS = [BarChart3, Vote];

const section = (id: string): Section | undefined => ABOUT_SECTIONS.find((s) => s.id === id);

function AnyLink({ link, className, children }: { link: AboutLink; className: string; children?: ReactNode }) {
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

function Links({ links }: { links?: AboutLink[] }) {
  if (!links?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {links.map((l) => (
        <AnyLink key={l.href} link={l} className={cp.btn} />
      ))}
    </div>
  );
}

function SectionHead({ index, s, icon: Icon }: { index: number; s: Section; icon: typeof Rocket }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className={EYEBROW}>{String(index).padStart(2, "0")}</div>
        <h2 className={H2}>{s.heading}</h2>
      </div>
    </div>
  );
}

function CheckList({ items, icon: Icon = Check }: { items?: string[]; icon?: typeof Check }) {
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

function Hero() {
  return (
    <section className="relative isolate overflow-hidden rounded-[18px] border border-mw-border">
      <img
        src="/assets/about/hero.webp"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 -z-10 h-full w-full object-cover object-[72%_center]"
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0B0D10] via-[#0B0D10]/80 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-[#0B0D10] to-transparent" />

      <div className="max-w-[640px] px-5 py-8 md:px-9 md:py-12">
        <div className={EYEBROW}>About</div>
        <h1 className="m-0 mt-2 font-mw-cond text-[40px] font-bold uppercase leading-[0.95] tracking-[0.01em] text-white md:text-[56px]">
          {ABOUT_TITLE}
        </h1>
        <div className="mt-4 space-y-3 text-[16px] leading-7 text-[#D5D9DE]">
          {ABOUT_INTRO.map((line) => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {ABOUT_CHAINS.map((c) => (
            <span key={c} className={cp.chipAccent}>
              {c}
            </span>
          ))}
        </div>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {ABOUT_HERO_LINKS.map((l, i) => (
            <Link key={l.href} to={l.href} className={i === 0 ? PRIMARY_BTN : GHOST_BTN}>
              {l.text}
              {i === 0 ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
            </Link>
          ))}
        </div>
        <p className="m-0 mt-5 text-[13px] text-[#8D949C]">{ABOUT_DISAMBIGUATION}</p>
      </div>
    </section>
  );
}

function Highlights() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {ABOUT_HIGHLIGHTS.map((h) => (
        <div key={h.value} className={cn(cp.card, "p-4")}>
          <div className="font-mw-cond text-[28px] font-bold leading-none text-mw-accent md:text-[32px]">{h.value}</div>
          <div className="mt-2 text-[13px] leading-5 text-mw-muted">{h.label}</div>
        </div>
      ))}
    </div>
  );
}

function CoinLife({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7")}>
      <SectionHead index={index} s={s} icon={Rocket} />
      <ol className="relative m-0 mt-6 grid list-none gap-3 p-0 md:grid-cols-4 md:gap-4">
        <div className="absolute left-[10%] right-[10%] top-[22px] hidden h-px bg-gradient-to-r from-[#7A3A0C] via-mw-accent to-[#7A3A0C] md:block" aria-hidden="true" />
        {(s.steps || []).map((step, i) => {
          const Icon = STEP_ICONS[i] ?? Rocket;
          return (
            <li key={step.title} className="relative flex gap-3 md:flex-col md:items-center md:text-center">
              <span className="relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-mw-accent bg-[#2A1609] text-mw-accent-soft">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 md:mt-1">
                <div className="font-mw-cond text-[13px] font-semibold uppercase tracking-[0.1em] text-[#8D949C]">Step {i + 1}</div>
                <div className="font-mw-cond text-xl font-bold text-mw-text">{step.title}</div>
                <p className={cn("m-0 mt-1", BODY)}>{step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {s.chips?.length ? (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {s.chipsLabel ? <span className="mr-1 text-[13px] font-semibold text-mw-text">{s.chipsLabel}</span> : null}
          {s.chips.map((c) => (
            <span key={c} className={cp.chip}>
              {c}
            </span>
          ))}
        </div>
      ) : null}
      {s.note ? (
        <p className="m-0 mt-4 rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] p-3 text-[14px] leading-6 text-[#E8D5C4]">{s.note}</p>
      ) : null}
      <div className="mt-4">
        <Links links={s.links} />
      </div>
    </section>
  );
}

function Battles({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className="relative isolate scroll-mt-20 overflow-hidden rounded-[14px] border border-mw-border p-5 md:p-7">
      {s.image ? (
        <img src={s.image} alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-50" />
      ) : null}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[#0B0D10]/70 via-[#0B0D10]/88 to-[#0B0D10]" />

      <SectionHead index={index} s={s} icon={Swords} />
      {s.lead ? <p className={cn("m-0 mt-3 max-w-3xl", BODY, "text-[#C9CED4]")}>{s.lead}</p> : null}

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {(s.modes || []).map((m, i) => {
          const Icon = MODE_ICONS[i] ?? BarChart3;
          return (
            <div key={m.name} className="rounded-[14px] border border-white/10 bg-black/55 p-4 backdrop-blur md:p-5">
              <div className="flex items-center gap-2.5">
                <Icon className="h-5 w-5 text-mw-accent" aria-hidden="true" />
                <div className="font-mw-cond text-xl font-bold text-white">{m.name}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {m.durations.map((d) => (
                  <span key={d} className={cp.chipAccent}>
                    {d}
                  </span>
                ))}
              </div>
              <p className={cn("m-0 mt-3", BODY, "text-[#C9CED4]")}>{m.text}</p>
            </div>
          );
        })}
      </div>

      {s.pool ? (
        <div className="mt-5 rounded-[14px] border border-white/10 bg-black/55 p-4 backdrop-blur md:p-5">
          <div className="flex items-center gap-2 font-mw-cond text-lg font-bold text-white">
            <Crown className="h-5 w-5 text-mw-accent" aria-hidden="true" />
            Where Boost money goes
          </div>
          <div className="mt-3 flex h-10 overflow-hidden rounded-[10px] border border-white/10 font-mw-cond text-[15px] font-bold">
            <div className="flex items-center bg-mw-accent px-3 text-[#140A02]" style={{ width: `${s.pool.winnerPct}%` }}>
              {s.pool.winnerPct}%
            </div>
            <div className="flex flex-1 items-center justify-center bg-[#2A2F36] text-[#C9CED4]">{s.pool.protocolPct}%</div>
          </div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-[13px] text-mw-muted">
            <span>{s.pool.winnerLabel}</span>
            <span>{s.pool.protocolLabel}</span>
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <CheckList items={s.items} />
      </div>
      <div className="mt-4">
        <Links links={s.links} />
      </div>
    </section>
  );
}

function Leagues({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7")}>
      <SectionHead index={index} s={s} icon={Trophy} />
      {s.lead ? <p className={cn("m-0 mt-3 max-w-3xl", BODY)}>{s.lead}</p> : null}
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(s.categories || []).map((c) => (
          <div key={c.name} className="flex items-center gap-3 rounded-[12px] border border-mw-border bg-mw-input p-3">
            <img src={c.image} alt={`${c.name} badge`} loading="lazy" width={64} height={64} className="h-16 w-16 shrink-0 rounded-[10px] object-cover" />
            <div className="min-w-0">
              <div className="font-mw-cond text-lg font-bold leading-tight text-mw-text">{c.name}</div>
              <p className="m-0 mt-0.5 text-[13px] leading-5 text-mw-muted">{c.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <CheckList items={s.items} icon={Trophy} />
      </div>
      <div className="mt-4">
        <Links links={s.links} />
      </div>
    </section>
  );
}

function Creators({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "flex scroll-mt-20 flex-col p-5 md:p-7")}>
      <div className="flex items-start justify-between gap-3">
        <SectionHead index={index} s={s} icon={Rocket} />
        {s.image ? (
          <img src={s.image} alt="UpVote" loading="lazy" width={88} height={88} className="-mr-1 -mt-2 h-[72px] w-[72px] shrink-0 md:h-[88px] md:w-[88px]" />
        ) : null}
      </div>
      <div className="mt-5">
        <CheckList items={s.items} />
      </div>
      <div className="mt-auto pt-4">
        <Links links={s.links} />
      </div>
    </section>
  );
}

function Recruiters({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "flex scroll-mt-20 flex-col overflow-hidden")}>
      {s.image ? (
        <img src={s.image} alt="MemeWarzone recruiters" loading="lazy" width={680} height={400} className="aspect-[17/10] w-full object-cover" />
      ) : null}
      <div className="flex flex-1 flex-col p-5 md:p-7">
        <SectionHead index={index} s={s} icon={Users} />
        {s.lead ? <p className={cn("m-0 mt-3", BODY)}>{s.lead}</p> : null}
        <div className="mt-auto pt-4">
          <Links links={s.links} />
        </div>
      </div>
    </section>
  );
}

function Banner({ s, index, icon: Icon }: { s: Section; index: number; icon: typeof Rocket }) {
  return (
    <section id={s.id} className={cn(cp.card, "flex scroll-mt-20 flex-col gap-4 p-5 md:flex-row md:items-center md:gap-6 md:p-7")}>
      <div className="md:w-[320px] md:shrink-0">
        <SectionHead index={index} s={s} icon={Icon} />
      </div>
      {s.lead ? <p className={cn("m-0", BODY)}>{s.lead}</p> : null}
    </section>
  );
}

function Safety({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7")}>
      <SectionHead index={index} s={s} icon={ShieldCheck} />
      <ul className="m-0 mt-5 grid list-none gap-3 p-0 md:grid-cols-2">
        {(s.items || []).map((item) => (
          <li key={item} className="flex gap-3 rounded-[12px] border border-mw-border bg-mw-input p-4">
            <ShieldCheck className="mt-[2px] h-5 w-5 shrink-0 text-mw-accent" aria-hidden="true" />
            <span className={cn("min-w-0", BODY)}>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Company({ s, index }: { s: Section; index: number }) {
  const socials = new Set(socialLinks.map((x) => x.href));
  const links = s.links || [];
  return (
    <section id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7")}>
      <SectionHead index={index} s={s} icon={Scale} />
      {s.lead ? <p className={cn("m-0 mt-3", BODY)}>{s.lead}</p> : null}
      <div className="mt-5 flex flex-wrap gap-2">
        {socialLinks.map((x) => (
          <a
            key={x.href}
            href={x.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(cp.btn, "gap-2.5")}
          >
            <img src={x.svgUrl} alt="" aria-hidden="true" className="h-[18px] w-[18px]" />
            {x.ariaLabel}
          </a>
        ))}
        {links
          .filter((l) => !socials.has(l.href))
          .map((l) => (
            <AnyLink key={l.href} link={l} className={cp.btn} />
          ))}
      </div>
    </section>
  );
}

const About = () => {
  const coinLife = section("coin-life");
  const battles = section("battles");
  const leagues = section("leagues");
  const creators = section("creators");
  const recruiters = section("recruiters");
  const social = section("social");
  const safety = section("safety");
  const company = section("company");
  const n = (s?: Section) => (s ? ABOUT_SECTIONS.indexOf(s) + 1 : 0);

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20">
      <div className="mx-auto w-full max-w-[1180px] space-y-4 px-1 pb-14 pt-4 font-mw-body text-mw-text md:space-y-5 md:px-2 md:pt-6">
        <Hero />
        <Highlights />

        <nav
          className="sticky top-0 z-20 -mx-1 flex gap-2 overflow-x-auto bg-[#0B0D10]/90 px-1 py-2 backdrop-blur md:mx-0 md:flex-wrap md:px-0"
          aria-label="About sections"
        >
          {ABOUT_SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={JUMP_BTN}>
              {s.nav}
            </a>
          ))}
        </nav>

        {coinLife ? <CoinLife s={coinLife} index={n(coinLife)} /> : null}
        {battles ? <Battles s={battles} index={n(battles)} /> : null}
        {leagues ? <Leagues s={leagues} index={n(leagues)} /> : null}

        <div className="grid gap-4 md:gap-5 lg:grid-cols-2">
          {creators ? <Creators s={creators} index={n(creators)} /> : null}
          {recruiters ? <Recruiters s={recruiters} index={n(recruiters)} /> : null}
        </div>

        {social ? <Banner s={social} index={n(social)} icon={Users} /> : null}
        {safety ? <Safety s={safety} index={n(safety)} /> : null}

        {company ? <Company s={company} index={n(company)} /> : null}
      </div>
    </div>
  );
};

export default About;
