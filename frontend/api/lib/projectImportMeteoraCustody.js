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
// Holders controlled by a program we do not know (a PDA, or an account owned by an unknown program) at 1%+ refuse:
// an unlisted launchpad's bonding curve sits exactly there. Wallets (on-curve) and known lockers do not.
export const UNKNOWN_PROGRAM_BLOCK_MIN_BPS = 100n;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// Lockers and lending vaults hold supply without bonding it: neither proof nor refusal.
export const NEUTRAL_PROGRAMS = Object.freeze({
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: "streamflow_lock",
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: "jupiter_lock",
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi": "meteora_dynamic_vault",
});
// The other side of a pool must hold at least this much (raw units): 1 SOL, or 150 of a USD stablecoin.
export const QUOTE_MINIMUMS = Object.freeze({
  So11111111111111111111111111111111111111112: 1_000_000_000n,
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 150_000_000n,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 150_000_000n,
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 150_000_000n,
});
// Pools whose vaults sit under one program-wide authority: the vault is a PDA of (pool, mint).
// Seeds checked on mainnet 2026-10-29 (SOAP's CPMM pool, HODL's DAMM v2 pool record both derived vaults).
const AUTHORITY_POOL_PROGRAMS = Object.freeze({
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: { program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", vault: (pool, mint) => [Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()] },
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: { program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", vault: (pool, mint) => [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()] },
});
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
    const ownerData = new Map();
    if (unknownOwners.length && typeof connection.getMultipleAccountsInfo === "function") {
      const infos = await connection.getMultipleAccountsInfo(unknownOwners.map((owner) => new PublicKey(owner)), "confirmed");
      unknownOwners.forEach((owner, i) => { ownerPrograms.set(owner, keyString(infos?.[i]?.owner)); if (infos?.[i]?.data) ownerData.set(owner, Buffer.from(infos[i].data)); });
    }
    const holdings = tokenAccounts.map((entry) => {
      const program = ownerPrograms.get(entry.owner) || "";
      const amm = AMM_VAULT_AUTHORITIES[entry.owner] || AMM_POOL_PROGRAMS[program] || null;
      const bonding = BONDING_VAULT_AUTHORITIES[entry.owner] || BONDING_POOL_PROGRAMS[program] || null;
      const neutral = NEUTRAL_PROGRAMS[program] || null;
      let programControlled = false;
      if (!amm && !bonding && !neutral) {
        // A wallet is an on-curve key with no data or a System-owned account; anything else is a program's.
        let onCurve = false;
        try { onCurve = PublicKey.isOnCurve(new PublicKey(entry.owner).toBytes()); } catch {}
        programControlled = !onCurve || Boolean(program && program !== SYSTEM_PROGRAM);
      }
      return { tokenAccount: entry.address, owner: entry.owner, ownerProgram: program || null, ownerData: ownerData.get(entry.owner) || null, amount: entry.amount.toString(), kind: bonding || amm || neutral || (programControlled ? "unknown_program" : null), role: bonding ? "bonding" : amm ? "amm" : neutral ? "neutral" : programControlled ? "unknown_program" : null };
    });
    const bps = (role) => (totalSupply > 0n ? holdings.filter((h) => h.role === role).reduce((sum, h) => sum + BigInt(h.amount), 0n) * 10_000n / totalSupply : 0n);
    const custody = holdings
      .filter((h) => (h.role === "amm" || METEORA_POOL_AUTHORITIES[h.owner]))
      .map((h) => ({ verified: true, kind: METEORA_POOL_AUTHORITIES[h.owner] || h.kind, chainId: 101, mint: mintAddress, tokenAccount: h.tokenAccount, owner: h.owner }));
    return { custody, ammBps: bps("amm"), bondingBps: bps("bonding"), unknownProgramBps: bps("unknown_program"), holdings, totalSupply };
  } catch (error) {
    console.warn("[projectImportMeteoraCustody] Solana pool lookup failed", { mint: String(mint), error: String(error?.message || error) });
    return { error: "pool_lookup_unavailable" };
  }
}

