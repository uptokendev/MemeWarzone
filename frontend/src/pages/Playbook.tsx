/**
 * Playbook — in-app walkthrough of the Create Coin wizard.
 */
import { useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  FileText,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const STEPS = [
  { id: "path", n: "01", label: "Path" },
  { id: "identity", n: "02", label: "Identity" },
  { id: "story", n: "03", label: "Story" },
  { id: "bond", n: "04", label: "Bond" },
  { id: "launch", n: "05", label: "Launch" },
] as const;

function Section({
  id,
  step,
  title,
  subtitle,
  children,
}: {
  id: string;
  step?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-6 overflow-hidden rounded-2xl border border-border bg-card/30 backdrop-blur-md">
      <div className="p-5 md:p-6">
        <div className="flex items-start gap-3">
          {step ? (
            <div className="shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-2.5 py-1.5 font-retro text-xs text-accent">
              {step}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="font-retro text-lg text-foreground md:text-xl">{title}</h2>
            {subtitle ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{subtitle}</p> : null}
            <div className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
          </div>
        </div>
      </div>
    </Card>
  );
}

const Playbook = () => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToSection = useCallback((id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = id;
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20"
    >
      <div className="mx-auto w-full max-w-[1480px] px-1 pb-12 md:px-2">
        <div className="pb-6 pt-4 md:pb-8 md:pt-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl border border-border/60 bg-background/40 p-3">
                  <BookOpen className="h-6 w-6 text-accent" />
                </div>
                <div>
                  <h1 className="font-retro text-2xl leading-tight text-foreground md:text-4xl">Playbook</h1>
                  <p className="mt-1 text-muted-foreground">
                    Every step on Create Coin — Draft first, or Direct deploy.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {STEPS.map((item) => (
                  <Button key={item.id} type="button" variant="secondary" size="sm" onClick={() => scrollToSection(item.id)}>
                    {item.n} {item.label}
                  </Button>
                ))}
                <Button type="button" variant="secondary" size="sm" onClick={() => scrollToSection("after")}>
                  After launch
                </Button>
              </div>
            </div>
            <Button asChild className="w-full font-retro sm:w-auto">
              <Link to="/create">
                Open Create Coin <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="space-y-4 md:space-y-5">
          <Section
            id="path"
            step="01"
            title="Path — Draft or Direct deploy"
            subtitle="Create will not let you continue until you pick one."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-orange-400/40 bg-orange-500/5 p-4">
                <div className="flex items-center gap-2 font-retro text-foreground">
                  <FileText className="h-4 w-4 text-orange-300" />
                  Draft mode
                </div>
                <p className="mt-2">
                  One wallet signature, no gas. Saves a Prepare Mode campaign. You get a promotion page, can grow
                  heat, then Push Live when you are ready.
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/30 p-4">
                <div className="flex items-center gap-2 font-retro text-foreground">
                  <Rocket className="h-4 w-4 text-orange-300" />
                  Direct deploy
                </div>
                <p className="mt-2">
                  Uploads the creative, asks the wallet to sign the launch transaction, pays gas, and opens Token
                  Details when the contract is live. No promotion page in between.
                </p>
              </div>
            </div>
            <p>
              For BNB launches, connect a supported BNB wallet on the correct network. For Solana launches, connect
              a supported Solana wallet. If Direct deploy is unavailable, you can still save a Draft.
            </p>
          </Section>

          <Section
            id="identity"
            step="02"
            title="Identity — image, name, ticker"
            subtitle="The live card preview on the left updates as you type."
          >
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="font-medium text-foreground">Token image</span> — PNG, JPG or WebP, max 5 MB.
                Required before Next.
              </li>
              <li>
                <span className="font-medium text-foreground">Name</span> — the public coin name. Mixed case is fine.
              </li>
              <li>
                <span className="font-medium text-foreground">Ticker</span> — letters and numbers only. Create checks
                availability while you type. You cannot continue until it is available.
              </li>
            </ul>
            <p>
              A taken or reserved ticker blocks the wizard. Wait for the green “Ticker is available” line.
            </p>
          </Section>

          <Section
            id="story"
            step="03"
            title="Story — description and socials"
            subtitle="Tell visitors what this coin is. Socials are optional."
          >
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="font-medium text-foreground">Short description</span> is required. This is the mission
                line on the draft card and Token Details.
              </li>
              <li>
                Website, X, Telegram, Discord and one other link are optional. Use a handle, a full URL, or a bare
                domain — for example <span className="text-foreground">@memewarzone</span>.
              </li>
            </ul>
            <p>The preview on the left updates live. Double-check links. Lookalike domains get people hurt.</p>
          </Section>

          <Section
            id="bond"
            step="04"
            title="Bond — graduation threshold"
            subtitle="How much bonding volume is needed before the token moves to DEX liquidity."
          >
            <p>Pick one graduation target. This is committed with the launch and cannot be casually changed later.</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-border/60 bg-background/30 p-3">
                <div className="font-retro text-foreground">$15K · Fast grad</div>
                <p className="mt-1 text-xs">Shorter bonding. Faster route into DEX liquidity.</p>
              </div>
              <div className="rounded-xl border border-accent/40 bg-accent/5 p-3">
                <div className="font-retro text-foreground">$30K · Normal</div>
                <p className="mt-1 text-xs">Default. Room for discovery and community growth.</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/30 p-3">
                <div className="font-retro text-foreground">$50K · Deep</div>
                <p className="mt-1 text-xs">Longer bond. Seeds stronger DEX liquidity.</p>
              </div>
            </div>
            <p>Available graduation targets are $15K, $30K and $50K.</p>
            <p>
              <span className="font-medium text-foreground">Launch Safety</span> is a collapsible status of the
              launchpad on the connected chain. If it is not ready, Direct deploy will refuse.
            </p>
          </Section>

          <Section
            id="launch"
            step="05"
            title="Launch — review and fire"
            subtitle="Last check. Then either save a draft or pay gas."
          >
            <p>The right rail repeats mode, name, ticker and graduation. Fix anything by going Back.</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-background/30 p-4">
                <div className="flex items-center gap-2 font-retro text-foreground">
                  <FileText className="h-4 w-4 text-orange-300" />
                  Save Draft
                </div>
                <p className="mt-2">
                  One signature. No gas. Next stop is promotion setup so you can edit the Prepare page, share, and
                  Push Live later from Command Center → My Coins.
                </p>
              </div>
              <div className="rounded-xl border border-orange-400/40 bg-orange-500/5 p-4">
                <div className="flex items-center gap-2 font-retro text-foreground">
                  <Rocket className="h-4 w-4 text-orange-300" />
                  Deploy now
                </div>
                <p className="mt-2">
                  Wallet signs + gas. Stay on Create until the transaction confirms. Then you land on Token Details.
                  Creator buy locks and cooldowns still apply.
                </p>
              </div>
            </div>
            <p>Connect the wallet for the chain you picked. A cooldown or live-token limit will show here, not after you pay.</p>
          </Section>

          <Section
            id="after"
            title="After you leave Create"
            subtitle="The two paths stay different on purpose."
          >
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <span className="font-medium text-foreground">Draft</span> → Prepare Mode page. Followers, transmissions,
                share card, Arm Notification, then Push Live when you are ready.
              </li>
              <li>
                <span className="font-medium text-foreground">Direct deploy</span> → Token Details. Bonding trades start
                immediately. Graduation later moves liquidity to Topaz (BNB) or Meteora (Solana) without leaving
                MemeWarzone.
              </li>
              <li>
                Find drafts and live coins in <span className="text-foreground">Command Center → My Coins</span>.
              </li>
              <li>
                Product questions: Command Center → Support & Safety, or Discord. Impersonation and stolen identity:
                Report Abuse.
              </li>
            </ul>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild>
                <Link to="/create">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Start Create
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/command/support">
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Support & Safety
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/war-room">
                  <Target className="mr-2 h-4 w-4" />
                  War Trade Room
                </Link>
              </Button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};

export default Playbook;
