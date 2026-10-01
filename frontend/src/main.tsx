/**
 * Application Entry Point
 * Initializes and mounts the React application to the DOM
 */

import "./polyfills";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./styles/mwz-hud.css";
import "./styles/tactical-command-ui.css";
import "./styles/page-density-fixes.css";
import "./styles/card-cleanup.css";
import "./styles/prepare-title-fix.css";
import "./styles/prepare-auth-ux.css";

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

createRoot(document.getElementById("root")!).render(<App />);