async function tokenAccounts(connection, addresses) {
  if (!addresses.length) return [];
  const parsed = await connection.getMultipleParsedAccounts(addresses.map((a) => new PublicKey(a)), { commitment: "confirmed" });
  return (parsed?.value || []).map((account, i) => {
    const info = account?.data?.parsed?.info;
    return account && TOKEN_PROGRAMS.has(keyString(account.owner)) && account?.data?.parsed?.type === "account" ? { address: addresses[i], mint: String(info.mint), owner: String(info.owner), amount: BigInt(String(info.tokenAmount?.amount ?? "0")) } : null;
  }).filter(Boolean);
}

/**
 * The exchange vaults among `holdings` that belong to a real pool for this mint with a real quote side:
 * - per-pool vaults (PumpSwap, Orca, Raydium CLMM, Meteora DLMM): the vault's owner IS the pool account,
 *   owned by that program, and its data records both this vault and this mint; the quote vault is
 *   another token account of the pool that the pool data also records;
 * - authority vaults (Raydium CPMM, Meteora DAMM v2): the pool comes from `poolPointers` (DexScreener
 *   pair addresses, a pointer only); the pool must be owned by that program, record this mint, and the
 *   held vault must be the PDA it derives for (pool, mint); the quote vault is derived the same way.
 * A vault counts only with >= 0.1% of supply and a quote side over QUOTE_MINIMUMS. Raydium AMM v4 vaults
 * are not verified here and never count on their own.
 */
