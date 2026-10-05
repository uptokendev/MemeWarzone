import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaChain, normalizeAddress, json, readJson } from "../../server/http.js";
import { createFeedSessionAuth } from "../lib/feedSessionAuth.js";
import { notifyFollow } from "../lib/socialNotify.js";

const feedSession = createFeedSessionAuth({ pool });

// "x followed you" only for a follower proven by their own feed session (follows themselves stay
// unsigned). A missing or foreign session just means no notification; the follow still saves.
async function verifiedFollower(req, follower) {
  if (!/^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""))) return false;
  const quiet = { status() { return this; }, json() { return this; } };
  const session = await feedSession.requireSession(req, quiet).catch(() => null);
  if (!session) return false;
  const a = String(session.walletAddress || "");
  return a.startsWith("0x") ? a.toLowerCase() === String(follower).toLowerCase() : a === follower;
}

// Social follows are wallet-to-wallet, not per-chain. Store EVM follows under chain_id=0 so
// profile views on 56/97/unconnected wallets share the same graph. Solana keeps its chain id.
function socialChainId(chainId) {
  return isSolanaChain(chainId) ? Number(chainId) : 0;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const q = getQuery(req);
      const rawChainId = Number(q.chainId ?? 0) || 0;
      const chainId = socialChainId(rawChainId);
      const rawFollower = String(q.follower ?? "").trim();
      const rawFollowing = String(q.following ?? "").trim();
      const isSol = isSolanaChain(chainId);
      const follower = normalizeAddress(rawFollower, chainId);
      const following = normalizeAddress(rawFollowing, chainId);
      if (!follower || !following) return json(res, 400, { error: "Invalid address" });
      if (!isSol && (!isAddress(follower) || !isAddress(following))) return json(res, 400, { error: "Invalid address" });

      // Accept legacy rows stored under the caller's chainId as well as canonical 0.
      const { rows } = await pool.query(
        `SELECT 1 FROM public.user_follows
          WHERE follower_address = $1 AND following_address = $2
            AND (chain_id = $3 OR ($3 = 0 AND chain_id IN (0, 56, 97)))
          LIMIT 1`,
        [follower, following, chainId]
      );
      return json(res, 200, { isFollowing: rows.length > 0 });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const rawChainId = Number(body.chainId ?? 0) || 0;
      const chainId = socialChainId(rawChainId);
      const action = String(body.action ?? "").toLowerCase();
      const rawFollower = String(body.followerAddress ?? "").trim();
      const rawFollowing = String(body.followingAddress ?? "").trim();
      const isSol = isSolanaChain(chainId);
      const follower = normalizeAddress(rawFollower, chainId);
      const following = normalizeAddress(rawFollowing, chainId);
      if (!follower || !following) return json(res, 400, { error: "Invalid address" });
      if (!isSol && (!isAddress(follower) || !isAddress(following))) return json(res, 400, { error: "Invalid address" });
      if (follower === following) return json(res, 400, { error: "Cannot follow self" });
      if (action !== "follow" && action !== "unfollow") return json(res, 400, { error: "Invalid action" });
      // Social follows intentionally skip wallet signatures: connect-wallet identity only.
      // Low-risk write; rate limiting can be added later if spam appears.

      if (action === "follow") {
        await pool.query(
          `INSERT INTO public.user_follows (chain_id, follower_address, following_address)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [chainId, follower, following]
        );
        if (await verifiedFollower(req, follower)) void notifyFollow(pool, { follower, following });
        // Collapse legacy per-chain EVM duplicates into the canonical row.
        if (chainId === 0) {
          await pool.query(
            `DELETE FROM public.user_follows
              WHERE follower_address = $1 AND following_address = $2 AND chain_id IN (56, 97)`,
            [follower, following]
          );
        }
        return json(res, 200, { ok: true });
      }

      await pool.query(
        `DELETE FROM public.user_follows
          WHERE follower_address = $1 AND following_address = $2
            AND (chain_id = $3 OR ($3 = 0 AND chain_id IN (0, 56, 97)))`,
        [follower, following, chainId]
      );
      return json(res, 200, { ok: true });
    }

    return badMethod(res);
  } catch (e) {
    console.error("follows/user error", e);
    return json(res, 500, { error: "Internal error" });
  }
}