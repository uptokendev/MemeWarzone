import { PublicKey } from "@solana/web3.js";

// Who holds a Solana token's largest balances: exchange pool vaults, launchpad bonding vaults, or
// neither. Every address below was read on mainnet 2026-10-29 (vaults of real pools) or derived
// from the program's own PDA seeds; projectImportMeteoraCustody.test.mjs pins the derivations.
//
// Program-wide vault authorities: one PDA owns every vault of that program.
export const METEORA_POOL_AUTHORITIES = Object.freeze({
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: "meteora_dbc_vault",
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: "meteora_damm_v2_vault",
});
export const AMM_VAULT_AUTHORITIES = Object.freeze({
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: "meteora_damm_v2_vault", // PDA pool_authority of cpamdpZC…
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: "raydium_cpmm_vault", // PDA vault_and_lp_mint_auth_seed of CPMMoo8L… (holds SOAP's vaults)
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "raydium_amm_v4_vault", // PDA "amm authority" of 675kPX9M…
});
export const BONDING_VAULT_AUTHORITIES = Object.freeze({
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: "meteora_dbc_curve", // PDA pool_authority of dbcij3LW…
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: "raydium_launchlab_curve", // PDA vault_auth_seed of LanMV9sA… (LetsBonk)
});
// Per-pool vault owners: the pool account itself owns its vaults; the pool account belongs to the program.
export const AMM_POOL_PROGRAMS = Object.freeze({
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap_vault",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca_whirlpool_vault",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium_clmm_vault",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora_dlmm_vault",
});
export const BONDING_POOL_PROGRAMS = Object.freeze({
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun_curve",
});
// A pool counts when it holds at least 0.1% of supply; a bonding vault blocks from 1% (left-over dust after migration does not).
export const AMM_PROOF_MIN_BPS = 10n;
export const BONDING_BLOCK_MIN_BPS = 100n;
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

function keyString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

/**
 * The mint's largest token accounts, classified on chain. Returns
 * { custody, ammBps, bondingBps, holdings } or { error } when the RPC could not answer.
 * custody keeps the verified Meteora vaults the holder check already excluded, plus every other
 * verified exchange vault (they are pool inventory, not a holder).
 */
export async function readSolanaPoolHoldings({ connection, mint }) {
  if (typeof connection?.getTokenLargestAccounts !== "function" || typeof connection?.getMultipleParsedAccounts !== "function") return { error: "pool_lookup_unsupported" };
  try {
    const mintKey = new PublicKey(mint);
    const mintAddress = mintKey.toBase58();
    const [largest, supply] = await Promise.all([
      connection.getTokenLargestAccounts(mintKey, "confirmed"),
      typeof connection.getTokenSupply === "function" ? connection.getTokenSupply(mintKey, "confirmed") : null,
    ]);
    const entries = (Array.isArray(largest?.value) ? largest.value : []).map((entry) => ({ address: keyString(entry?.address), amount: BigInt(String(entry?.amount ?? "0")) })).filter((entry) => entry.address);
    const totalSupply = BigInt(String(supply?.value?.amount ?? "0"));
    if (!entries.length) return { custody: [], ammBps: 0n, bondingBps: 0n, holdings: [] };
    const parsed = await connection.getMultipleParsedAccounts(entries.map((entry) => new PublicKey(entry.address)), { commitment: "confirmed" });
    const accounts = Array.isArray(parsed?.value) ? parsed.value : [];
    const tokenAccounts = entries.map((entry, i) => {
      const account = accounts[i];
      const info = account?.data?.parsed?.info;
      if (!account || !TOKEN_PROGRAMS.has(keyString(account.owner)) || account?.data?.parsed?.type !== "account" || String(info?.mint || "") !== mintAddress) return null;
      return { ...entry, owner: String(info.owner || "") };
    }).filter(Boolean);
    // Owners that are not a known program-wide authority: read which program owns the owner account.
    const unknownOwners = [...new Set(tokenAccounts.map((entry) => entry.owner).filter((owner) => !AMM_VAULT_AUTHORITIES[owner] && !BONDING_VAULT_AUTHORITIES[owner]))];
    const ownerPrograms = new Map();
    if (unknownOwners.length && typeof connection.getMultipleAccountsInfo === "function") {
      const infos = await connection.getMultipleAccountsInfo(unknownOwners.map((owner) => new PublicKey(owner)), "confirmed");
      unknownOwners.forEach((owner, i) => ownerPrograms.set(owner, keyString(infos?.[i]?.owner)));
    }
    const holdings = tokenAccounts.map((entry) => {
      const program = ownerPrograms.get(entry.owner) || "";
      const amm = AMM_VAULT_AUTHORITIES[entry.owner] || AMM_POOL_PROGRAMS[program] || null;
      const bonding = BONDING_VAULT_AUTHORITIES[entry.owner] || BONDING_POOL_PROGRAMS[program] || null;
      return { tokenAccount: entry.address, owner: entry.owner, ownerProgram: program || null, amount: entry.amount.toString(), kind: bonding || amm || null, role: bonding ? "bonding" : amm ? "amm" : null };
    });
    const bps = (role) => (totalSupply > 0n ? holdings.filter((h) => h.role === role).reduce((sum, h) => sum + BigInt(h.amount), 0n) * 10_000n / totalSupply : 0n);
    const custody = holdings
      .filter((h) => (h.role === "amm" || METEORA_POOL_AUTHORITIES[h.owner]))
      .map((h) => ({ verified: true, kind: METEORA_POOL_AUTHORITIES[h.owner] || h.kind, chainId: 101, mint: mintAddress, tokenAccount: h.tokenAccount, owner: h.owner }));
    return { custody, ammBps: bps("amm"), bondingBps: bps("bonding"), holdings };
  } catch (error) {
    console.warn("[projectImportMeteoraCustody] Solana pool lookup failed", { mint: String(mint), error: String(error?.message || error) });
    return { error: "pool_lookup_unavailable" };
  }
}

