/**
 * About: what MemeWarzone is, a coin's life, battles, leagues, creators, recruiters, safety, contracts, roadmap and team.
 * The copy lives in shared/aboutContent.mjs so the API renderer serves the same text to crawlers.
 * Edit the copy there; this file is layout only.
 */
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  Coins,
  Copy,
  Crown,
  ExternalLink,
  FileCode2,
  GraduationCap,
  HelpCircle,
  LineChart,
  Map as MapIcon,
  Rocket,
  ShieldCheck,
  Swords,
  Trophy,
  Users,
  UsersRound,
  Vote,
} from "lucide-react";

import {
  BODY,
  CheckList,
  EYEBROW,
  GHOST_BTN,
  JUMP_BTN,
  Links,
  PRIMARY_BTN,
  QaList,
  SectionHead,
  SplitBar,
} from "@/components/content/ContentBlocks";
import { cp } from "@/components/token/coinPageStyles";
import { socialLinks } from "@/constants/navigation";
import { cn } from "@/lib/utils";
import {
  ABOUT_CHAINS,
  ABOUT_DISAMBIGUATION,
  ABOUT_HERO_LINKS,
  ABOUT_HIGHLIGHTS,
  ABOUT_INTRO,
  ABOUT_NEXT_CHAIN,
  ABOUT_SECTIONS,
  ABOUT_TITLE,
} from "../../shared/aboutContent.mjs";

type Section = (typeof ABOUT_SECTIONS)[number];

const STEP_ICONS = [Rocket, LineChart, GraduationCap, Swords];
const ROADMAP_ICONS = [Rocket, MapIcon, Coins];
const MODE_ICONS = [BarChart3, Vote];
const SPLIT_ICONS = [Coins, Crown];

const section = (id: string): Section | undefined => ABOUT_SECTIONS.find((s) => s.id === id);

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
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {ABOUT_CHAINS.map((c) => (
            <span key={c} className={cp.chipAccent}>
              {c}
            </span>
          ))}
          <span className={cn(cp.chip, "border-dashed")}>
            {ABOUT_NEXT_CHAIN.name}: {ABOUT_NEXT_CHAIN.label}
          </span>
        </div>
        <p className="m-0 mt-2 text-[14px] leading-6 text-[#C9CED4]">{ABOUT_NEXT_CHAIN.text}</p>
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

