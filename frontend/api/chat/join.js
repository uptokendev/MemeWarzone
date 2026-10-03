import { pool } from "../../server/db.js";
import { badMethod, isSolanaChain, json, readJson } from "../../server/http.js";
import { createFeedSessionAuth } from "../lib/feedSessionAuth.js";
import {
  consumeNonce,
  createChatSession,
  ensureAuthNonceSchema,
  ensureChatSchema,
  fetchProfile,
  normalizeAddress,
  verifyChatSessionSignature,
} from "./_lib.js";

const feedSession = createFeedSessionAuth({ pool });

export default async function handler(req, res) {
  if (req.method !== "POST") return badMethod(res);
  try {
    await ensureAuthNonceSchema();
    await ensureChatSchema();

    const b = await readJson(req);
    // With a feed session (one signature per 30 days, founder 2026-10-03) the wallet comes from the
    // session and joining the room needs no signature. Without one the signed path below is unchanged.
    const bearer = /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""));
    const feed = bearer ? await feedSession.requireSession(req, res) : null;
    if (bearer && !feed) return;
    const chainId = Number(b.chainId);
    const campaignAddress = normalizeAddress(b.campaignAddress);
    const address = normalizeAddress(feed ? feed.walletAddress : b.address);
    const nonce = String(b.nonce ?? "").trim();
    const signature = String(b.signature ?? "").trim();

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!campaignAddress) return json(res, 400, { error: "Invalid campaignAddress" });
    if (!address) return json(res, 400, { error: "Invalid address" });
    if (feed) {
      // A Solana session joins Solana rooms, an EVM session EVM rooms.
      if (isSolanaChain(chainId) !== isSolanaChain(Number(feed.chainId))) {
        return json(res, 400, { error: "Connect a wallet on this coin's chain to join the chat" });
      }
    } else {
      if (!nonce) return json(res, 400, { error: "Nonce missing" });
      if (!signature) return json(res, 400, { error: "Signature missing" });

      await consumeNonce(chainId, address, nonce);
      const recovered = verifyChatSessionSignature({ chainId, address, campaignAddress, nonce, signature });
      if (recovered !== address) return json(res, 401, { error: "Invalid signature" });
    }

    const profile = await fetchProfile(chainId, address);
    const role = normalizeAddress(b.creatorAddress) === address ? "creator" : "trader";
    const session = await createChatSession({
      chainId,
      campaignAddress,
      walletAddress: address,
      displayName: profile?.display_name ?? null,
      avatarUrl: profile?.avatar_url ?? null,
      role,
    });

    return json(res, 200, {
      sessionToken: session.rawToken,
      expiresAt: session.expiresAt,
      profile: {
        walletAddress: address,
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
        role,
      },
    });
  } catch (e) {
    const msg = String(e?.message ?? "");
    const status = /nonce|signature/i.test(msg) ? 401 : 500;
    console.error("[api/chat/join]", e);
    return json(res, status, {
      error: status === 401 ? msg : "Server error",
      details: process.env.NODE_ENV !== "production" ? msg : undefined,
    });
  }
}
