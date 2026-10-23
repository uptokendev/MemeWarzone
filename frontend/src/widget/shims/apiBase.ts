/**
 * Widget build only (vite.widget.config.ts aliases "@/lib/apiBase" here). The app's Solana trade code
 * calls apiFetch with app paths; the widget sends the two it needs to their widget routes (same API
 * handlers, open CORS without credentials) and refuses anything else.
 */
let base = "https://api.memewar.zone";
let partner = "";

export function setWidgetApiBase(value: string) {
  base = String(value || base).replace(/\/+$/, "");
}

/**
 * Runs fn with `partnerId` as the ?partner= of the trade authorization it sends (usage counted per partner). apiFetch
 * reads it synchronously when fn calls it, before fn's first await, and it is reset right after, so two boxes on one
 * page never send each other's partner.
 */
export function withWidgetPartner<T>(partnerId: string | null | undefined, fn: () => T): T {
  const previous = partner;
  partner = String(partnerId ?? "").trim();
  try {
    return fn();
  } finally {
    partner = previous;
  }
}

const ROUTES: Record<string, string> = {
  "/api/solana/trade-authorize": "/api/widget/solana/trade-authorize",
  "/api/solana/campaign-account": "/api/widget/solana/campaign-account",
};

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const [pathname, query] = String(path).split("?");
  const mapped = ROUTES[pathname];
  if (!mapped) throw new Error(`The swap widget does not call ${pathname}.`);
  const tagged = partner && pathname === "/api/solana/trade-authorize" ? `partner=${encodeURIComponent(partner)}` : "";
  const search = [query, tagged].filter(Boolean).join("&");
  return fetch(`${base}${mapped}${search ? `?${search}` : ""}`, { ...init, credentials: "omit" });
}