/**
 * Verified custody entries for the mint's largest token accounts that sit in an exchange pool or a
 * Meteora vault, in the shape the security scan already excludes for Pump.fun pools. Any RPC failure
 * returns [] so the holder check falls back to counting every holder, as before.
 */
export async function readMeteoraPoolCustody({ connection, mint }) {
  const holdings = await readSolanaPoolHoldings({ connection, mint });
  return holdings.error ? [] : holdings.custody;
}

let dbcClient = null;
async function dbcState(connection) {
  const { DynamicBondingCurveClient } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  if (!dbcClient || dbcClient.connection !== connection) dbcClient = { connection, client: new DynamicBondingCurveClient(connection, "confirmed") };
  return dbcClient.client.state;
}

/** The Meteora DBC pool whose base mint is `mint`, as { pool, creator, isMigrated }, or null. Throws on RPC failure. */
export async function readDbcPoolForMint({ connection, mint }) {
  const found = await (await dbcState(connection)).getPoolByBaseMint(new PublicKey(mint));
  if (!found) return null;
  const account = found.account?.poolState ?? found.account ?? {};
  if (keyString(account.baseMint) !== new PublicKey(mint).toBase58()) return null;
  return { pool: keyString(found.publicKey), creator: keyString(account.creator) || null, isMigrated: Number(account.isMigrated) !== 0 };
}

/**
 * Pool evidence for a Solana token that is not a Pump.fun launch: exchange/bonding vault holdings,
 * the Meteora DBC pool (creator + migration flag), the market stage, and whether graduation is
 * proven (founder 2026-10-29: no token in its bonding phase may be imported).
 * A DBC pool that has not migrated is still bonding. If the DBC lookup fails while a DBC vault holds
 * supply, the stage is unknown and the lookup throws PROJECT_IMPORT_RPC_UNAVAILABLE.
 */
export async function readMeteoraImportEvidence({ connection, mint, dbcLookup = readDbcPoolForMint }) {
  const holdings = await readSolanaPoolHoldings({ connection, mint });
  const custody = holdings.error ? [] : holdings.custody;
  let dbcPool = null;
  try { dbcPool = await dbcLookup({ connection, mint }); }
  catch (error) {
    if (custody.some((entry) => entry.kind === "meteora_dbc_vault") || (holdings.holdings || []).some((h) => h.kind === "meteora_dbc_curve")) {
      throw Object.assign(new Error("Meteora curve lookup is temporarily unavailable. Please retry."), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause: error });
    }
    console.warn("[projectImportMeteoraCustody] DBC pool lookup failed", { mint: String(mint), error: String(error?.message || error) });
  }
  const market = dbcPool && !dbcPool.isMigrated
    ? { phase: "bonding", verified: true, platform: "meteora_dbc", reason: "external_bonding", poolAddress: dbcPool.pool }
    : { phase: "unknown", verified: false, reason: "launch_platform_unverified" };
  return { custody, dbcPool, market, graduationProof: solanaGraduationProof({ holdings, dbcPool }) };
}

/** Graduation proof for a non-Pump Solana token from its pool holdings and DBC state. */
export function solanaGraduationProof({ holdings, dbcPool }) {
  if (dbcPool && !dbcPool.isMigrated) return { proven: false, reason: "meteora_dbc_bonding", pool: dbcPool.pool };
  if (!holdings || holdings.error) return { proven: false, reason: "pool_lookup_unavailable", retryable: true };
  const bonding = holdings.holdings.filter((h) => h.role === "bonding" && BigInt(h.amount) > 0n);
  if (holdings.bondingBps >= BONDING_BLOCK_MIN_BPS) return { proven: false, reason: "bonding_vault_holds_supply", kinds: [...new Set(bonding.map((h) => h.kind))], bondingBps: Number(holdings.bondingBps) };
  if (dbcPool?.isMigrated) return { proven: true, method: "meteora_dbc_migrated", pool: dbcPool.pool };
  const pools = holdings.holdings.filter((h) => h.role === "amm");
  if (holdings.ammBps >= AMM_PROOF_MIN_BPS) return { proven: true, method: "solana_amm_pool", kinds: [...new Set(pools.map((h) => h.kind))], ammBps: Number(holdings.ammBps) };
  return { proven: false, reason: "no_verified_dex_pool" };
}
