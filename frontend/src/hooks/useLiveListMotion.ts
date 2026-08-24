import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  displayedWhileFrozen,
  identitiesEqual,
  measureLiveRects,
  playLiveFlip,
} from "@/lib/liveListMotion";

export function useLiveListMotion<T>(input: {
  items: T[];
  identity: (item: T) => string;
  frozen: boolean;
  reducedMotion: boolean;
  snapToken?: string;
}): { items: T[]; containerRef: React.RefObject<HTMLDivElement | null> } {
  const { items, identity, frozen, reducedMotion, snapToken = "" } = input;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [displayed, setDisplayed] = useState<T[]>(items);
  const frozenKeysRef = useRef<string[] | null>(null);
  const frozenItemsRef = useRef<T[]>(items);
  const firstRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const prevSnapRef = useRef(snapToken);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    const idOf = identityRef.current;
    if (snapToken !== prevSnapRef.current) {
      prevSnapRef.current = snapToken;
      frozenKeysRef.current = null;
      frozenItemsRef.current = items;
      setDisplayed(items);
      return;
    }

    if (frozen) {
      if (!frozenKeysRef.current) {
        frozenKeysRef.current = displayedRef.current.map(idOf).filter(Boolean);
        frozenItemsRef.current = displayedRef.current;
      }
      const next = displayedWhileFrozen(frozenKeysRef.current, frozenItemsRef.current, items, idOf);
      frozenItemsRef.current = next;
      setDisplayed(next);
      return;
    }

    if (frozenKeysRef.current) frozenKeysRef.current = null;
    if (identitiesEqual(displayedRef.current, items, idOf)) {
      setDisplayed(items);
      return;
    }
    if (reducedMotion || !containerRef.current) {
      setDisplayed(items);
      return;
    }
    firstRectsRef.current = measureLiveRects(containerRef.current);
    setDisplayed(items);
  }, [frozen, items, reducedMotion, snapToken]);

  useLayoutEffect(() => {
    const first = firstRectsRef.current;
    const container = containerRef.current;
    if (!first || !container) return;
    firstRectsRef.current = null;
    playLiveFlip(container, first);
  }, [displayed]);

  return { items: displayed, containerRef };
}
