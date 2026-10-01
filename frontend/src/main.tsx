/**
 * Application Entry Point
 * Initializes and mounts the React application to the DOM
 */

import "./polyfills";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { shouldRefuseFramed } from "./lib/frameGuard.mjs";
import "./index.css";
import "./styles/mwz-hud.css";
import "./styles/tactical-command-ui.css";
import "./styles/page-density-fixes.css";
import "./styles/card-cleanup.css";
import "./styles/prepare-title-fix.css";
import "./styles/prepare-auth-ux.css";
import "./styles/mw-v2.css";

/**
 * After a Netlify deploy, open tabs may still hold an old main bundle that
 * dynamic-imports deleted /assets/* chunks. SPA fallback used to return HTML
 * (MIME error). One hard reload recovers; guard against loops.
 */
const CHUNK_RELOAD_KEY = "mwz:chunk-reload";
function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || "");
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Loading chunk [\d]+ failed/i.test(msg)
  );
}
function reloadOnceForStaleChunk(reason: string) {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === "1") return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
    console.warn("[mwz] stale deploy chunk — reloading once:", reason);
    window.location.reload();
  } catch {
    window.location.reload();
  }
}
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk("vite:preloadError");
});
window.addEventListener("unhandledrejection", (event) => {
  if (isChunkLoadError(event.reason)) {
    event.preventDefault();
    reloadOnceForStaleChunk(String(event.reason));
  }
});
// Clear the one-shot guard after a successful boot.
try {
  sessionStorage.removeItem(CHUNK_RELOAD_KEY);
} catch {
  /* ignore */
}

// Clickjacking guard: never render the wallet app inside another site's frame (only /embed/chart/*).
if (shouldRefuseFramed(window)) {
  const root = document.getElementById("root");
  if (root) {
    root.textContent = "Open MemeWarzone at app.memewar.zone.";
    root.setAttribute("style", "font:14px sans-serif;color:#ccc;background:#000;padding:16px");
  }
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
