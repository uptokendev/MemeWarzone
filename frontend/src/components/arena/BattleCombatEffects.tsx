import { useEffect, useRef, useState } from "react";
import type { BattleRealtimeLeader, BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";

const MAX_HOLES_PER_SIDE = 40;
const MAX_TRACERS = 18;
const HOLE_TTL_MS = 60_000;
const TRACER_TTL_MS = 950;

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

type PreviousScore = {
  left: number;
  right: number;
  leader: BattleRealtimeLeader;
  updatedAt: string | null;
};

function effectsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_ARENA_COMBAT_EFFECTS || "").trim());
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function severityFor(delta: number, leadChange: boolean): Severity {
  if (leadChange || delta >= 1.5) return 3;
  if (delta >= 0.5) return 2;
  return 1;
}

function burstCount(delta: number, leadChange: boolean, reducedMotion: boolean) {
  if (reducedMotion) return 1;
  if (leadChange) return 8;
  if (delta >= 1.5) return 6;
  if (delta >= 0.5) return 3;
  if (delta >= 0.1) return 1;
  return 0;
}

function targetFor(attacker: CombatSide): CombatSide {
  return attacker === "left" ? "right" : "left";
}

function capHoles(rows: BulletHole[]) {
  const left = rows.filter((row) => row.side === "left").slice(-MAX_HOLES_PER_SIDE);
  const right = rows.filter((row) => row.side === "right").slice(-MAX_HOLES_PER_SIDE);
  return [...left, ...right].sort((a, b) => a.createdAt - b.createdAt);
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

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function BattleCombatEffects({ metrics }: { metrics?: BattleRealtimeMetrics | null }) {
  const enabled = effectsEnabled();
  const reducedMotion = useReducedMotion();
  const previous = useRef<PreviousScore | null>(null);
  const sequence = useRef(0);
  const [holes, setHoles] = useState<BulletHole[]>([]);
  const [tracers, setTracers] = useState<Tracer[]>([]);

  useEffect(() => {
    if (!enabled || !metrics?.dataHealth.healthy) {
      if (metrics?.metricsUpdatedAt) {
        previous.current = null;
      }
      return;
    }
    const left = metrics.sides.left;
    const right = metrics.sides.right;
    if (!left?.pointsReady || !right?.pointsReady) return;
    const next: PreviousScore = {
      left: left.points.total,
      right: right.points.total,
      leader: metrics.leaderSide,
      updatedAt: metrics.metricsUpdatedAt,
    };
    const prior = previous.current;
    previous.current = next;
    if (!prior || prior.updatedAt === next.updatedAt) return;

    const attacks: Array<{ attacker: CombatSide; delta: number; leadChange: boolean }> = [];
    const leftDelta = Math.max(0, next.left - prior.left);
    const rightDelta = Math.max(0, next.right - prior.right);
    if (leftDelta >= 0.1) attacks.push({ attacker: "left", delta: leftDelta, leadChange: false });
    if (rightDelta >= 0.1) attacks.push({ attacker: "right", delta: rightDelta, leadChange: false });
    const directLeadChange = (prior.leader === "left" || prior.leader === "right")
      && (next.leader === "left" || next.leader === "right")
      && prior.leader !== next.leader;
    if (directLeadChange) {
      const winner = next.leader as CombatSide;
      const existing = attacks.find((attack) => attack.attacker === winner);
      if (existing) existing.leadChange = true;
      else attacks.push({ attacker: winner, delta: 0, leadChange: true });
    }
    if (!attacks.length) return;

    const now = Date.now();
    const newHoles: BulletHole[] = [];
    const newTracers: Tracer[] = [];
    for (const attack of attacks) {
      const target = targetFor(attack.attacker);
      const severity = severityFor(attack.delta, attack.leadChange);
      const count = burstCount(attack.delta, attack.leadChange, reducedMotion);
      if (!count) continue;
      recoilTarget(target, severity, reducedMotion);
      for (let index = 0; index < count; index += 1) {
        sequence.current += 1;
        const id = `${now}-${sequence.current}`;
        const x = target === "left" ? randomBetween(8, 31) : randomBetween(69, 92);
        const y = randomBetween(30, 82);
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
        if (!reducedMotion) {
          newTracers.push({
            id: `tracer-${id}`,
            from: attack.attacker,
            y: Math.max(18, Math.min(86, y + randomBetween(-8, 8))),
            offset: randomBetween(-4, 4),
            severity,
            createdAt: now + index,
          });
        }
      }
    }
    if (newHoles.length) setHoles((current) => capHoles([...current, ...newHoles]));
    if (newTracers.length) setTracers((current) => [...current, ...newTracers].slice(-MAX_TRACERS));
  }, [enabled, metrics, reducedMotion]);

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
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden="true">
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
