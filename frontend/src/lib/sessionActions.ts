/**
 * Wallet actions the 30-day sign-in authorizes instead of a fresh signature (founder, 2026-10-06:
 * signatures only for money flows, deploys and on-chain events). Mirrors
 * api/lib/sessionActions.js; sessionActions.test.mjs keeps the lists equal. The token travels in
 * the signature field as `session:<token>`.
 *
 * No imports from feedSession.ts here: walletActionAuth.ts uses this file and feedSession.ts uses
 * walletActionAuth.ts.
 */
export const SESSION_SIGNATURE_PREFIX = "session:";

export const SESSION_AUTH_ACTIONS = new Set<string>([
  // Profile, settings, abuse reports
  "upload_avatar",
  "notification_prefs_set",
  "display_prefs_set",
  "arena_notification_email_set",
  "abuse_open_session",
  // Social graph
  "follow",
  "unfollow",
  "follow_user",
  "unfollow_user",
  "follow_campaign",
  "unfollow_campaign",
  // Images on posts and on imported coins the wallet verifiably owns
  "feed_post_image",
  "arena_import_image",
  // Off-chain votes, opt-ins and check-ins
  "arena_battle_vote",
  "arena_final_salvo_vote",
  "arena_tournament_vote",
  "arena_tournament_opt_in",
  "arena_league_checkin",
  // Joining a recruiter squad (proves the wallet is yours; no money moves)
  "squad_join",
]);

export const SESSION_DRAFT_ACTIONS = new Set<string>(["follow_draft", "comment_draft", "arm_draft_notifications", "react_draft_comment"]);

const KEY_PREFIX = "mwz:feed-session:v1:";

function stores(): Storage[] {
  const out: Storage[] = [];
  try {
    out.push(localStorage);
  } catch {}
  try {
    out.push(sessionStorage);
  } catch {}
  return out;
}

/**
 * The stored sign-in for this wallet: the one opened on `chainId` first, then any other chain (EVM
 * wallets sign in per chain, the server checks the wallet). "" when there is none. Never prompts.
 */
export function storedSessionToken(walletAddress: string, chainId?: number | null): string {
  const wallet = String(walletAddress || "").trim();
  if (!wallet) return "";
  const evm = wallet.startsWith("0x");
  const owns = (key: string) => {
    const owner = key.split(":").slice(4).join(":");
    return evm ? owner.toLowerCase() === wallet.toLowerCase() : owner === wallet;
  };
  let fallback = "";
  for (const store of stores()) {
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = String(store.key(i) || "");
        if (!key.startsWith(KEY_PREFIX) || !owns(key)) continue;
        const token = String(store.getItem(key) || "");
        if (!token) continue;
        if (chainId != null && key.startsWith(`${KEY_PREFIX}${Number(chainId)}:`)) return token;
        if (!fallback) fallback = token;
      }
    } catch {}
  }
  return fallback;
}

/** Drops every stored copy of a token the server no longer accepts. */
export function forgetSessionToken(token: string) {
  if (!token) return;
  for (const store of stores()) {
    try {
      const dead: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = String(store.key(i) || "");
        if (key.startsWith(KEY_PREFIX) && store.getItem(key) === token) dead.push(key);
      }
      dead.forEach((key) => store.removeItem(key));
    } catch {}
  }
}

export function sessionSignature(token: string) {
  return `${SESSION_SIGNATURE_PREFIX}${token}`;
}
