/**
 * CrypticPump partner listing:
 * - Creator: "List on CrypticPump.com" opens iframe modal
 * - Everyone: badge with link once listing_url is stored
 *
 * Success path: partner postMessage with listing URL, or Close re-fetches our API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/apiBase";
import { cn } from "@/lib/utils";

const PARTNER_ORIGIN = "https://crypticpump.com";
const PARTNER_SUBMIT = `${PARTNER_ORIGIN}/partner_submit.php`;
const PENDING_LISTING_PREFIX = "mwz:crypticpump:pendingListing:";

/** CrypticPump purple CTA (list button only) */
const CP_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-violet-400/70 bg-[#1E1530] px-4 text-[15px] font-semibold text-violet-100 hover:border-violet-300 hover:bg-[#2A1D44] hover:text-white";

/** Official partner badge art (public for everyone once listing URL is saved). */
const CP_BADGE_SRC = "/assets/partners/crypticpump-listed-badge.png";

/** Map MWZ chainId → CrypticPump form "chain" select values (BNB | Solana). */
function crypticPumpChainLabel(chainId?: number | null): "BNB" | "Solana" | null {
  if (!chainId || !Number.isFinite(chainId)) return null;
  // Solana mainnet/devnet (MWZ uses 101 in places); everything else BNB family (56/97).
  if (chainId === 101 || chainId === 102 || chainId === 103) return "Solana";
  if (chainId === 56 || chainId === 97) return "BNB";
  // Default EVM → BNB option on their form
  return "BNB";
}

export type CrypticPumpListingData = {
  listingUrl: string;
  campaignAddress?: string;
  tokenAddress?: string | null;
};

/** Absolute public MWZ token details URL (Trading / Launch Link for CrypticPump). */
export function buildPublicTokenPageUrl(
  campaignAddress?: string | null,
  chainId?: number | null,
  originOverride?: string | null,
): string | null {
  const campaign = String(campaignAddress || "").trim();
  if (!campaign) return null;
  const origin = String(
    originOverride ||
      (typeof window !== "undefined" ? window.location?.origin : "") ||
      "",
  ).replace(/\/$/, "");
  if (!origin) return null;
  try {
    const u = new URL(`/token/${encodeURIComponent(campaign)}`, `${origin}/`);
    if (chainId && Number.isFinite(Number(chainId))) {
      u.searchParams.set("chainId", String(chainId));
    }
    return u.toString();
  } catch {
    return `${origin}/token/${encodeURIComponent(campaign)}${
      chainId ? `?chainId=${encodeURIComponent(String(chainId))}` : ""
    }`;
  }
}

/**
 * Partner prefill handshake.
 * Canonical params CrypticPump maps (agreed):
 *   partner, campaign, token, chainId, name, ticker, website,
 *   launchUrl  → Trading / Launch Link (public MWZ token page)
 * Alias: launchLink (same value). chain = BNB | Solana.
 * chainId 56 + 97 both map to BNB on their side.
 */
function buildIframeSrc(args: {
  campaignAddress?: string | null;
  tokenAddress?: string | null;
  chainId?: number | null;
  name?: string | null;
  ticker?: string | null;
  website?: string | null;
  /** Absolute public MWZ token page → launchUrl / Trading field. */
  tokenPageUrl?: string | null;
  /**
   * Exact parent window origin for partner postMessage targetOrigin.
   * If they hardcode https://memewar.zone while the user is on Netlify/www, the browser drops the message.
   */
  parentOrigin?: string | null;
}) {
  const qs = new URLSearchParams();
  qs.set("partner", "memewarzone");

  if (args.campaignAddress) qs.set("campaign", String(args.campaignAddress).trim());

  // Tell partner which origin to target with postMessage (also returnOrigin / embedOrigin aliases).
  const parentOrigin = String(args.parentOrigin || "").trim();
  if (parentOrigin) {
    qs.set("parentOrigin", parentOrigin);
    qs.set("returnOrigin", parentOrigin);
    qs.set("embedOrigin", parentOrigin);
  }

  // Trading / Launch Link — set early so server logs always show it.
  // Canonical: launchUrl (primary). Alias: launchLink.
  const launchUrl = String(
    args.tokenPageUrl || buildPublicTokenPageUrl(args.campaignAddress, args.chainId) || "",
  ).trim();
  if (launchUrl) {
    qs.set("launchUrl", launchUrl);
    qs.set("launchLink", launchUrl);
  }

  const token = String(args.tokenAddress || "").trim();
  if (token) {
    qs.set("token", token);
    qs.set("contract_address", token);
  }

  if (args.chainId) {
    qs.set("chainId", String(args.chainId));
  }
  const chainLabel = crypticPumpChainLabel(args.chainId);
  if (chainLabel) qs.set("chain", chainLabel);

  if (args.name) qs.set("name", String(args.name).trim());
  if (args.ticker) qs.set("ticker", String(args.ticker).replace(/^\$/, "").trim());

  // Project website only (separate from launchUrl).
  const website = String(args.website || "").trim();
  if (website) qs.set("website", website);

  return `${PARTNER_SUBMIT}?${qs.toString()}`;
}

function pendingListingStorageKey(chainId: number, campaignAddress: string) {
  return `${PENDING_LISTING_PREFIX}${chainId}:${String(campaignAddress || "").toLowerCase()}`;
}

function readPendingListingUrl(chainId: number, campaignAddress: string): string | null {
  try {
    const raw = sessionStorage.getItem(pendingListingStorageKey(chainId, campaignAddress));
    return normalizePartnerListingUrl(raw);
  } catch {
    return null;
  }
}

function writePendingListingUrl(chainId: number, campaignAddress: string, listingUrl: string) {
  try {
    sessionStorage.setItem(pendingListingStorageKey(chainId, campaignAddress), listingUrl);
  } catch {
    // ignore quota / private mode
  }
}

function clearPendingListingUrl(chainId: number, campaignAddress: string) {
  try {
    sessionStorage.removeItem(pendingListingStorageKey(chainId, campaignAddress));
  } catch {
    // ignore
  }
}

export async function fetchCrypticPumpListing(
  chainId: number,
  campaignAddress: string,
): Promise<CrypticPumpListingData | null> {
  if (!chainId || !campaignAddress) return null;
  try {
    const qs = new URLSearchParams({
      chainId: String(chainId),
      campaign: campaignAddress,
    });
    const res = await apiFetch(`/api/crypticpump-listings?${qs.toString()}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    const url = String(json?.listing?.listingUrl || "").trim();
    if (!url) return null;
    return {
      listingUrl: url,
      campaignAddress: json?.listing?.campaignAddress,
      tokenAddress: json?.listing?.tokenAddress,
    };
  } catch {
    return null;
  }
}

async function saveCrypticPumpListing(input: {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  listingUrl: string;
  creatorWallet: string;
}): Promise<CrypticPumpListingData> {
  const res = await apiFetch("/api/crypticpump-listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json?.error || `HTTP ${res.status}`));
  const url = String(json?.listing?.listingUrl || input.listingUrl).trim();
  if (!url) throw new Error("Listing saved without URL");
  return { listingUrl: url, campaignAddress: input.campaignAddress, tokenAddress: input.tokenAddress };
}

/** Normalize any CrypticPump listing link (absolute, relative, coin.php?id=…). */
function normalizePartnerListingUrl(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.startsWith("//")) s = `https:${s}`;
  if (s.startsWith("/")) s = `${PARTNER_ORIGIN}${s}`;
  if (/^coin\.php\?/i.test(s) || /^coin\.php\//i.test(s)) s = `${PARTNER_ORIGIN}/${s.replace(/^\//, "")}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Flexible partner postMessage parser (return handshake).
 * Agreed shape:
 *   { source: 'crypticpump', type: 'listing_submitted', listingUrl: 'https://crypticpump.com/coin.php?ca=0x…' }
 * Also accepts aliases + coin id / ca fields until their payload is finalized.
 */
function extractListingUrlFromPartnerMessage(data: unknown): string | null {
  let payload: any = data;
  if (typeof payload === "string") {
    const asUrl = normalizePartnerListingUrl(payload);
    if (asUrl && /crypticpump\.com/i.test(asUrl)) return asUrl;
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const direct = [
    payload.listingUrl,
    payload.listing_url,
    payload.canonicalUrl,
    payload.canonical_url,
    payload.coinUrl,
    payload.coin_url,
    payload.url,
    payload.link,
    payload.href,
    payload.listing?.listingUrl,
    payload.listing?.url,
    payload.data?.listingUrl,
    payload.data?.url,
    payload.payload?.listingUrl,
    payload.payload?.url,
  ];
  for (const c of direct) {
    const n = normalizePartnerListingUrl(c);
    if (n) return n;
  }

  // Build canonical coin page from discrete fields if they only send ids.
  const ca = String(
    payload.ca ||
      payload.contract ||
      payload.contract_address ||
      payload.contractAddress ||
      payload.token ||
      payload.tokenAddress ||
      "",
  ).trim();
  if (ca && (/^0x[a-fA-F0-9]{40}$/.test(ca) || ca.length >= 32)) {
    const built = normalizePartnerListingUrl(`${PARTNER_ORIGIN}/coin.php?ca=${encodeURIComponent(ca)}`);
    if (built) return built;
  }
  const coinId = payload.coinId ?? payload.coin_id ?? payload.id;
  if (coinId != null && String(coinId).trim() && /^\d+$/.test(String(coinId).trim())) {
    const built = normalizePartnerListingUrl(`${PARTNER_ORIGIN}/coin.php?id=${encodeURIComponent(String(coinId).trim())}`);
    if (built) return built;
  }

  // Last resort: any string field that looks like a CrypticPump listing page.
  for (const v of Object.values(payload)) {
    if (typeof v !== "string") continue;
    if (!/crypticpump\.com|coin\.php\?/i.test(v)) continue;
    const n = normalizePartnerListingUrl(v);
    if (n) return n;
  }
  return null;
}

function summarizePartnerMessage(data: unknown): string {
  try {
    if (typeof data === "string") return data.slice(0, 240);
    return JSON.stringify(data).slice(0, 240);
  } catch {
    return String(data);
  }
}

function isCrypticPumpPartnerOrigin(origin: string): boolean {
  const o = String(origin || "").toLowerCase();
  return o.includes("crypticpump.com");
}

export function CrypticPumpBadge({
  listingUrl,
  className,
}: {
  listingUrl: string;
  className?: string;
}) {
  if (!listingUrl) return null;
  return (
    <a
      href={listingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex shrink-0 items-center transition opacity-95 hover:opacity-100",
        className,
      )}
      title="Listed on crypticpump.com"
      aria-label="Listed on crypticpump.com — open listing"
    >
      <img
        src={CP_BADGE_SRC}
        alt="Listed on crypticpump.com"
        className="h-14 w-auto max-w-[min(300px,62vw)] object-contain object-left"
        draggable={false}
      />
    </a>
  );
}

export function CrypticPumpListButton({
  chainId,
  campaignAddress,
  tokenAddress,
  name,
  ticker,
  website,
  creatorWallet,
  listing,
  onListed,
  className,
}: {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string | null;
  name?: string | null;
  ticker?: string | null;
  website?: string | null;
  creatorWallet: string;
  listing: CrypticPumpListingData | null;
  onListed: (listing: CrypticPumpListingData) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeStatus, setIframeStatus] = useState<"loading" | "loaded" | "timeout">("loading");
  /** Debug / ops: last partner postMessage we saw (even if URL could not be parsed). */
  const [lastPartnerPing, setLastPartnerPing] = useState<string | null>(null);
  const [handshakeNote, setHandshakeNote] = useState<string | null>(null);

  const parentOrigin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";

  // Absolute public token page → launchUrl query param (partner form prefill).
  const tokenPageUrl = useMemo(
    () => buildPublicTokenPageUrl(campaignAddress, chainId),
    [campaignAddress, chainId],
  );

  const iframeSrc = useMemo(
    () =>
      buildIframeSrc({
        campaignAddress,
        tokenAddress,
        chainId,
        name,
        ticker,
        website,
        tokenPageUrl,
        parentOrigin,
      }),
    [campaignAddress, tokenAddress, chainId, name, ticker, website, tokenPageUrl, parentOrigin],
  );

  const persist = useCallback(
    async (listingUrl: string) => {
      const normalized = normalizePartnerListingUrl(listingUrl);
      if (!normalized) return false;
      writePendingListingUrl(chainId, campaignAddress, normalized);
      setSaving(true);
      setError(null);
      setHandshakeNote(`Saving listing: ${normalized}`);
      try {
        const saved = await saveCrypticPumpListing({
          chainId,
          campaignAddress,
          tokenAddress,
          listingUrl: normalized,
          creatorWallet,
        });
        clearPendingListingUrl(chainId, campaignAddress);
        onListed(saved);
        setOpen(false);
        setHandshakeNote(`Badge saved: ${saved.listingUrl}`);
        return true;
      } catch (e: any) {
        const msg = e?.message || "Could not save listing";
        setError(msg);
        setHandshakeNote(`Received URL but save failed: ${msg}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [chainId, campaignAddress, tokenAddress, creatorWallet, onListed],
  );

  // Stable refs so the message listener is not torn down on every persist identity change.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const chainIdRef = useRef(chainId);
  chainIdRef.current = chainId;
  const campaignRef = useRef(campaignAddress);
  campaignRef.current = campaignAddress;

  useEffect(() => {
    if (!open) {
      setIframeStatus("loading");
      return;
    }
    setIframeStatus("loading");
    // Do not clear lastPartnerPing / handshakeNote here — success may arrive while status flips.
    // Cross-origin iframes don't fire a reliable error if X-Frame blocks them;
    // if we never get onLoad, surface a fallback after a short wait.
    const t = window.setTimeout(() => {
      setIframeStatus((s) => (s === "loading" ? "timeout" : s));
    }, 8000);
    return () => window.clearTimeout(t);
  }, [open, iframeSrc]);

  /** Close: API re-check, then session pending URL from a prior postMessage. */
  const handleClose = useCallback(async () => {
    if (saving || closing) return;
    setClosing(true);
    setError(null);
    try {
      const existing = await fetchCrypticPumpListing(chainId, campaignAddress);
      if (existing?.listingUrl) {
        clearPendingListingUrl(chainId, campaignAddress);
        onListed(existing);
        setOpen(false);
        return;
      }
      const pending = readPendingListingUrl(chainId, campaignAddress);
      if (pending) {
        const ok = await persist(pending);
        if (ok) return;
      }
      setOpen(false);
    } catch {
      setOpen(false);
    } finally {
      setClosing(false);
    }
  }, [saving, closing, chainId, campaignAddress, onListed, persist]);

  /**
   * Partner return handshake — long-lived listener (empty deps + refs).
   * Partner must postMessage with targetOrigin = this page's origin (or '*').
   * Hardcoding only https://memewar.zone drops messages on Netlify / www.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isCrypticPumpPartnerOrigin(String(event.origin || ""))) return;

      const summary = `${event.origin} · ${summarizePartnerMessage(event.data)}`;
      // Parent console — iframe success.php logs are NOT proof the parent received the event.
      console.info("[CrypticPump parent] postMessage received", {
        origin: event.origin,
        data: event.data,
        pageOrigin: typeof window !== "undefined" ? window.location.origin : "",
      });
      setLastPartnerPing(summary);

      const listingUrl = extractListingUrlFromPartnerMessage(event.data);
      if (listingUrl) {
        writePendingListingUrl(chainIdRef.current, campaignRef.current, listingUrl);
        setHandshakeNote(`Got listing URL from partner: ${listingUrl}`);
        void persistRef.current(listingUrl);
        return;
      }
      setHandshakeNote(
        "CrypticPump messaged us, but no listing URL was found in the payload. They need listingUrl (or ca / coin id).",
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (listing?.listingUrl) {
    return <CrypticPumpBadge listingUrl={listing.listingUrl} className={className} />;
  }

  const busy = saving || closing;

  const modal =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-[rgba(5,6,8,0.75)] p-3 sm:p-4"
            style={{ zIndex: 9999 }}
            role="dialog"
            aria-modal="true"
            aria-label="List on CrypticPump"
          >
            {/* Flat panel: no legacy card class (it still draws the PNG border-image frame). */}
            <div
              className="flex max-h-[min(94vh,920px)] w-full max-w-3xl flex-col overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text"
              style={{ borderImage: "none", boxShadow: "none", clipPath: "none" }}
            >
              <div className="shrink-0 border-b border-mw-border p-4">
                <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Partner</div>
                <h3 className="m-0 mt-0.5 font-mw-cond text-2xl font-bold text-mw-text">List on CrypticPump</h3>
                <p className="mt-1 text-sm text-mw-muted">
                  Free basic listing via the form. After a successful submit, press Close so we can attach the public
                  badge on this token.
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
                <div className="relative min-h-[min(70vh,720px)] w-full overflow-hidden rounded-[14px] border border-mw-border bg-mw-input">
                  {iframeStatus === "loading" ? (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-mw-input text-sm text-mw-muted">
                      Loading CrypticPump form…
                    </div>
                  ) : null}
                  {iframeStatus === "timeout" ? (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-mw-input px-4 text-center">
                      <p className="text-sm text-mw-accent-soft">
                        The form didn&apos;t load in this window (common if production framing is blocked).
                      </p>
                      <a
                        href={iframeSrc}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 text-center"
                      >
                        Open CrypticPump form in a new tab
                      </a>
                      <p className="max-w-md text-sm text-mw-muted">
                        After listing, return here and press Close so we can check for the badge.
                      </p>
                    </div>
                  ) : null}
                  <iframe
                    key={iframeSrc}
                    src={iframeSrc}
                    title="Submit your project to CrypticPump"
                    className="min-h-[min(70vh,720px)] w-full border-0 bg-mw-input"
                    style={{ borderImage: "none", borderRadius: 0, boxShadow: "none" }}
                    loading="eager"
                    referrerPolicy="strict-origin-when-cross-origin"
                    onLoad={() => setIframeStatus("loaded")}
                  />
                </div>
                {error ? <p className="mt-3 text-sm text-mw-sell">{error}</p> : null}
                <div className="mt-3 space-y-1 rounded-[10px] border border-mw-border bg-mw-input p-3 text-xs text-mw-muted">
                  <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Return handshake</div>
                  <p>
                    Parent page origin:{" "}
                    <span className="font-mw-mono text-mw-text">{parentOrigin || "(unknown)"}</span>
                    . Partner must <span className="font-mw-mono text-mw-text">postMessage(..., parentOrigin)</span>{" "}
                    or <span className="font-mw-mono text-mw-text">'*'</span>. Hardcoding only{" "}
                    <span className="font-mw-mono text-mw-text">https://memewar.zone</span> drops the event on
                    Netlify / www.
                  </p>
                  <p className="text-mw-muted">
                    We pass <span className="font-mw-mono">parentOrigin</span> /{" "}
                    <span className="font-mw-mono">returnOrigin</span> on the iframe URL for them to read.
                  </p>
                  {handshakeNote ? <p className="text-mw-accent-soft">{handshakeNote}</p> : null}
                  {lastPartnerPing ? (
                    <p className="break-all font-mw-mono text-[11px] text-mw-text">Last parent ping: {lastPartnerPing}</p>
                  ) : (
                    <p className="text-mw-muted">
                      No postMessage received on the <strong>parent</strong> page yet. Iframe{" "}
                      <span className="font-mw-mono">[CrypticPump handshake]</span> logs only prove they <em>sent</em> —
                      not that this page got it.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-2 border-t border-mw-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-snug text-mw-muted sm:max-w-[65%]">
                  After you submit on CrypticPump, press <span className="font-semibold text-mw-text">Close</span>. We re-check
                  whether the listing was saved and show the badge if it was.
                </p>
                <Button
                  type="button"
                  className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 shrink-0"
                  disabled={busy}
                  onClick={() => void handleClose()}
                >
                  {closing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking listing…
                    </>
                  ) : (
                    "Close"
                  )}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        className={cn(CP_BTN, className)}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        List on CrypticPump.com
      </Button>
      {modal}
    </>
  );
}
