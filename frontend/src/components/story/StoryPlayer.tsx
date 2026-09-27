import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { STORY_CHAPTER_KINDS } from "../../../shared/storyContract.mjs";
import { FullStoryPage } from "./FullStoryPage";
import { ShareSheet } from "./ShareSheet";
import { StoryContext } from "./StoryContext";
import { fitSlide } from "./fitSlide";
import { sceneRegistry } from "./sceneRegistry";
import "./StoryPlayer.css";

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Bungee&family=Barlow+Condensed:wght@500;600;800&family=JetBrains+Mono:wght@400;600&display=swap";

function ensureStoryFonts() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`link[data-mwz-story-fonts="1"]`)) return;
  const pre1 = document.createElement("link");
  pre1.rel = "preconnect";
  pre1.href = "https://fonts.googleapis.com";
  const pre2 = document.createElement("link");
  pre2.rel = "preconnect";
  pre2.href = "https://fonts.gstatic.com";
  pre2.crossOrigin = "anonymous";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = FONT_HREF;
  link.setAttribute("data-mwz-story-fonts", "1");
  document.head.append(pre1, pre2, link);
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

export function StoryPlayer({ story, onClose }: { story: any; onClose: () => void }) {
  const chapters = useMemo(
    () =>
      (Array.isArray(story?.chapters) ? story.chapters : []).filter(
        (ch: any) => STORY_CHAPTER_KINDS.includes(ch?.kind) && sceneRegistry[ch.kind],
      ),
    [story],
  );
  const total = chapters.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const fillsRef = useRef<HTMLElement[]>([]);
  const startRef = useRef(0);
  const elapsedRef = useRef(0);
  const pausedRef = useRef(false);
  const indexRef = useRef(0);
  const holdTimer = useRef(0);
  const heldRef = useRef(false);
  const swipedRef = useRef(false);
  const sxRef = useRef<number | null>(null);
  const overlayRef = useRef({ share: false, full: false });

  pausedRef.current = paused;
  indexRef.current = index;
  overlayRef.current = { share: shareOpen, full: fullOpen };

  const duration = (i: number) => Number(chapters[i]?.durationMs || 7000);

  const go = useCallback(
    (next: number) => {
      if (!total) return;
      const clamped = Math.max(0, Math.min(total - 1, next));
      setIndex(clamped);
      elapsedRef.current = 0;
      startRef.current = performance.now();
      fillsRef.current.forEach((el, n) => {
        if (el) el.style.width = n < clamped ? "100%" : "0%";
      });
    },
    [total],
  );

  const pause = useCallback((on: boolean) => {
    if (on === pausedRef.current) return;
    if (on) elapsedRef.current += performance.now() - startRef.current;
    else startRef.current = performance.now();
    pausedRef.current = on;
    setPaused(on);
  }, []);

  useEffect(() => {
    ensureStoryFonts();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useLayoutEffect(() => {
    const run = () => fitSlide(slideRef.current);
    run();
    const raf = requestAnimationFrame(run);
    const t = window.setTimeout(run, 120);
    let cancelled = false;
    const fonts = document.fonts;
    if (fonts?.ready) fonts.ready.then(() => { if (!cancelled) run(); });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [index, fullOpen]);

  useEffect(() => {
    const onResize = () => fitSlide(slideRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const i = indexRef.current;
      if (!pausedRef.current && !overlayRef.current.share && !overlayRef.current.full) {
        const t = elapsedRef.current + (now - startRef.current);
        const fill = fillsRef.current[i];
        if (fill) fill.style.width = `${Math.min(100, (t / duration(i)) * 100)}%`;
        if (t >= duration(i) && i < total - 1) go(i + 1);
      }
      raf = requestAnimationFrame(tick);
    };
    startRef.current = performance.now();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [go, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (overlayRef.current.full) {
          setFullOpen(false);
          pause(false);
          return;
        }
        if (overlayRef.current.share) {
          setShareOpen(false);
          pause(false);
          return;
        }
        onClose();
        return;
      }
      if (overlayRef.current.full || overlayRef.current.share) return;
      if (e.key === "ArrowRight") go(indexRef.current + 1);
      else if (e.key === "ArrowLeft") go(indexRef.current - 1);
      else if (e.key === " ") {
        e.preventDefault();
        pause(!pausedRef.current);
      }
    };
    const onVis = () => {
      if (document.hidden) pause(true);
      else if (!overlayRef.current.share && !overlayRef.current.full) pause(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [go, onClose, pause]);

  const down = () => {
    heldRef.current = false;
    holdTimer.current = window.setTimeout(() => {
      heldRef.current = true;
      pause(true);
    }, 220);
  };
  const up = (dir: number) => {
    window.clearTimeout(holdTimer.current);
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    if (heldRef.current) {
      pause(false);
      return;
    }
    pause(false);
    go(indexRef.current + dir);
  };

  const chapter = chapters[index];
  const Scene = chapter ? sceneRegistry[chapter.kind] : null;
  const coin = story.coin;
  const ctx = {
    story,
    reducedMotion,
    openShare: () => {
      setShareOpen(true);
      pause(true);
    },
    openFullStory: () => {
      setFullOpen(true);
      pause(true);
    },
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="mwz-story-portal">
      <div
        ref={frameRef}
        className={[
          "mwz-story",
          paused ? "paused" : "",
          reducedMotion ? "reduce" : "",
          shareOpen ? "share-open" : "",
          fullOpen ? "full-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ ["--accent" as string]: coin.accent, ["--accent-2" as string]: coin.accent2 }}
        role="region"
        aria-label={`${coin.name} story`}
        tabIndex={0}
        onTouchStart={(e) => {
          sxRef.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          if (fullOpen || shareOpen) return;
          if (sxRef.current == null) return;
          const dx = e.changedTouches[0].clientX - sxRef.current;
          sxRef.current = null;
          if (Math.abs(dx) > 60) {
            swipedRef.current = true;
            window.clearTimeout(holdTimer.current);
            if (heldRef.current) pause(false);
            go(indexRef.current + (dx < 0 ? 1 : -1));
          }
        }}
      >
        <div className="bars">
          {chapters.map((ch: any, n: number) => (
            <div key={ch.id || n} className="bar">
              <b
                ref={(el) => {
                  if (el) fillsRef.current[n] = el;
                }}
              />
            </div>
          ))}
        </div>
        <div className="head">
          <img src={coin.logoUrl} alt="" />
          <div>
            <div className="who">{coin.name}</div>
            <div className="sub">
              ${coin.ticker} · {coin.chainLabel}
            </div>
          </div>
          <span className="counter">
            {index + 1} / {total}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Share this story"
            onClick={() => {
              setShareOpen(true);
              pause(true);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 8l-4-4-4 4M12 4v12"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            Close
          </button>
        </div>
        <StoryContext.Provider value={ctx}>
          {chapter && Scene ? (
            <div className="slide on" ref={slideRef} key={chapter.id || index}>
              <Scene chapter={chapter} coin={coin} />
            </div>
          ) : null}
          {fullOpen ? (
            <FullStoryPage
              story={story}
              onBack={() => {
                setFullOpen(false);
                pause(false);
              }}
            />
          ) : null}
          {shareOpen ? (
            <ShareSheet
              share={story.share}
              coinName={coin.name}
              onClose={() => {
                setShareOpen(false);
                pause(false);
              }}
            />
          ) : null}
        </StoryContext.Provider>
        {!fullOpen && !shareOpen ? (
          <>
            <button
              type="button"
              className="nav prev"
              aria-label="Previous chapter"
              onPointerDown={down}
              onPointerUp={() => up(-1)}
              onPointerLeave={() => {
                window.clearTimeout(holdTimer.current);
                if (heldRef.current) pause(false);
              }}
            />
            <button
              type="button"
              className="nav next"
              aria-label="Next chapter"
              onPointerDown={down}
              onPointerUp={() => up(1)}
              onPointerLeave={() => {
                window.clearTimeout(holdTimer.current);
                if (heldRef.current) pause(false);
              }}
            />
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
