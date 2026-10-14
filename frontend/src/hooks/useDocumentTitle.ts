import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { headForPath } from "../../shared/seoRoutes.mjs";
import { applyHead, resolveHead } from "../../shared/seoApplyHead.mjs";

const BASE = "MemeWarzone";

export type SeoOverride = {
  canonical?: string | null;
  title?: string;
  robots?: string;
  description?: string;
};

let overrideStore: SeoOverride = {};
let overrideVersion = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getVersion = () => overrideVersion;
function setOverrideStore(next: SeoOverride) {
  overrideStore = next;
  overrideVersion += 1;
  listeners.forEach((fn) => fn());
}

/** Lets a page override its head tags while mounted. Cleared on unmount. */
export function useSeoOverride(overrides: SeoOverride) {
  const key = JSON.stringify(overrides ?? {});
  useEffect(() => {
    setOverrideStore(JSON.parse(key));
    return () => setOverrideStore({});
  }, [key]);
}

/** Route → short page title (before · MemeWarzone). */
export function titleForPath(pathname: string): string {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";

  if (path === "/") return "Launchpad";
  if (path === "/feed") return "Feed";
  if (path === "/create") return "Create Coin";
  if (path === "/league" || path === "/leagues") return "Leagues";
  if (path === "/war-room") return "Trade War Room";
  if (path === "/live") return "Live";
  if (path === "/sponsorships/apply") return "Advertise";
  if (path.startsWith("/prepare/")) return "Promotion";
  if (path.includes("/promotion")) return "Promotion Setup";
  if (path.includes("/push-live")) return "Push Live";
  if (path.startsWith("/token/")) return "Token";
  if (path.startsWith("/embed/chart")) return "Chart";
  if (path.startsWith("/battle/")) return "Battle";
  if (path.startsWith("/warzone/battles") || path.startsWith("/arena/battles")) return "Warzone Battles";
  if (path.startsWith("/warzone/tournaments") || path.startsWith("/arena/tournaments")) return "Tournaments";
  if (path.startsWith("/warzone/tournament") || path.startsWith("/arena/tournament")) return "Tournament";
  if (path.startsWith("/warzone/major-war-league") || path.startsWith("/arena/major-war-league")) return "Major War League";
  if (path.startsWith("/warzone/events") || path.startsWith("/arena/events")) return "Tournaments";
  if (path.startsWith("/warzone") || path.startsWith("/arena")) return "Warzone";
  if (path.includes("/command")) return "Creator Tools";
  if (path.startsWith("/profile")) return "Profile";
  if (path.startsWith("/recruiters/") || path.startsWith("/recruiter")) return "Recruiters";
  if (path.startsWith("/airdrops")) return "Airdrops";
  if (path.startsWith("/squads")) return "Squads";
  if (path === "/status") return "Status";
  if (path.startsWith("/playbook") || path.startsWith("/docs")) return "Playbook";

  return "MemeWarzone";
}

export function useDocumentTitle(pageTitle?: string | null) {
  const location = useLocation();
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  const explicit = pageTitle != null && String(pageTitle).trim() ? String(pageTitle).trim() : "";
  const path = location.pathname + location.search;

  useEffect(() => {
    const o = overrideStore;
    const head = headForPath(path, {
      canonical: o.canonical,
      title: o.title,
      description: o.description,
    });
    const title = explicit || head.title || titleForPath(location.pathname);
    applyHead(document, { ...resolveHead(head, o), title });
  }, [path, explicit, version]);
}

/** Drop-in under BrowserRouter — keeps the tab title in sync with navigation. */
export function DocumentTitleSync({ pageTitle }: { pageTitle?: string | null } = {}) {
  useDocumentTitle(pageTitle ?? null);
  return null;
}
