import { useEffect, useMemo, useState } from "react";
import { Trophy } from "lucide-react";

import {
  REWARD_UNLOCKING_EVENT,
  type RewardUnlockDetail,
} from "@/lib/rewardUnlockEvents";
import { formatWeiToBnb } from "@/lib/rewardsApi";
import { getLeagueImage, getLeagueTitle } from "@/lib/leagueCabinet";
import { getNativeSymbol } from "@/lib/chainConfig";

type FlightPhase = "ready" | "flying" | "impact";

type FlightState = {
  detail: RewardUnlockDetail;
  start: DOMRect;
  phase: FlightPhase;
};

type TrailParticle = {
  left: number;
  top: number;
  size: number;
  delay: number;
};

function findClaimCardRect() {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const claimingButton = buttons.find((button) =>
    button.textContent?.trim().toLowerCase().includes("claiming")
  );

  const card = claimingButton?.closest("div.rounded-xl") as HTMLElement | null;
  return (card ?? claimingButton)?.getBoundingClientRect() ?? null;
}

function quadraticPoint(start: number, control: number, end: number, progress: number) {
  const inverse = 1 - progress;
  return inverse * inverse * start + 2 * inverse * progress * control + progress * progress * end;
}

export function RewardUnlockFlight() {
  const [flight, setFlight] = useState<FlightState | null>(null);

  useEffect(() => {
    const onUnlocking = (event: Event) => {
      const detail = (event as CustomEvent<RewardUnlockDetail>).detail;
      if (!detail?.reward) return;

      const fallback = new DOMRect(
        window.innerWidth / 2 - 150,
        window.innerHeight * 0.68,
        300,
        150
      );
      const start = findClaimCardRect() ?? fallback;

      setFlight({ detail, start, phase: "ready" });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setFlight((current) => (current ? { ...current, phase: "flying" } : current));
        });
      });
    };

    window.addEventListener(REWARD_UNLOCKING_EVENT, onUnlocking);
    return () => window.removeEventListener(REWARD_UNLOCKING_EVENT, onUnlocking);
  }, []);

  useEffect(() => {
    if (flight?.phase !== "flying") return;

    const impactTimer = window.setTimeout(() => {
      setFlight((current) => (current ? { ...current, phase: "impact" } : current));
    }, 610);
    const cleanupTimer = window.setTimeout(() => setFlight(null), 980);

    return () => {
      window.clearTimeout(impactTimer);
      window.clearTimeout(cleanupTimer);
    };
  }, [flight?.phase]);

  const geometry = useMemo(() => {
    if (!flight) return null;

    const targetWidth = Math.min(230, window.innerWidth - 32);
    const startWidth = Math.min(Math.max(flight.start.width, 220), 420);
    const startHeight = Math.min(Math.max(flight.start.height, 120), 220);
    const startLeft = Math.min(
      Math.max(16, flight.start.left),
      Math.max(16, window.innerWidth - startWidth - 16)
    );
    const startTop = Math.min(
      Math.max(16, flight.start.top),
      Math.max(16, window.innerHeight - startHeight - 16)
    );
    const targetLeft = window.innerWidth / 2 - targetWidth / 2;
    const targetTop = Math.max(54, window.innerHeight / 2 - 190);
    const startCenterX = startLeft + startWidth / 2;
    const startCenterY = startTop + startHeight / 2;
    const targetCenterX = targetLeft + targetWidth / 2;
    const targetCenterY = targetTop + targetWidth / 2;
    const controlX = (startCenterX + targetCenterX) / 2;
    const controlY = Math.max(36, Math.min(startCenterY, targetCenterY) - 180);

    const particles: TrailParticle[] = Array.from({ length: 11 }, (_, index) => {
      const progress = (index + 1) / 13;
      return {
        left: quadraticPoint(startCenterX, controlX, targetCenterX, progress),
        top: quadraticPoint(startCenterY, controlY, targetCenterY, progress),
        size: 4 + (index % 3) * 2,
        delay: index * 28,
      };
    });

    return {
      targetWidth,
      startWidth,
      startHeight,
      startLeft,
      startTop,
      targetLeft,
      targetTop,
      particles,
    };
  }, [flight]);

  if (!flight || !geometry) return null;

  const reward = flight.detail.reward;
  const isLeague = (flight.detail.source ?? "league") === "league";
  const title =
    flight.detail.presentation?.title ??
    (isLeague
      ? getLeagueTitle(reward.category as Parameters<typeof getLeagueTitle>[0])
      : reward.category);
  const eyebrow = flight.detail.presentation?.eyebrow ?? "Reward secured";
  const currency = flight.detail.presentation?.currency ?? getNativeSymbol(flight.detail.chainId);
  const imageUrl =
    flight.detail.presentation?.imageUrl ??
    (isLeague
      ? getLeagueImage(reward.category as Parameters<typeof getLeagueImage>[0])
      : "");
  const amount = Number(formatWeiToBnb(reward.amountRaw)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
  const moving = flight.phase !== "ready";
  const impacting = flight.phase === "impact";

  return (
    <div className="pointer-events-none fixed inset-0 z-[120] overflow-hidden" aria-hidden="true">
      <div
        className={`absolute transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          impacting ? "opacity-0" : "opacity-100"
        }`}
        style={{
          left: geometry.startLeft,
          top: geometry.startTop,
          transform: moving
            ? `translate3d(${geometry.targetLeft - geometry.startLeft}px, 0, 0)`
            : "translate3d(0, 0, 0)",
        }}
      >
        <div
          className="transition-transform duration-700 ease-[cubic-bezier(0.16,0.72,0.24,1)]"
          style={{
            transform: moving
              ? `translate3d(0, ${geometry.targetTop - geometry.startTop}px, 0)`
              : "translate3d(0, 0, 0)",
          }}
        >
          <div
            className={`relative overflow-hidden rounded-2xl border bg-card/95 shadow-2xl transition-[width,height,transform,opacity,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              moving
                ? "rotate-[7deg] scale-90 border-accent blur-[0.4px] shadow-[0_0_76px_rgba(249,115,22,0.78)]"
                : "rotate-0 scale-100 border-accent/70 shadow-[0_0_36px_rgba(249,115,22,0.45)]"
            }`}
            style={{
              width: moving ? geometry.targetWidth : geometry.startWidth,
              height: moving ? geometry.targetWidth : geometry.startHeight,
            }}
          >
            {imageUrl ? (
              <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" />
            ) : null}
            <div className="absolute inset-0 bg-gradient-to-br from-background/20 via-background/65 to-background" />
            <div
              className={`absolute inset-y-0 -left-1/2 w-1/3 rotate-12 bg-gradient-to-r from-transparent via-white/70 to-transparent transition-transform duration-700 ${
                moving ? "translate-x-[650%]" : "translate-x-0"
              }`}
            />

            <div className="relative flex h-full items-center gap-4 p-4">
              <div
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent/60 bg-accent/20 transition-transform duration-700 ${
                  moving ? "rotate-[24deg] scale-125" : "rotate-0 scale-100"
                }`}
              >
                <Trophy className="h-7 w-7 text-accent" />
              </div>
              <div className="min-w-0">
                <div className="font-retro text-[10px] uppercase tracking-[0.2em] text-accent">
                  {eyebrow}
                </div>
                <div className="mt-1 truncate font-retro text-base text-foreground">{title}</div>
                <div className="mt-1 font-retro text-xs text-muted-foreground">
                  #{reward.rank} · {amount} {currency}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {geometry.particles.map((particle, index) => (
        <span
          key={index}
          className={`absolute rounded-full bg-accent shadow-[0_0_16px_rgba(249,115,22,0.95)] transition-all duration-500 ${
            flight.phase === "flying" ? "scale-100 opacity-80" : "scale-0 opacity-0"
          }`}
          style={{
            left: particle.left - particle.size / 2,
            top: particle.top - particle.size / 2,
            width: particle.size,
            height: particle.size,
            transitionDelay: `${particle.delay}ms`,
          }}
        />
      ))}

      <div
        className={`absolute left-1/2 top-[calc(50%-74px)] h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent/70 shadow-[0_0_52px_rgba(249,115,22,0.72)] transition-all duration-500 ${
          impacting ? "scale-[3.8] opacity-0" : "scale-0 opacity-0"
        }`}
      />
      <div
        className={`absolute left-1/2 top-[calc(50%-74px)] h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/70 blur-md transition-all duration-300 ${
          impacting ? "scale-[2.4] opacity-0" : "scale-0 opacity-0"
        }`}
      />
      {Array.from({ length: 12 }).map((_, index) => {
        const angle = (index / 12) * Math.PI * 2;
        const distance = impacting ? 105 : 0;
        return (
          <span
            key={`burst-${index}`}
            className="absolute left-1/2 top-[calc(50%-74px)] h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_12px_rgba(249,115,22,0.9)] transition-all duration-500"
            style={{
              transform: `translate(-50%, -50%) translate(${Math.cos(angle) * distance}px, ${
                Math.sin(angle) * distance
              }px)`,
              opacity: impacting ? 0.85 : 0,
            }}
          />
        );
      })}
    </div>
  );
}
