// Swap-widget partner attribution by fingerprint (founder, 2026-10-09). When the API builds a swap for a
// partner's widget it records a fingerprint of what it built; the import fee ledger computes the same
// fingerprint from the landed transaction and, on a match, splits the fee creator / partner / us.
//   EVM     keccak256(to : data : value) of the built transaction. Wallets sign it as built.
//   Solana  sha256(wallet : Jupiter instruction data). Wallets add their own instructions (compute
//           budget, Lighthouse) and recompile the message, so the whole message changes; the Jupiter
//           instruction's data does not.
// Only the API builds the data, so no one can claim someone else's swap for a partner.
import crypto from "node:crypto";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { keccak256, toUtf8Bytes } from "ethers";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const decode58 = (bs58.default || bs58).decode;

export function solanaFingerprint(wallet, jupiterData) {
  const data = Buffer.from(jupiterData);
  if (!wallet || !data.length) return null;
  return `sol:${crypto.createHash("sha256").update(`${wallet}:`).update(data).digest("hex")}`;
}

/** From the base64 transaction the API hands the wallet (before signing). */
export function solanaFingerprintFromBuilt(base64, wallet) {
  const tx = VersionedTransaction.deserialize(Buffer.from(String(base64 || ""), "base64"));
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === JUPITER_PROGRAM);
  return ix ? solanaFingerprint(wallet, ix.data) : null;
}

/** From a landed transaction (getTransaction jsonParsed): the first top-level Jupiter instruction. */
export function solanaFingerprintFromLanded(tx, wallet) {
  const ix = (tx?.transaction?.message?.instructions || []).find((i) => String(i.programId) === JUPITER_PROGRAM && typeof i.data === "string");
  if (!ix) return null;
  try {
    return solanaFingerprint(wallet, decode58(ix.data));
  } catch {
    return null;
  }
}

export function evmFingerprint(to, data, value) {
  if (!to || !data) return null;
  let amount;
  try {
    amount = BigInt(value ?? 0).toString();
  } catch {
    return null;
  }
  return `evm:${keccak256(toUtf8Bytes(`${String(to).toLowerCase()}:${String(data).toLowerCase()}:${amount}`)).slice(2)}`;
}

export async function recordFingerprint(db, { fingerprint, chainId, partnerId, wallet = null, token = null }) {
  if (!db || !fingerprint || !partnerId) return false;
  await db.query(
    `insert into public.import_swap_fingerprints (fingerprint, chain_id, partner_id, wallet, token_address)
     values ($1, $2, $3, $4, $5) on conflict (fingerprint) do nothing`,
    [fingerprint, chainId, partnerId, wallet, token],
  );
  return true;
}

/** fingerprint -> partner id, for the fingerprints that were recorded. */
export async function partnersForFingerprints(db, chainId, fingerprints) {
  const list = [...new Set(fingerprints.filter(Boolean))];
  if (!db || !list.length) return new Map();
  try {
    const { rows } = await db.query(`select fingerprint, partner_id from public.import_swap_fingerprints where chain_id = $1 and fingerprint = any($2::text[])`, [chainId, list]);
    return new Map(rows.map((row) => [String(row.fingerprint), String(row.partner_id)]));
  } catch (error) {
    if (error?.code === "42P01") return new Map();
    throw error;
  }
}

/** The key partnersForSwaps answers under: the fingerprint and the landed wallet (EVM lowercased, Solana as is). */
export function partnerSwapKey(chainId, fingerprint, wallet) {
  const evm = Number(chainId) !== 101 && Number(chainId) !== 102;
  const w = String(wallet ?? "").trim();
  return `${String(fingerprint)}|${evm ? w.toLowerCase() : w}`;
}

/**
 * Partner attribution of landed swaps: partnerSwapKey(chainId, fingerprint, wallet) -> partner id, only where the
 * wallet the build was recorded for is the wallet that landed the swap (EVM: tx.from, case-insensitive; Solana: the
 * fee payer, exact). A stored NULL wallet never matches. Two wallets that land the same build bytes (same coin,
 * amount and deadline) cannot credit each other's swaps to a partner: the row (first writer wins, on conflict do
 * nothing) names one wallet, and only that wallet's swap matches.
 * swaps: [{ fingerprint, wallet }]
 */
export async function partnersForSwaps(db, chainId, swaps) {
  const wanted = (swaps || []).filter((swap) => swap?.fingerprint && String(swap?.wallet ?? "").trim());
  const list = [...new Set(wanted.map((swap) => String(swap.fingerprint)))];
  if (!db || !list.length) return new Map();
  let rows;
  try {
    ({ rows } = await db.query(`select fingerprint, partner_id, wallet from public.import_swap_fingerprints where chain_id = $1 and fingerprint = any($2::text[])`, [chainId, list]));
  } catch (error) {
    if (error?.code === "42P01") return new Map();
    throw error;
  }
  const out = new Map();
  for (const row of rows) {
    if (row.wallet == null || !String(row.wallet).trim()) continue;
    out.set(partnerSwapKey(chainId, row.fingerprint, row.wallet), String(row.partner_id));
  }
  // Only the asked-for (fingerprint, landed wallet) pairs.
  const asked = new Set(wanted.map((swap) => partnerSwapKey(chainId, swap.fingerprint, swap.wallet)));
  for (const key of [...out.keys()]) if (!asked.has(key)) out.delete(key);
  return out;
}
