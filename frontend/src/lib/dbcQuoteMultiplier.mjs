/**
 * The ScaledUiAmount multiplier of a DBC quote mint, read in the browser. 1 for SOL and any classic
 * SPL quote; for an xStock, the multiplier in force now. Wallets display raw x multiplier.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getPausableConfig,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import { WSOL_MINT, effectiveMultiplier } from "../../shared/dbcQuotes.mjs";

export async function readQuoteUiMultiplier(connection, mint, nowUnix = Math.floor(Date.now() / 1000)) {
  const key = String(mint || "");
  if (!key || key === WSOL_MINT) return 1;
  const pk = new PublicKey(key);
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return 1;
  return effectiveMultiplier(getScaledUiAmountConfig(unpackMint(pk, info, TOKEN_2022_PROGRAM_ID)), nowUnix);
}

/**
 * Raw balance of `mint` across the owner's token accounts, whichever token program owns the mint
 * (the RPC resolves it from the mint). The classic ATA derivation misses a Token-2022 account.
 */
export async function readOwnerMintBalanceRaw(connection, owner, mint) {
  const res = await connection.getTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, "confirmed");
  let total = 0n;
  for (const { account } of res?.value || []) {
    // SPL and Token-2022 accounts share the base layout: amount is a u64 at offset 64.
    const data = account.data;
    if (data && data.length >= 72) total += new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
  }
  return total;
}

/** The issuer powers on a Token-2022 quote mint as they stand now; null for a classic mint. */
export async function readStockPowers(connection, mint) {
  const pk = new PublicKey(String(mint));
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const m = unpackMint(pk, info, TOKEN_2022_PROGRAM_ID);
  const set = (key) => Boolean(key && !key.equals(PublicKey.default));
  const pausable = getPausableConfig(m);
  const hook = getTransferHook(m);
  const delegate = getPermanentDelegate(m);
  return {
    paused: Boolean(pausable?.paused),
    pauseAuthority: pausable ? set(pausable.authority) : false,
    hookAuthority: hook ? set(hook.authority) : false,
    hookProgram: hook && set(hook.programId) ? hook.programId.toBase58() : null,
    permanentDelegate: delegate ? set(delegate.delegate) : false,
    freezeAuthority: Boolean(m.freezeAuthority),
  };
}
