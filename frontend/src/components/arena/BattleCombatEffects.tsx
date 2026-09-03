import { useEffect, useRef, useState } from "react";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import {
  HOLE_TTL_MS,
  MAX_TRACERS,
  TRACER_TTL_MS,
  burstCount,
  capHoles,
  planCombatAttacks,
  severityFor,
  shouldClearCombatBaseline,
  snapshotCombatScore,
  targetFor,
} from "@/lib/arena/battleCombatEffects.mjs";

type CombatSide = "left" | "right";
type Severity = 1 | 2 | 3;

type BulletHole = {
  id: string;
  side: CombatSide;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  severity: Severity;
  createdAt: number;
};

type Tracer = {
  id: string;
  from: CombatSide;
  y: number;
  offset: number;
  severity: Severity;
  createdAt: number;
};

function effectsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_ARENA_COMBAT_EFFECTS || "").trim());
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function recoilTarget(side: CombatSide, severity: Severity, reducedMotion: boolean) {
  if (reducedMotion || typeof document === "undefined") return;
  const element = document.querySelector<HTMLElement>(`[data-battle-combat-side="${side}"]`);
  if (!element?.animate) return;
  const distance = severity === 3 ? 7 : severity === 2 ? 4 : 2;
  const duration = severity === 3 ? 360 : severity === 2 ? 260 : 180;
  element.animate(
    [
      { transform: "translate3d(0,0,0)" },
      { transform: `translate3d(${side === "left" ? -distance : distance}px,${Math.max(1, distance / 3)}px,0)` },
      { transform: `translate3d(${side === "left" ? distance / 2 : -distance / 2}px,0,0)` },
      { transform: "translate3d(0,0,0)" },
    ],
    { duration, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}

function useMediaFlag(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

export function BattleCombatEffects({ metrics }: { metrics?: BattleRealtimeMetrics | null }) {
  const enabled = effectsEnabled();
  const reducedMotion = useMediaFlag("(prefers-reduced-motion: reduce)");
  const compact = useMediaFlag("(max-width: 1279px)");
  const previous = useRef<ReturnType<typeof snapshotCombatScore>>(null);
  const sequence = useRef(0);
  const [holes, setHoles] = useState<BulletHole[]>([]);
  const [tracers, setTracers] = useState<Tracer[]>([]);

  useEffect(() => {
    if (shouldClearCombatBaseline(enabled, metrics)) {
      previous.current = null;
      return;
    }
    const next = snapshotCombatScore(metrics);
    if (!next) {
      previous.current = null;
      return;
    }
    const prior = previous.current;
    previous.current = next;
    const attacks = planCombatAttacks(prior, next);
    if (!attacks.length) return;

    const now = Date.now();
    const newHoles: BulletHole[] = [];
    const newTracers: Tracer[] = [];
    for (const attack of attacks) {
      const target = targetFor(attack.attacker) as CombatSide;
      const severity = severityFor(attack.delta, attack.leadChange) as Severity;
      const count = burstCount(attack.delta, attack.leadChange, { reducedMotion, compact });
      if (!count) continue;
      recoilTarget(target, severity, reducedMotion);
      for (let index = 0; index < count; index += 1) {
        sequence.current += 1;
        const id = `${now}-${sequence.current}`;
        const x = compact
          ? (target === "left" ? randomBetween(12, 44) : randomBetween(56, 88))
          : (target === "left" ? randomBetween(8, 31) : randomBetween(69, 92));
        const y = compact ? randomBetween(18, 88) : randomBetween(30, 82);
        newHoles.push({
          id: `hole-${id}`,
          side: target,
          x,
          y,
          rotation: randomBetween(-35, 35),
          scale: randomBetween(0.8, severity === 3 ? 1.7 : 1.25),
          severity,
          createdAt: now + index,
        });
        if (!reducedMotion && !compact) {
          newTracers.push({
            id: `tracer-${id}`,
            from: attack.attacker as CombatSide,
            y: Math.max(18, Math.min(86, y + randomBetween(-8, 8))),
            offset: randomBetween(-4, 4),
            severity,
            createdAt: now + index,
          });
        }
      }
    }
    if (newHoles.length) setHoles((current) => capHoles([...current, ...newHoles]) as BulletHole[]);
    if (newTracers.length) setTracers((current) => [...current, ...newTracers].slice(-MAX_TRACERS));
  }, [enabled, metrics, reducedMotion, compact]);

  useEffect(() => {
    if (!enabled || (!holes.length && !tracers.length)) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setHoles((current) => current.filter((row) => now - row.createdAt < HOLE_TTL_MS));
      setTracers((current) => current.filter((row) => now - row.createdAt < TRACER_TTL_MS));
    }, 900);
    return () => window.clearInterval(timer);
  }, [enabled, holes.length, tracers.length]);

  if (!enabled || (!holes.length && !tracers.length)) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden="true" data-battle-combat-effects="on">
      <style>{`
        @keyframes mwz-battle-tracer-ltr {
          0% { opacity: 0; transform: scaleX(0.02) translateX(-12%); }
          12% { opacity: 1; }
          72% { opacity: .95; transform: scaleX(1) translateX(0); }
          100% { opacity: 0; transform: scaleX(1) translateX(8%); }
        }
        @keyframes mwz-battle-tracer-rtl {
          0% { opacity: 0; transform: scaleX(0.02) translateX(12%); }
          12% { opacity: 1; }
          72% { opacity: .95; transform: scaleX(1) translateX(0); }
          100% { opacity: 0; transform: scaleX(1) translateX(-8%); }
        }
        @keyframes mwz-battle-hole-in {
          0% { opacity: 0; transform: scale(2.1); filter: brightness(2.2); }
          35% { opacity: 1; }
          100% { opacity: .78; transform: scale(1); filter: brightness(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mwz-battle-tracer { display: none !important; }
          .mwz-battle-hole { animation: none !important; opacity: .58; }
        }
      `}</style>
      {tracers.map((tracer) => {
        const leftToRight = tracer.from === "left";
        return (
          <div
            key={tracer.id}
            className="mwz-battle-tracer absolute h-px"
            style={{
              left: "24%",
              right: "24%",
              top: `${tracer.y}%`,
              transformOrigin: leftToRight ? "left center" : "right center",
              background: leftToRight
                ? "linear-gradient(90deg, rgba(251,146,60,0), rgba(251,146,60,.95), rgba(255,255,255,.92))"
                : "linear-gradient(90deg, rgba(255,255,255,.92), rgba(34,211,238,.95), rgba(34,211,238,0))",
              boxShadow: tracer.severity === 3 ? "0 0 11px rgba(255,255,255,.72)" : "0 0 6px rgba(255,255,255,.45)",
              animation: `${leftToRight ? "mwz-battle-tracer-ltr" : "mwz-battle-tracer-rtl"} ${tracer.severity === 3 ? 360 : 520}ms ease-out forwards`,
              marginTop: `${tracer.offset}px`,
            }}
          />
        );
      })}
      {holes.map((hole) => (
        <div
          key={hole.id}
          className="mwz-battle-hole absolute rounded-full"
          style={{
            left: `${hole.x}%`,
            top: `${hole.y}%`,
            width: `${5 + hole.severity * 2}px`,
            height: `${5 + hole.severity * 2}px`,
            marginLeft: "-4px",
            marginTop: "-4px",
            transform: `rotate(${hole.rotation}deg) scale(${hole.scale})`,
            background: "radial-gradient(circle, rgba(0,0,0,.96) 0 22%, rgba(80,42,24,.9) 24% 48%, rgba(255,180,90,.35) 52%, rgba(0,0,0,0) 72%)",
            boxShadow: hole.severity === 3 ? "0 0 12px rgba(249,115,22,.35)" : "0 0 5px rgba(255,255,255,.12)",
            animation: "mwz-battle-hole-in 300ms ease-out both",
          }}
        />
      ))}
    </div>
  );
}
