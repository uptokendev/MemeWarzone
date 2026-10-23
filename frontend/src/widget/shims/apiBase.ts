/**
 * Widget build only (vite.widget.config.ts aliases "@/lib/apiBase" here). The app's Solana trade code
 * calls apiFetch with app paths; the widget sends the two it needs to their widget routes (same API
 * handlers, open CORS without credentials) and refuses anything else.
 */
let base = "https://api.memewar.zone";
let partner = "";

/** partner: the host's partner id, sent as ?partner= on the trade authorization so usage is counted per partner. */
export function setWidgetApiBase(value: string, partnerId?: string) {
  base = String(value || base).replace(/\/+$/, "");
  partner = String(partnerId ?? "").trim();
}

const ROUTES: Record<string, string> = {
  "/api/solana/trade-authorize": "/api/widget/solana/trade-authorize",
  "/api/solana/campaign-account": "/api/widget/solana/campaign-account",
};

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const [pathname, query] = String(path).split("?");
  const mapped = ROUTES[pathname];
  if (!mapped) throw new Error(`The swap widget does not call ${pathname}.`);
  const params = new URLSearchParams(query || "");
  if (partner && pathname === "/api/solana/trade-authorize") params.set("partner", partner);
  const search = params.toString();
  return fetch(`${base}${mapped}${search ? `?${search}` : ""}`, { ...init, credentials: "omit" });
}