export async function verifySolanaPools({ connection, mint, holdings, poolPointers = [] }) {
  const mintKey = new PublicKey(mint);
  const minBase = (holdings.totalSupply || 0n) * AMM_PROOF_MIN_BPS / 10_000n;
  const verified = [];
  const quoteOk = (account) => account && QUOTE_MINIMUMS[account.mint] !== undefined && account.amount >= QUOTE_MINIMUMS[account.mint];
  for (const h of holdings.holdings.filter((x) => x.role === "amm" && AMM_POOL_PROGRAMS[x.ownerProgram || ""] && BigInt(x.amount) >= minBase && minBase > 0n)) {
    const data = h.ownerData;
    if (!data || data.indexOf(new PublicKey(h.tokenAccount).toBuffer()) < 0 || data.indexOf(mintKey.toBuffer()) < 0) continue;
    const owned = await connection.getParsedTokenAccountsByOwner(new PublicKey(h.owner), { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }, "confirmed");
    const quote = (owned?.value || []).map((a) => ({ address: keyString(a.pubkey), mint: String(a.account?.data?.parsed?.info?.mint || ""), amount: BigInt(String(a.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0")) }))
      .find((a) => a.mint !== mintKey.toBase58() && data.indexOf(new PublicKey(a.address).toBuffer()) >= 0 && quoteOk(a));
    if (quote) verified.push({ kind: h.kind, pool: h.owner, vault: h.tokenAccount, quoteMint: quote.mint, quoteAmount: quote.amount.toString() });
  }
  const authorityVaults = holdings.holdings.filter((x) => x.role === "amm" && AUTHORITY_POOL_PROGRAMS[x.owner] && BigInt(x.amount) >= minBase && minBase > 0n);
  if (authorityVaults.length && poolPointers.length) {
    const pools = await connection.getMultipleAccountsInfo(poolPointers.map((p) => new PublicKey(p.pool)), "confirmed");
    for (const [i, pointer] of poolPointers.entries()) {
      const info = pools?.[i];
      if (!info?.data) continue;
      const data = Buffer.from(info.data);
      const poolKey = new PublicKey(pointer.pool);
      for (const h of authorityVaults) {
        const spec = AUTHORITY_POOL_PROGRAMS[h.owner];
        if (keyString(info.owner) !== spec.program || data.indexOf(mintKey.toBuffer()) < 0) continue;
        const base = PublicKey.findProgramAddressSync(spec.vault(poolKey, mintKey), new PublicKey(spec.program))[0];
        if (base.toBase58() !== h.tokenAccount || data.indexOf(base.toBuffer()) < 0) continue;
        const quoteMint = String(pointer.quoteMint || "");
        if (QUOTE_MINIMUMS[quoteMint] === undefined) continue;
        const quoteVault = PublicKey.findProgramAddressSync(spec.vault(poolKey, new PublicKey(quoteMint)), new PublicKey(spec.program))[0];
        if (data.indexOf(quoteVault.toBuffer()) < 0) continue;
        const [quote] = await tokenAccounts(connection, [quoteVault.toBase58()]);
        if (quote && quote.mint === quoteMint && quote.owner === h.owner && quoteOk(quote)) verified.push({ kind: h.kind, pool: pointer.pool, vault: h.tokenAccount, quoteMint, quoteAmount: quote.amount.toString() });
      }
    }
  }
  return verified;
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
export async function readMeteoraImportEvidence({ connection, mint, dbcLookup = readDbcPoolForMint, poolPointers = null }) {
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
  let verifiedPools = [];
  if (!holdings.error && (holdings.holdings || []).some((h) => h.role === "amm")) {
    try { verifiedPools = await verifySolanaPools({ connection, mint, holdings, poolPointers: poolPointers || await dexScreenerSolanaPools(mint) }); }
    catch (error) { return { custody, dbcPool, market, graduationProof: { proven: false, reason: "pool_lookup_unavailable", retryable: true } }; }
  }
  return { custody, dbcPool, market, graduationProof: solanaGraduationProof({ holdings, dbcPool, verifiedPools }) };
}

/** DexScreener's pool addresses for a Solana mint: a pointer to pools whose identity is then checked on chain. */
async function dexScreenerSolanaPools(mint, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(7000) });
    const pairs = response.ok ? await response.json() : [];
    return (Array.isArray(pairs) ? pairs : []).filter((p) => p?.baseToken?.address === mint && p?.pairAddress).slice(0, 10).map((p) => ({ pool: String(p.pairAddress), quoteMint: String(p.quoteToken?.address || "") }));
  } catch { return []; }
}

/** Graduation proof for a non-Pump Solana token from its pool holdings, verified pools and DBC state. */
export function solanaGraduationProof({ holdings, dbcPool, verifiedPools = [] }) {
  if (dbcPool && !dbcPool.isMigrated) return { proven: false, reason: "meteora_dbc_bonding", pool: dbcPool.pool };
  if (!holdings || holdings.error) return { proven: false, reason: "pool_lookup_unavailable", retryable: true };
  if (!holdings.totalSupply) return { proven: false, reason: "supply_unreadable", retryable: true };
  // Left-over base tokens in a migrated DBC pool's vault are not bonding supply.
  const bonding = holdings.holdings.filter((h) => h.role === "bonding" && BigInt(h.amount) > 0n && !(dbcPool?.isMigrated && h.kind === "meteora_dbc_curve"));
  const bondingBps = bonding.reduce((sum, h) => sum + BigInt(h.amount), 0n) * 10_000n / (holdings.totalSupply || 1n);
  if (bondingBps >= BONDING_BLOCK_MIN_BPS) return { proven: false, reason: "bonding_vault_holds_supply", kinds: [...new Set(bonding.map((h) => h.kind))], bondingBps: Number(bondingBps) };
  const unknownBps = holdings.holdings.filter((h) => h.role === "unknown_program").reduce((sum, h) => sum + BigInt(h.amount), 0n) * 10_000n / holdings.totalSupply;
  if (unknownBps >= UNKNOWN_PROGRAM_BLOCK_MIN_BPS) return { proven: false, reason: "unknown_program_holds_supply", owners: holdings.holdings.filter((h) => h.role === "unknown_program").map((h) => h.owner).slice(0, 5), unknownBps: Number(unknownBps) };
  if (dbcPool?.isMigrated) return { proven: true, method: "meteora_dbc_migrated", pool: dbcPool.pool };
  if (verifiedPools.length) return { proven: true, method: "solana_amm_pool", pools: verifiedPools.slice(0, 3) };
  return { proven: false, reason: "no_verified_dex_pool" };
}