function Steps({ steps, icons, label }: { steps: { title: string; text: string }[]; icons: typeof STEP_ICONS; label: string }) {
  const cols = steps.length === 3 ? "md:grid-cols-3" : "md:grid-cols-4";
  return (
    <ol className={cn("relative m-0 mt-6 grid list-none gap-3 p-0 md:gap-4", cols)}>
      <div className="absolute left-[10%] right-[10%] top-[22px] hidden h-px bg-gradient-to-r from-[#7A3A0C] via-mw-accent to-[#7A3A0C] md:block" aria-hidden="true" />
      {steps.map((step, i) => {
        const Icon = icons[i] ?? Rocket;
        return (
          <li key={step.title} className="relative flex gap-3 md:flex-col md:items-center md:text-center">
            <span className="relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-mw-accent bg-[#2A1609] text-mw-accent-soft">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 md:mt-1">
              <div className="font-mw-cond text-[13px] font-semibold uppercase tracking-[0.1em] text-[#8D949C]">
                {label} {i + 1}
              </div>
              <div className="font-mw-cond text-xl font-bold text-mw-text">{step.title}</div>
              <p className={cn("m-0 mt-1", BODY)}>{step.text}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Card({ s, index, icon, children, className }: { s: Section; index: number; icon: typeof Rocket; children: React.ReactNode; className?: string }) {
  return (
    <section id={s.id} className={cn(cp.card, "scroll-mt-20 p-5 md:p-7", className)}>
      <SectionHead index={index} heading={s.heading} icon={icon} />
      {children}
    </section>
  );
}

function CoinLife({ s, index }: { s: Section; index: number }) {
  return (
    <Card s={s} index={index} icon={Rocket}>
      <Steps steps={s.steps || []} icons={STEP_ICONS} label="Step" />
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
    </Card>
  );
}

function Battles({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className="relative isolate scroll-mt-20 overflow-hidden rounded-[14px] border border-mw-border p-5 md:p-7">
      {s.image ? <img src={s.image} alt="" aria-hidden="true" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-50" /> : null}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[#0B0D10]/70 via-[#0B0D10]/88 to-[#0B0D10]" />

      <SectionHead index={index} heading={s.heading} icon={Swords} />
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

      {s.splits?.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {s.splits.map((x, i) => (
            <SplitBar key={x.title} title={x.title} segments={x.segments} icon={SPLIT_ICONS[i] ?? Crown} />
          ))}
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
    <Card s={s} index={index} icon={Trophy}>
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
    </Card>
  );
}

function Creators({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "flex scroll-mt-20 flex-col p-5 md:p-7")}>
      <div className="flex items-start justify-between gap-3">
        <SectionHead index={index} heading={s.heading} icon={Rocket} />
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
        <SectionHead index={index} heading={s.heading} icon={Users} />
        {s.lead ? <p className={cn("m-0 mt-3", BODY)}>{s.lead}</p> : null}
        <div className="mt-4">
          <CheckList items={s.items} />
        </div>
        <div className="mt-auto pt-4">
          <Links links={s.links} />
        </div>
      </div>
    </section>
  );
}

function Banner({ s, index }: { s: Section; index: number }) {
  return (
    <section id={s.id} className={cn(cp.card, "flex scroll-mt-20 flex-col gap-4 p-5 md:flex-row md:items-center md:gap-6 md:p-7")}>
      <div className="md:w-[320px] md:shrink-0">
        <SectionHead index={index} heading={s.heading} icon={Users} />
      </div>
      {s.lead ? <p className={cn("m-0", BODY)}>{s.lead}</p> : null}
    </section>
  );
}

function Safety({ s, index }: { s: Section; index: number }) {
  return (
    <Card s={s} index={index} icon={ShieldCheck}>
      <ul className="m-0 mt-5 grid list-none gap-3 p-0 md:grid-cols-2">
        {(s.items || []).map((item) => (
          <li key={item} className="flex gap-3 rounded-[12px] border border-mw-border bg-mw-input p-4">
            <ShieldCheck className="mt-[2px] h-5 w-5 shrink-0 text-mw-accent" aria-hidden="true" />
            <span className={cn("min-w-0", BODY)}>{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(value);
        } catch {
          // clipboard unavailable: the address stays selectable
        }
      }}
      aria-label="Copy address"
      className="mw-focus inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-mw-muted hover:bg-[#1F252C] hover:text-mw-text"
    >
      <Copy className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function Contracts({ s, index }: { s: Section; index: number }) {
  return (
    <Card s={s} index={index} icon={FileCode2}>
      {s.lead ? <p className={cn("m-0 mt-3 max-w-3xl", BODY)}>{s.lead}</p> : null}
      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {(s.contracts || []).map((c) => (
          <div key={c.chain} className="flex flex-col rounded-[12px] border border-mw-border bg-mw-input p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mw-cond text-xl font-bold text-mw-text">{c.chain}</div>
              <span className="inline-flex h-[26px] items-center rounded-full border border-[#6B5A12] bg-[#231E07] px-2.5 text-[12px] font-semibold text-[#F2D46B]">
                {c.audit}
              </span>
            </div>
            <ul className="m-0 mt-3 list-none space-y-2.5 p-0">
              {c.entries.map((e) => (
                <li key={e.label + e.address}>
                  <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#8D949C]">{e.label}</div>
                  <div className="mt-0.5 flex items-start gap-1">
                    <a
                      href={e.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 break-all font-mw-mono text-[13px] leading-5 text-mw-text hover:text-mw-accent-soft"
                      title={e.address}
                    >
                      {e.address}
                    </a>
                    <CopyButton value={e.address} />
                    <a href={e.href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${e.label} in the explorer`} className="mw-focus inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-mw-muted hover:bg-[#1F252C] hover:text-mw-text">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {s.note ? <p className={cn("m-0 mt-4", BODY, "text-[14px]")}>{s.note}</p> : null}
    </Card>
  );
}

function Roadmap({ s, index }: { s: Section; index: number }) {
  return (
    <Card s={s} index={index} icon={MapIcon}>
      <Steps steps={s.steps || []} icons={ROADMAP_ICONS} label="Next" />
    </Card>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

function Team({ s, index }: { s: Section; index: number }) {
  const socials = new Set(socialLinks.map((x) => x.href));
  return (
    <Card s={s} index={index} icon={UsersRound}>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {(s.members || []).map((m) => (
          <div key={m.name} className="flex items-center gap-3 rounded-[12px] border border-mw-border bg-mw-input p-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-mw-accent bg-[#2A1609] font-mw-cond text-lg font-bold text-mw-accent-soft">
              {initials(m.name)}
            </span>
            <div className="min-w-0">
              <div className="font-mw-cond text-lg font-bold leading-tight text-mw-text">{m.name}</div>
              <div className="text-[13px] text-mw-muted">{m.role}</div>
            </div>
          </div>
        ))}
      </div>
      {s.lead ? <p className={cn("m-0 mt-5", BODY)}>{s.lead}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {socialLinks.map((x) => (
          <a key={x.href} href={x.href} target="_blank" rel="noopener noreferrer" className={cn(cp.btn, "gap-2.5")}>
            <img src={x.svgUrl} alt="" aria-hidden="true" className="h-[18px] w-[18px]" />
            {x.ariaLabel}
          </a>
        ))}
      </div>
      <div className="mt-2">
        <Links links={(s.links || []).filter((l) => !socials.has(l.href))} />
      </div>
    </Card>
  );
}

function GoodToKnow({ s, index }: { s: Section; index: number }) {
  return (
    <Card s={s} index={index} icon={HelpCircle}>
      <div className="mt-5">
        <QaList qa={s.qa} />
      </div>
      <div className="mt-4">
        <Links links={s.links} />
      </div>
    </Card>
  );
}

const About = () => {
  const by = (id: string) => section(id);
  const n = (s?: Section) => (s ? ABOUT_SECTIONS.indexOf(s) + 1 : 0);
  const coinLife = by("coin-life");
  const battles = by("battles");
  const leagues = by("leagues");
  const creators = by("creators");
  const recruiters = by("recruiters");
  const social = by("social");
  const safety = by("safety");
  const contracts = by("contracts");
  const roadmap = by("roadmap");
  const team = by("team");
  const good = by("good-to-know");

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

        {social ? <Banner s={social} index={n(social)} /> : null}
        {safety ? <Safety s={safety} index={n(safety)} /> : null}
        {contracts ? <Contracts s={contracts} index={n(contracts)} /> : null}
        {roadmap ? <Roadmap s={roadmap} index={n(roadmap)} /> : null}
        {team ? <Team s={team} index={n(team)} /> : null}
        {good ? <GoodToKnow s={good} index={n(good)} /> : null}
      </div>
    </div>
  );
};

export default About;
