import { PublicKey } from "@solana/web3.js";

// Meteora pool vaults are owned by one program-wide pool_authority PDA per program, so a token
// account owned by one of these holds pool inventory, never a wallet's coins. Both addresses are
// the PDA ["pool_authority"] of the program (pinned in projectImportMeteoraCustody.test.mjs) and
// were read on mainnet 2026-10-29 (DAMM v2 vault of 6roVXGp6…nLeEp, DBC per solanaHolders.js).
export const METEORA_POOL_AUTHORITIES = Object.freeze({
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: "meteora_dbc_vault",
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: "meteora_damm_v2_vault",
});
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

function keyString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

/**
 * Verified custody entries for the mint's largest token accounts that sit in a Meteora pool.
 * Each entry is read on-chain (token program owner, mint and token-account owner), in the same
 * shape the security scan already excludes for Pump.fun pools. Any RPC failure returns [] so the
 * holder check falls back to counting every holder, as before.
 */
export async function readMeteoraPoolCustody({ connection, mint }) {
  if (typeof connection?.getTokenLargestAccounts !== "function" || typeof connection?.getMultipleParsedAccounts !== "function") return [];
  try {
    const mintKey = new PublicKey(mint);
    const mintAddress = mintKey.toBase58();
    const largest = await connection.getTokenLargestAccounts(mintKey, "confirmed");
    const addresses = (Array.isArray(largest?.value) ? largest.value : []).map((entry) => keyString(entry?.address)).filter(Boolean);
    if (!addresses.length) return [];
    const parsed = await connection.getMultipleParsedAccounts(addresses.map((address) => new PublicKey(address)), { commitment: "confirmed" });
    const accounts = Array.isArray(parsed?.value) ? parsed.value : [];
    const custody = [];
    addresses.forEach((tokenAccount, i) => {
      const account = accounts[i];
      const info = account?.data?.parsed?.info;
      if (!account || !TOKEN_PROGRAMS.has(keyString(account.owner)) || account?.data?.parsed?.type !== "account") return;
      const kind = METEORA_POOL_AUTHORITIES[String(info?.owner || "")];
      if (!kind || String(info?.mint || "") !== mintAddress) return;
      custody.push({ verified: true, kind, chainId: 101, mint: mintAddress, tokenAccount, owner: String(info.owner) });
    });
    return custody;
  } catch (error) {
    console.warn("[projectImportMeteoraCustody] Meteora pool custody lookup failed", { mint: String(mint), error: String(error?.message || error) });
    return [];
  }
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
 * Meteora evidence for a Solana token that is not a Pump.fun launch: pool vault custody, the DBC
 * pool (creator + migration flag) and the market stage. A DBC pool that has not migrated is a
 * coin still bonding on another platform, so it keeps the "return after graduation" rule.
 * If the DBC lookup fails while a DBC vault holds supply, the stage is unknown and the lookup
 * throws PROJECT_IMPORT_RPC_UNAVAILABLE rather than letting a bonding coin through.
 */
export async function readMeteoraImportEvidence({ connection, mint, dbcLookup = readDbcPoolForMint }) {
  const custody = await readMeteoraPoolCustody({ connection, mint });
  let dbcPool = null;
  try { dbcPool = await dbcLookup({ connection, mint }); }
  catch (error) {
    if (custody.some((entry) => entry.kind === "meteora_dbc_vault")) {
      throw Object.assign(new Error("Meteora curve lookup is temporarily unavailable. Please retry."), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE", cause: error });
    }
    console.warn("[projectImportMeteoraCustody] DBC pool lookup failed", { mint: String(mint), error: String(error?.message || error) });
  }
  const market = dbcPool && !dbcPool.isMigrated
    ? { phase: "bonding", verified: true, platform: "meteora_dbc", reason: "external_bonding", poolAddress: dbcPool.pool }
    : { phase: "unknown", verified: false, reason: "launch_platform_unverified" };
  return { custody, dbcPool, market };
}
