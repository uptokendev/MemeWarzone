import { pool } from "../../server/db.js";
import { badMethod, getQuery, isSolanaAddress, normalizeWalletFlexible, json, readJson } from "../../server/http.js";

// Following a coin is chainless, like following a wallet (founder, 2026-10-14): any wallet follows any
// coin on any chain; only buying and selling need the coin's own wallet. Each address is read by its
// own format. A pair with a Solana side is stored under 101, an EVM pair under 0 (the rule the browser
// already used, so existing rows keep their key); reads and unfollows look at the pair on any chain.
function pairChainId(user, campaign) {
  return isSolanaAddress(user) || isSolanaAddress(campaign) ? 101 : 0;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const q = getQuery(req);
      const user = normalizeWalletFlexible(q.user);
      const campaign = normalizeWalletFlexible(q.campaign);
      if (!user || !campaign) return json(res, 400, { error: "Invalid address" });

      const { rows } = await pool.query(
        `SELECT 1 FROM public.campaign_follows
          WHERE user_address=$1 AND campaign_address=$2
          LIMIT 1`,
        [user, campaign]
      );
      return json(res, 200, { isFollowing: rows.length > 0 });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const action = String(body.action ?? "").toLowerCase();
      const user = normalizeWalletFlexible(body.userAddress);
      const campaign = normalizeWalletFlexible(body.campaignAddress);
      if (!user || !campaign) return json(res, 400, { error: "Invalid address" });
      if (action !== "follow" && action !== "unfollow") return json(res, 400, { error: "Invalid action" });
      // Social follows intentionally skip wallet signatures: connect-wallet identity only.
      // Low-risk write; rate limiting can be added later if spam appears.

      if (action === "follow") {
        await pool.query(
          `INSERT INTO public.campaign_follows (chain_id, user_address, campaign_address)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [pairChainId(user, campaign), user, campaign]
        );
        return json(res, 200, { ok: true });
      }

      await pool.query(
        `DELETE FROM public.campaign_follows
          WHERE user_address=$1 AND campaign_address=$2`,
        [user, campaign]
      );
      return json(res, 200, { ok: true });
    }

    return badMethod(res);
  } catch (e) {
    console.error("follows/campaign error", e);
    return json(res, 500, { error: "Internal error" });
  }
}
