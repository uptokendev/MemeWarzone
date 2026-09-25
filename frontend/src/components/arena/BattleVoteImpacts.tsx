import { useEffect, useRef, useState } from "react";

import { recoilTarget, useMediaFlag } from "@/components/arena/BattleCombatEffects";
import {
  VOTE_IMPACT_FADE_START_MS,
  VOTE_IMPACT_TTL_MS,
  capVoteImpactHoles,
  planVoteImpacts,
} from "@/lib/arena/battleVoteImpacts.mjs";

type Side = "left" | "right";

type Hole = {
  id: string;
  side: Side;
  x: number;
  y: number;
  size: number;
  rotation: number;
  cracks: number[];
  delayMs: number;
  createdAt: number;
};

function between(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/** Crack lengths per direction, so every hole shatters differently. */
function crackPattern() {
  const count = 5 + Math.floor(Math.random() * 4);
  return Array.from({ length: count }, (_, index) => {
    const angle = (360 / count) * index + between(-14, 14);
    return Math.round(angle * 10) / 10;
  });
}

/**
 * Vote Battle impacts: each new vote on one side puts bullet holes in the opponent's card, which
 * recoils; the holes fade after a few seconds (founder, 2026-09-25). Driven by the card's live vote
 * tally, so other people's votes land too when the tally refreshes. Independent of the metrics
 * effect (BattleCombatEffects), which Vote Battles never trigger.
 */
export function BattleVoteImpacts({
  leftPoints,
  rightPoints,
  active,
  rootRef,
}: {
  leftPoints: number | null;
  rightPoints: number | null;
  active: boolean;
  rootRef?: { current: ParentNode | null };
}) {
  const reducedMotion = useMediaFlag("(prefers-reduced-motion: reduce)");
  const stacked = useMediaFlag("(max-width: 767px)");
  const previous = useRef<{ left: number; right: number } | null>(null);
  const sequence = useRef(0);
  const [holes, setHoles] = useState<Hole[]>([]);

  useEffect(() => {
    if (!active || leftPoints === null || rightPoints === null) {
      previous.current = null;
      return;
    }
    const next = { left: leftPoints, right: rightPoints };
    const impacts = planVoteImpacts(previous.current, next);
    previous.current = next;
    if (!impacts.length) return;

    const now = Date.now();
    const added: Hole[] = [];
    for (const impact of impacts) {
      const target = impact.target as Side;
      recoilTarget(target, impact.holes >= 4 ? 3 : 2, reducedMotion, rootRef?.current);
      for (let index = 0; index < impact.holes; index += 1) {
        sequence.current += 1;
        // Like the founder's reference: holes cluster on the card's edges and corners, where they
        // frame the art instead of covering the stats. Desktop: cards sit left and right of VS
        // (card spans ~0-45% / 55-100%). Phone: they stack, left on top.
        const box = stacked
          ? { x0: 3, x1: 97, y0: target === "left" ? 3 : 53, y1: target === "left" ? 47 : 97 }
          : target === "left" ? { x0: 1, x1: 45, y0: 4, y1: 94 } : { x0: 55, x1: 99, y0: 4, y1: 94 };
        const edge = Math.floor(Math.random() * 4);
        const band = 0.16;
        const w = box.x1 - box.x0;
        const h = box.y1 - box.y0;
        const x = edge === 0 ? box.x0 + between(0, w * band) : edge === 1 ? box.x1 - between(0, w * band) : between(box.x0, box.x1);
        const y = edge === 2 ? box.y0 + between(0, h * band) : edge === 3 ? box.y1 - between(0, h * band) : between(box.y0, box.y1);
        added.push({
          id: `vote-hole-${now}-${sequence.current}`,
          side: target,
          x,
          y,
          size: between(stacked ? 54 : 64, impact.holes >= 4 ? 104 : 88),
          rotation: between(0, 360),
          cracks: crackPattern(),
          delayMs: reducedMotion ? 0 : index * 90,
          createdAt: now,
        });
      }
    }
    setHoles((current) => capVoteImpactHoles([...current, ...added]) as Hole[]);
  }, [active, leftPoints, rightPoints, reducedMotion, stacked, rootRef]);

  useEffect(() => {
    if (!holes.length) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setHoles((current) => current.filter((hole) => now - hole.createdAt < VOTE_IMPACT_TTL_MS + hole.delayMs));
    }, 500);
    return () => window.clearInterval(timer);
  }, [holes.length]);

  if (!holes.length) return null;

  const fadeSeconds = (VOTE_IMPACT_TTL_MS - VOTE_IMPACT_FADE_START_MS) / 1000;
  return (
    <div className="pointer-events-none absolute inset-0 z-[14] overflow-hidden" aria-hidden="true" data-battle-vote-impacts="on">
      <style>{`
        @keyframes mwz-vote-hole-hit {
          0% { opacity: 0; transform: scale(2.4); filter: brightness(3); }
          18% { opacity: 1; }
          100% { opacity: 1; transform: scale(1); filter: brightness(1); }
        }
        @keyframes mwz-vote-hole-fade { to { opacity: 0; } }
        @keyframes mwz-vote-hole-flash {
          0% { opacity: .95; transform: scale(.4); }
          100% { opacity: 0; transform: scale(1.8); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mwz-vote-hole, .mwz-vote-hole-flash { animation: mwz-vote-hole-fade ${fadeSeconds}s linear ${VOTE_IMPACT_FADE_START_MS}ms forwards !important; }
          .mwz-vote-hole-flash { display: none; }
        }
      `}</style>
      {holes.map((hole) => (
        <div
          key={hole.id}
          className="absolute"
          style={{
            left: `${hole.x}%`,
            top: `${hole.y}%`,
            width: `${hole.size}px`,
            height: `${hole.size}px`,
            marginLeft: `${-hole.size / 2}px`,
            marginTop: `${-hole.size / 2}px`,
            animation: `mwz-vote-hole-fade ${fadeSeconds}s ease-in ${VOTE_IMPACT_FADE_START_MS + hole.delayMs}ms forwards`,
          }}
          data-battle-vote-hole={hole.side}
        >
          <div
            className="mwz-vote-hole-flash absolute inset-0 rounded-full"
            style={{
              background: "radial-gradient(circle, rgba(255,236,190,.95) 0 18%, rgba(249,115,22,.55) 40%, rgba(249,115,22,0) 70%)",
              opacity: 0,
              animation: `mwz-vote-hole-flash 320ms ease-out ${hole.delayMs}ms both`,
            }}
          />
          <svg
            className="mwz-vote-hole absolute inset-0 h-full w-full"
            viewBox="-50 -50 100 100"
            style={{ transform: `rotate(${hole.rotation}deg)`, opacity: 0, animation: `mwz-vote-hole-hit 260ms ease-out ${hole.delayMs}ms both` }}
          >
            <g stroke="rgba(245,245,245,.78)" strokeWidth="1.5" strokeLinecap="round" fill="none">
              {hole.cracks.map((angle, index) => {
                const length = 38 + ((index * 37) % 12);
                const rad = (angle * Math.PI) / 180;
                const midX = Math.cos(rad) * length * 0.5;
                const midY = Math.sin(rad) * length * 0.5;
                const bend = rad + (index % 2 ? 0.2 : -0.2);
                const branch = rad + (index % 2 ? -0.55 : 0.55);
                return (
                  <g key={angle}>
                    <path d={`M ${Math.cos(rad) * 12} ${Math.sin(rad) * 12} L ${midX} ${midY} L ${Math.cos(bend) * length} ${Math.sin(bend) * length}`} />
                    {index % 2 === 0 ? (
                      <path strokeWidth="1" d={`M ${midX} ${midY} L ${midX + Math.cos(branch) * 11} ${midY + Math.sin(branch) * 11}`} />
                    ) : null}
                  </g>
                );
              })}
            </g>
            {/* Broken concentric fracture rings, like shattered glass around the impact. */}
            <g stroke="rgba(235,235,235,.45)" strokeWidth="1.1" fill="none">
              <path d="M 22 -4 A 22 22 0 0 1 8 20" />
              <path d="M -14 17 A 22 22 0 0 1 -21 -8" />
              <path d="M -6 -21 A 22 22 0 0 1 14 -17" />
            </g>
            <circle r="19" fill="rgba(235,235,235,.14)" />
            <circle r="14" fill="rgba(240,240,240,.22)" />
            <circle r="11" fill="rgba(8,7,6,.97)" stroke="rgba(250,250,250,.8)" strokeWidth="2" />
            <circle r="7" fill="#000" />
          </svg>
        </div>
      ))}
    </div>
  );
}
