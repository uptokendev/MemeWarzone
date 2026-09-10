import crypto from "node:crypto";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";

export const PUMP_CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const PUMP_CHALLENGE_MIN_LAMPORTS = 10_000;
export const PUMP_CHALLENGE_MAX_LAMPORTS = 99_999;

function challengeError(message, code = "PROJECT_IMPORT_PUMP_CHALLENGE_INVALID") {
  return Object.assign(new Error(message), { code });
}

export function createChallengeLamports(randomInt = crypto.randomInt) {
  return randomInt(PUMP_CHALLENGE_MIN_LAMPORTS, PUMP_CHALLENGE_MAX_LAMPORTS + 1);
}

export function pumpChallengePublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    chainId: Number(row.chain_id),
    tokenAddress: row.token_address,
    creatorWallet: row.creator_wallet,
    claimantWallet: row.claimant_wallet,
    lamports: String(row.lamports),
    solAmount: (Number(row.lamports) / 1_000_000_000).toFixed(9),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    txSignature: row.used_tx_signature || null,
    status: row.verified_at ? "verified" : (new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "pending"),
  };
}

export async function createPumpOwnershipChallenge(pool, { tokenAddress, creatorWallet, claimantWallet }) {
  if (!tokenAddress || !creatorWallet || !claimantWallet || creatorWallet === claimantWallet) {
    throw challengeError("Pump.fun ownership challenge requires different valid creator and connected wallets.");
  }
  const expiresAt = new Date(Date.now() + PUMP_CHALLENGE_TTL_MS);
  return pool.query("BEGIN").then(async () => {
    try {
      await pool.query(`UPDATE public.project_import_pump_challenges SET cancelled_at=NOW() WHERE chain_id=101 AND token_address=$1 AND claimant_wallet=$2 AND verified_at IS NULL AND cancelled_at IS NULL AND expires_at>NOW()`, [tokenAddress, claimantWallet]);
      let row = null;
      for (let i = 0; i < 8 && !row; i += 1) {
        const lamports = createChallengeLamports();
        try {
          const result = await pool.query(`INSERT INTO public.project_import_pump_challenges(chain_id,token_address,creator_wallet,claimant_wallet,lamports,expires_at) VALUES(101,$1,$2,$3,$4,$5) RETURNING *`, [tokenAddress, creatorWallet, claimantWallet, lamports, expiresAt]);
          row = result.rows[0];
        } catch (error) {
          if (error?.code !== "23505") throw error;
        }
      }
      if (!row) throw challengeError("Could not create a unique verification amount. Please retry.", "PROJECT_IMPORT_PUMP_CHALLENGE_RETRY");
      await pool.query("COMMIT");
      return row;
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

export async function latestPumpOwnershipChallenge(pool, { tokenAddress, claimantWallet }) {
  const result = await pool.query(`SELECT * FROM public.project_import_pump_challenges WHERE chain_id=101 AND token_address=$1 AND claimant_wallet=$2 AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`, [tokenAddress, claimantWallet]);
  return result.rows[0] || null;
}

function transferMatches(ix, creatorWallet, claimantWallet, lamports) {
  if (!ix || ix.program !== "system" || ix.parsed?.type !== "transfer") return false;
  const info = ix.parsed?.info || {};
  return String(info.source || "") === creatorWallet && String(info.destination || "") === claimantWallet && BigInt(info.lamports ?? -1) === BigInt(lamports);
}

export function parsedTransactionHasChallengeTransfer(tx, { creatorWallet, claimantWallet, lamports }) {
  const message = tx?.transaction?.message;
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  return instructions.some((ix) => transferMatches(ix, creatorWallet, claimantWallet, lamports));
}

export async function findPumpChallengeTransfer(connection, challenge) {
  const claimant = new PublicKey(challenge.claimant_wallet);
  const after = Math.floor(new Date(challenge.created_at).getTime() / 1000) - 2;
  const before = Math.floor(new Date(challenge.expires_at).getTime() / 1000) + 2;
  const signatures = await connection.getSignaturesForAddress(claimant, { limit: 50 }, "finalized");
  for (const entry of signatures) {
    if (entry.err || !entry.blockTime || entry.blockTime < after || entry.blockTime > before) continue;
    const tx = await connection.getParsedTransaction(entry.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.meta.err) continue;
    if (parsedTransactionHasChallengeTransfer(tx, { creatorWallet: challenge.creator_wallet, claimantWallet: challenge.claimant_wallet, lamports: challenge.lamports })) {
      return entry.signature;
    }
  }
  return null;
}

export async function verifyPumpOwnershipChallenge(pool, challenge, connection) {
  if (!challenge) throw challengeError("Verification challenge not found.", "PROJECT_IMPORT_PUMP_CHALLENGE_NOT_FOUND");
  if (challenge.verified_at) return challenge;
  if (challenge.cancelled_at) throw challengeError("This verification challenge was replaced. Start a new one.", "PROJECT_IMPORT_PUMP_CHALLENGE_EXPIRED");
  if (new Date(challenge.expires_at).getTime() <= Date.now()) throw challengeError("This verification challenge expired. Start a new one.", "PROJECT_IMPORT_PUMP_CHALLENGE_EXPIRED");
  const signature = await findPumpChallengeTransfer(connection, challenge);
  if (!signature) throw challengeError("We could not find the exact verification transfer yet. If you just sent it, wait a few seconds and check again.", "PROJECT_IMPORT_PUMP_TRANSFER_NOT_FOUND");
  const result = await pool.query(`UPDATE public.project_import_pump_challenges SET verified_at=NOW(),used_tx_signature=$2 WHERE id=$1 AND verified_at IS NULL AND cancelled_at IS NULL AND expires_at>NOW() RETURNING *`, [challenge.id, signature]);
  if (result.rows[0]) return result.rows[0];
  const current = await pool.query(`SELECT * FROM public.project_import_pump_challenges WHERE id=$1`, [challenge.id]);
  if (current.rows[0]?.verified_at) return current.rows[0];
  throw challengeError("Verification challenge changed before it could be completed. Please retry.", "PROJECT_IMPORT_PUMP_CHALLENGE_RETRY");
}

export async function applyVerifiedPumpChallenge(pool, identity, signer, resolved) {
  if (Number(identity.chainId) !== 101 || resolved?.authoritySource !== "pump_bonding_curve_creator" || !resolved?.currentAuthority || resolved?.signedWalletMatchesAuthority) return resolved;
  const result = await pool.query(`SELECT * FROM public.project_import_pump_challenges WHERE chain_id=101 AND token_address=$1 AND claimant_wallet=$2 AND creator_wallet=$3 AND verified_at IS NOT NULL AND cancelled_at IS NULL ORDER BY verified_at DESC LIMIT 1`, [identity.tokenAddress, signer, resolved.currentAuthority]);
  const proof = result.rows[0];
  if (!proof) return resolved;
  return {
    ...resolved,
    signedWalletMatchesAuthority: true,
    ownershipReason: "pump_creator_transfer_challenge_verified",
    ownershipProofSource: "pump_creator_transfer_challenge",
    ownershipProofTxSignature: proof.used_tx_signature,
    ownershipProofCreatorWallet: proof.creator_wallet,
    ownershipProofClaimantWallet: proof.claimant_wallet,
    ownershipProofVerifiedAt: proof.verified_at,
  };
}

export function pumpChallengeConnection() {
  const endpoint = String(process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL || "").trim();
  if (!endpoint) throw challengeError("Solana verification RPC is unavailable. Please retry later.", "PROJECT_IMPORT_RPC_UNAVAILABLE");
  return new Connection(endpoint, "finalized");
}
