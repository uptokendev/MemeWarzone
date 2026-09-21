import { pool } from "../server/db.js";
import { badMethod, getQuery, isSolanaAddress, json } from "../server/http.js";
import {
  CREATOR_FEE_VAULT_BYTES,
  FEE_ESCROW_BYTES,
  SOLANA_LAUNCHPAD_PROGRAM_ID,
  computeCreatorFeeClaimable,
  decodeRpcAccount,
  deriveCampaignFeeAccounts,
  lamportsToSol,
} from "./lib/solanaCreatorFeeMath.js";

/**
 * GET /api/solana/creator-fees?creator=<pubkey>
 *
 * What a creator can claim from each coin they launched on Solana. The
 * arithmetic lives in lib/solanaCreatorFeeMath.js; this only lists the
 * creator's campaigns and reads the two fee accounts of each.
 */

const SOLANA_CHAIN_ID = 101;

function programId() {
  return String(process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || SOLANA_LAUNCHPAD_PROGRAM_ID).trim();
}

function rpcUrl() {
  return String(process.env.SOLANA_RPC_URL || "").trim();
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.error) throw new Error(`Solana RPC ${method} failed: ${payload.error.message || "unknown"}`);
  return payload.result;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    const creator = String(q.creator || q.wallet || "").trim();
    if (!isSolanaAddress(creator)) return json(res, 400, { error: "Invalid creator" });
    const pid = programId();

    const { rows } = await pool.query(
      `select campaign_address, token_address, name, symbol, logo_uri
         from public.campaigns
        where chain_id = $1
          and creator_address = $2
          and campaign_address is not null
        order by created_at_chain desc nulls last, created_at desc
        limit 50`,
      [SOLANA_CHAIN_ID, creator],
    );
    if (!rows.length) return json(res, 200, { chainId: SOLANA_CHAIN_ID, creator, programId: pid, items: [] });
    if (!rpcUrl()) return json(res, 503, { error: "SOLANA_RPC_URL is not configured" });

    const derived = rows.map((row) => deriveCampaignFeeAccounts(row.campaign_address, pid));
    const [escrowRent, vaultRent, accounts] = await Promise.all([
      rpc("getMinimumBalanceForRentExemption", [FEE_ESCROW_BYTES]),
      rpc("getMinimumBalanceForRentExemption", [CREATOR_FEE_VAULT_BYTES]),
      rpc("getMultipleAccounts", [
        derived.flatMap((d) => [d.feeEscrow, d.creatorFeeVault]),
        { encoding: "base64", commitment: "confirmed" },
      ]),
    ]);
    const values = accounts?.value || [];

    const items = rows.map((row, index) => {
      const computed = computeCreatorFeeClaimable({
        escrow: decodeRpcAccount(values[index * 2]),
        vault: decodeRpcAccount(values[index * 2 + 1]),
        escrowRent,
        vaultRent,
        programId: pid,
      });
      return {
        chainId: SOLANA_CHAIN_ID,
        campaignAddress: String(row.campaign_address),
        tokenAddress: row.token_address ? String(row.token_address) : null,
        name: row.name ?? null,
        symbol: row.symbol ?? null,
        logoUri: row.logo_uri ?? null,
        feeEscrow: derived[index].feeEscrow,
        creatorFeeVault: derived[index].creatorFeeVault,
        escrowInitialized: computed.escrowInitialized,
        vaultInitialized: computed.vaultInitialized,
        escrowSurplusLamports: computed.escrowSurplusLamports.toString(),
        vaultSurplusLamports: computed.vaultSurplusLamports.toString(),
        claimableLamports: computed.claimableLamports.toString(),
        claimableSol: lamportsToSol(computed.claimableLamports),
      };
    });

    return json(res, 200, { chainId: SOLANA_CHAIN_ID, creator, programId: pid, items });
  } catch (error) {
    console.error("[api/solana/creator-fees]", error);
    return json(res, 500, { error: "Creator fee lookup failed." });
  }
}
