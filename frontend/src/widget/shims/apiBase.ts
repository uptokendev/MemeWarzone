/**
 * Widget build only (vite.widget.config.ts aliases "@/lib/apiBase" here). The app's Solana trade code
 * calls apiFetch with app paths; the widget sends the two it needs to their widget routes (same API
 * handlers, open CORS without credentials) and refuses anything else.
 */
let base = "https://api.memewar.zone";

export function setWidgetApiBase(value: string) {
  base = String(value || base).replace(/\/+$/, "");
}

const ROUTES: Record<string, string> = {
  "/api/solana/trade-authorize": "/api/widget/solana/trade-authorize",
  "/api/solana/campaign-account": "/api/widget/solana/campaign-account",
};

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const [pathname, query] = String(path).split("?");
  const mapped = ROUTES[pathname];
  if (!mapped) throw new Error(`The swap widget does not call ${pathname}.`);
  return fetch(`${base}${mapped}${query ? `?${query}` : ""}`, { ...init, credentials: "omit" });
}
