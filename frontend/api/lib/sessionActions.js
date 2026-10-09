/**
 * Wallet actions the 30-day sign-in may authorize instead of a fresh signature (founder, 2026-10-06:
 * "no need for this once signed in with your wallet apart from signing for money flows, deploys or
 * anything that has to do with on chain events"). Anything not listed keeps its own signature:
 * claims, stakes, buy-ins, boosts, war pool support, create/deploy, DBC, imports, ticker
 * reservations, draft saves, ownership claims and payouts. The sign-in itself
 * (`feed_open_session`) can never be one of them.
 *
 * The client sends the token in the signature field as `session:<token>`; the list is mirrored in
 * src/lib/sessionActions.ts (sessionActions.test.mjs keeps them equal).
 */
import { hashFeedSessionToken } from "./feedSessionToken.js";

export const SESSION_SIGNATURE_PREFIX = "session:";

export const SESSION_AUTH_ACTIONS = new Set([
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

export function sessionTokenFromSignature(signature) {
  const raw = String(signature || "").trim();
  if (!raw.startsWith(SESSION_SIGNATURE_PREFIX)) return "";
  return raw.slice(SESSION_SIGNATURE_PREFIX.length).trim();
}

/** Engagement on promotion pages (draft-auth.js), also covered by the sign-in. */
export const SESSION_DRAFT_ACTIONS = new Set(["follow_draft", "comment_draft", "arm_draft_notifications", "react_draft_comment"]);

/** The wallet of a live sign-in token, or "" when it is unknown, revoked or expired. Throws on DB errors. */
export async function sessionWalletForToken(pool, token) {
  if (!token) return "";
  const { rows } = await pool.query(
    `update public.social_feed_sessions
        set last_used_at = now()
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()
      returning wallet_address`,
    [hashFeedSessionToken(token)],
  );
  return rows[0] ? String(rows[0].wallet_address || "") : "";
}
