import { useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Radio } from "lucide-react";

import { cn } from "@/lib/utils";
import { timestampSeconds } from "@/lib/scheduledLaunchApi";

export type ScheduledLaunchCountdownProps = {
  launchAt?: string | number | null;
  chainId?: number | null;
  campaignAddress?: string | null;
  contractDeployed?: boolean;
  waitingForCreatorDeploy?: boolean;
  variant?: "hero" | "compact" | "pill";
  className?: string;
};

function pad(value: number) {
  return String(Math.max(0, value)).padStart(2, "0");
}

function remainingParts(launchSeconds: number, nowMs: number) {
  const total = Math.max(0, launchSeconds - Math.floor(nowMs / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

export function formatLaunchLocal(launchAt?: string | number | null) {
  const seconds = timestampSeconds(launchAt);
  if (!seconds) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date(seconds * 1000));
}

export function formatLaunchUtc(launchAt?: string | number | null) {
  const seconds = timestampSeconds(launchAt);
  if (!seconds) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000))} UTC`;
}

export function ScheduledLaunchCountdown({
  launchAt,
  chainId,
  campaignAddress,
  contractDeployed = true,
  waitingForCreatorDeploy = false,
  variant = "hero",
  className,
}: ScheduledLaunchCountdownProps) {
  const launchSeconds = useMemo(() => timestampSeconds(launchAt), [launchAt]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const announced = useRef(false);

  useEffect(() => {
    announced.current = false;
    setNowMs(Date.now());
    if (!launchSeconds) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [launchSeconds]);

  const reached = Boolean(launchSeconds && Math.floor(nowMs / 1000) >= launchSeconds);
  const launched = Boolean(reached && contractDeployed);

  useEffect(() => {
    if (!launched || announced.current) return;
    announced.current = true;
    window.dispatchEvent(
      new CustomEvent("memewarzone:scheduledLaunchReached", {
        detail: { chainId, campaignAddress, launchAt: launchSeconds },
      }),
    );
  }, [campaignAddress, chainId, launchSeconds, launched]);

  if (!launchSeconds) return null;

  const remaining = remainingParts(launchSeconds, nowMs);
  const local = formatLaunchLocal(launchSeconds);
  const utc = formatLaunchUtc(launchSeconds);

  if (variant === "pill") {
    const countdown = `${remaining.days}D ${pad(remaining.hours)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`;
    return (
      <div
        className={cn(
          "mwz-chip mwz-chip-active inline-flex items-center gap-2 px-4 py-2 text-xs",
          className,
        )}
        title={`${local} · ${utc}`}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", launched ? "bg-green-300" : "animate-pulse bg-orange-300")} />
        <Clock3 className="h-3.5 w-3.5" />
        <span>{launched ? "Trading is live" : reached && waitingForCreatorDeploy ? "Launching soon" : reached ? "Confirming launch" : `Launch in ${countdown}`}</span>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className={cn("border border-orange-400/40 bg-orange-500/5 p-2.5", className)}>
        <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-orange-300">
          <span className="inline-flex items-center gap-1.5">
            <Clock3 className="h-3 w-3" />
            {contractDeployed ? "On-chain countdown" : "Scheduled"}
          </span>
          <span>{launched ? "Launched" : reached ? "Awaiting chain" : "Trading locked"}</span>
        </div>
        <div className="mt-2 font-retro text-xl leading-none text-foreground">
          {launched
            ? "LAUNCHED"
            : reached
              ? "AWAITING ON-CHAIN CONFIRMATION"
              : `${remaining.days}D ${pad(remaining.hours)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`}
        </div>
        <div className="mt-2 text-[10px] leading-4 text-muted-foreground">
          <div>{local}</div>
          <div>{utc}</div>
        </div>
        <div className="mt-2 text-[10px] leading-4 text-orange-100/75">
          {launched
            ? "Trading-open time reached."
            : contractDeployed
              ? "Contract deployed. Trading has not opened yet."
              : "Creator confirmation is still required."}
        </div>
      </div>
    );
  }

  return (
    <section className={cn("mwz-card relative overflow-hidden border-orange-400/55 bg-black/75 p-5 md:p-7", className)}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,153,0,0.18),transparent_62%)]" />
      <div className="relative">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="text-left">
            <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-orange-300">
              <Radio className="h-4 w-4" />
              {contractDeployed ? "Scheduled campaign deployed on-chain" : "Scheduled launch"}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {launched
                ? "The trading-open timestamp has been reached. The promotion page remains available for the creator and community."
                : reached
                  ? "The selected timestamp has passed, but the campaign deployment is not yet confirmed."
                  : contractDeployed
                    ? "The token and campaign contract already exist. Trading remains locked by the contract until this countdown reaches zero."
                    : "This time is provisional until the creator confirms the on-chain deployment."}
            </p>
          </div>
          <div className="shrink-0 border border-orange-400/30 bg-black/60 px-4 py-3 text-left md:text-right">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Exact launch</div>
            <div className="mt-1 text-sm text-foreground">{local}</div>
            <div className="mt-1 text-[11px] text-orange-200/80">{utc}</div>
          </div>
        </div>

        {launched ? (
          <div className="mt-6 border-y border-green-400/35 py-6 text-center">
            <div className="font-retro text-5xl uppercase tracking-[0.1em] text-green-300 md:text-7xl">Launched</div>
          </div>
        ) : reached ? (
          <div className="mt-6 border-y border-orange-400/35 py-6 text-center">
            <div className="font-retro text-3xl uppercase tracking-[0.08em] text-orange-200 md:text-5xl">Awaiting on-chain confirmation</div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-4 gap-2 md:gap-4">
            {[
              [remaining.days, "Days"],
              [remaining.hours, "Hours"],
              [remaining.minutes, "Minutes"],
              [remaining.seconds, "Seconds"],
            ].map(([value, label]) => (
              <div key={String(label)} className="border border-orange-400/30 bg-black/55 px-2 py-4 text-center md:px-4 md:py-5">
                <div className="font-retro text-3xl leading-none text-foreground md:text-5xl">{pad(Number(value))}</div>
                <div className="mt-2 text-[9px] uppercase tracking-[0.14em] text-orange-300 md:text-[10px]">{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
