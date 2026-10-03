import { normalizeAddress } from "../../server/http.js";
import { requireWalletActionAuth } from "./walletActionAuth.js";
import {
  FEED_SESSION_ACTION,
  FEED_SESSION_SCOPE,
  createFeedSessionToken,
  hashFeedSessionToken,
} from "./feedSessionToken.js";

export { FEED_SESSION_ACTION, FEED_SESSION_SCOPE, createFeedSessionToken, hashFeedSessionToken };

// One signature covers every social action for 30 days (founder, 2026-10-03): posting, replies,
// reposts, quotes, rockets, comments (feed, coin, battle), War Room chat, report, block and hide.
// Actions that tie something to the wallet (username, profile, settings, ownership, payments) keep
// their own signature.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readSessionToken(req) {
  const header = String(req.headers?.authorization || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();
  return String(req.headers?.["x-feed-session"] || "").trim();
}

export function createFeedSessionAuth({ pool }) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("createFeedSessionAuth requires a Postgres pool");
  }

  async function openSession(req, res) {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const chainId = Number(body.chainId ?? body.chain_id);
    const wallet = normalizeAddress(body.walletAddress || body.wallet || body.address, chainId);

    const verified = await requireWalletActionAuth({
      res,
      pool,
      auth: body,
      expectedWallet: wallet,
      chainId,
      action: FEED_SESSION_ACTION,
      extraLines: [FEED_SESSION_SCOPE],
      routeLabel: "feed/session",
      strict: true,
    });
    if (!verified) return null;

    const token = createFeedSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query(
      `insert into public.social_feed_sessions
         (token_hash, wallet_address, chain_id, expires_at)
       values ($1, $2, $3, $4)`,
      [hashFeedSessionToken(token), verified.walletAddress, verified.chainId, expiresAt.toISOString()],
    );

    return {
      ok: true,
      token,
      expiresAt: expiresAt.toISOString(),
      walletAddress: verified.walletAddress,
      chainId: verified.chainId,
    };
  }

  async function requireSession(req, res) {
    const token = readSessionToken(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Feed session required.", code: "FEED_SESSION_REQUIRED" });
      return null;
    }

    try {
      const { rows } = await pool.query(
        `update public.social_feed_sessions
            set last_used_at = now()
          where token_hash = $1
            and revoked_at is null
            and expires_at > now()
          returning wallet_address, chain_id, expires_at`,
        [hashFeedSessionToken(token)],
      );
      const row = rows[0];
      if (!row) {
        res.status(401).json({ ok: false, error: "Feed session required.", code: "FEED_SESSION_REQUIRED" });
        return null;
      }
      return {
        walletAddress: String(row.wallet_address),
        chainId: Number(row.chain_id),
        expiresAt: row.expires_at,
      };
    } catch (error) {
      console.error("[feedSessionAuth] session lookup failed", error?.message || error);
      res.status(503).json({ ok: false, error: "Feed authorization is unavailable.", code: "FEED_AUTH_UNAVAILABLE" });
      return null;
    }
  }

  return { openSession, requireSession };
}
