import { PublicKey } from "@solana/web3.js";
import { readPumpImportEvidence } from "./projectImportPumpEvidence.js";
import { getGenesisHashCached } from "./solanaGenesisHashCache.js";

// Pump's published IDL: BondingCurve = discriminator + 5*u64 + bool + creator.
// The account is derived for the requested mint; no token suffix, holder list
// or off-chain metadata is accepted as ownership proof. The only fee payer that
// counts is the one of the transaction that initialized this mint, when it also set
// itself as the initial mint authority, and only when there is no Pump curve and the
// mint authority is revoked (founder, 2026-10-29). A relayer, launchpad program or
// multisig vault puts a different initial authority there and stays on manual review.
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const ZERO = new PublicKey("11111111111111111111111111111111");
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
// 5 pages of 1000 signatures. A mint with a longer history stays on manual review
// instead of costing an unbounded walk back through the RPC.
export const MINT_CREATOR_MAX_PAGES = 5;
const MINT_CREATOR_PAGE = 1000;
const MINT_CREATOR_CACHE_MAX = 1000;
// The creation transaction never changes, so a resolved creator is cached per process.
const mintCreatorCache = new Map();

function unavailable(reason, evidenceAccount = null) {
  return { currentAuthority: null, authoritySource: null, authorityEvidenceAccount: evidenceAccount, ownershipReason: reason };
}
function rpcError(message) {
  return Object.assign(new Error(message), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
}
export async function assertSolanaImportMainnet(connection) {
  if (typeof connection?.getGenesisHash !== "function") throw rpcError("Solana network verification is unavailable. Please retry.");
  let genesis;
  try { genesis = await getGenesisHashCached(connection); }
  catch { throw rpcError("Solana network verification is temporarily unavailable. Please retry."); }
  if (genesis !== SOLANA_MAINNET_GENESIS) {
    throw Object.assign(new Error("The import service is connected to the wrong Solana network. Solana mainnet is required."), { code: "PROJECT_IMPORT_CHAIN_MISMATCH" });
  }
}
/**
 * Pump.fun: the curve account's own `complete` flag proves graduation (the coin moved to PumpSwap or,
 * for old coins, Raydium). The flag is byte 48 of the curve (discriminator + 5*u64), present in every
 * layout; old 49-byte curves (no creator field) are read the same way (SN 3FDydrow…, 2026-10-29).
 */
export function pumpCurveComplete(account) {
  if (!account || account.executable || !account.owner?.equals?.(PUMP_PROGRAM_ID) || !(account.data instanceof Uint8Array)) return null;
  const data = Buffer.from(account.data);
  if (data.length < 49 || !data.subarray(0, 8).equals(CURVE_DISCRIMINATOR) || ![0, 1].includes(data[48])) return null;
  return data[48] === 1;
}
export function pumpGraduationProof(evidence, curveAccount = null) {
  const complete = typeof evidence?.curveComplete === "boolean" ? evidence.curveComplete : pumpCurveComplete(curveAccount);
  if (complete === true) return { proven: true, method: "pump_curve_complete", curve: evidence?.curveAddress ?? null };
  return { proven: false, reason: complete === false ? "pump_curve_bonding" : "pump_curve_unreadable" };
}
export function pumpBondingCurveAddress(mint) {
  const mintKey = new PublicKey(mint);
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKey.toBuffer()], PUMP_PROGRAM_ID)[0];
}
export function decodePumpProjectCreator(account) {
  if (!account || account.executable || !account.owner?.equals?.(PUMP_PROGRAM_ID)) return null;
  if (!(account.data instanceof Uint8Array)) return null;
  const data = Buffer.from(account.data);
  if (data.length < 81 || !data.subarray(0, 8).equals(CURVE_DISCRIMINATOR) || ![0, 1].includes(data[48])) return null;
  const creator = new PublicKey(data.subarray(49, 81));
  // A zero or PDA creator cannot sign a personal-wallet claim. In particular,
  // never treat a fee-sharing PDA or one of its recipients as the project owner.
  if (creator.equals(ZERO) || !PublicKey.isOnCurve(creator.toBytes())) return null;
  return creator.toBase58();
}
export async function resolveSolanaProjectAuthority({ connection, mint, mintAuthority, claimant = null, tokenProgram = null, readMeteora = null }) {
  const curve = pumpBondingCurveAddress(mint);
  if (typeof connection?.getAccountInfo !== "function") throw rpcError("Solana project-wallet lookup is unavailable. Please retry.");
  let account;
  try { account = await connection.getAccountInfo(curve, "confirmed"); }
  catch { throw rpcError("Solana project-wallet lookup is temporarily unavailable. Please retry."); }
  // Only a curve account Pump.fun owns makes this a Pump token: anyone can fund the PDA address with
  // lamports (a System-owned account), which must not turn a Raydium/Meteora token into "Pump, unreadable".
  if (account && account.owner?.equals?.(PUMP_PROGRAM_ID)) {
    const projectAuthorityEvidence = await readPumpImportEvidence({ connection, mint, curveAccount: account, claimant, tokenProgram });
    const context = { projectAuthorityEvidence, market: projectAuthorityEvidence.market, custody: projectAuthorityEvidence.custody, graduationProof: pumpGraduationProof(projectAuthorityEvidence, account) };
    if (projectAuthorityEvidence.authorityError) return { ...unavailable(projectAuthorityEvidence.authorityError, curve.toBase58()), ...context };
    const creator = decodePumpProjectCreator(account);
    if (!creator) return { ...unavailable("project_creator_requires_manual_review", curve.toBase58()), ...context };
    // A genuine, contradictory, independently signable mint authority is not
    // silently overridden. Pump's program authority and revoked authority are normal.
    if (mintAuthority) {
      const authority = new PublicKey(mintAuthority);
      if (!authority.equals(ZERO) && PublicKey.isOnCurve(authority.toBytes()) && authority.toBase58() !== creator) {
        return { ...unavailable("conflicting_project_authorities", curve.toBase58()), ...context };
      }
    }
    return { currentAuthority: creator, authoritySource: "pump_bonding_curve_creator", authorityEvidenceAccount: curve.toBase58(), ownershipReason: "project_creator_resolved", ...context };
  }
  // Not a Pump.fun launch. Meteora evidence (pool vault custody, DBC pool, bonding stage) when available.
  const meteora = typeof readMeteora === "function" ? await readMeteora() : null;
  const context = {
    market: meteora?.market || { phase: "unknown", verified: false, reason: "launch_platform_unverified" },
    ...(meteora ? { custody: meteora.custody || [], graduationProof: meteora.graduationProof || null } : {}),
  };
  if (mintAuthority) {
    const authority = new PublicKey(mintAuthority);
    if (!authority.equals(ZERO) && PublicKey.isOnCurve(authority.toBytes())) {
      return { currentAuthority: authority.toBase58(), authoritySource: "mint_authority", authorityEvidenceAccount: new PublicKey(mint).toBase58(), ownershipReason: "mint_authority_resolved", ...context };
    }
  }
  // A Meteora DBC launch records its creator in the pool account, like the Pump curve does.
  const dbcCreator = signableWallet(meteora?.dbcPool?.creator);
  if (dbcCreator) {
    return {
      currentAuthority: dbcCreator,
      authoritySource: "meteora_dbc_creator",
      authorityEvidenceAccount: meteora.dbcPool.pool,
      ownershipReason: "meteora_dbc_creator_resolved",
      projectAuthorityEvidence: { authorityType: "meteora_dbc_creator", platform: "meteora_dbc", creator: dbcCreator, pool: meteora.dbcPool.pool, migrated: meteora.dbcPool.isMigrated },
      ...context,
    };
  }
  // A program-held (PDA) mint authority means a program still controls supply; no creator fallback.
  if (mintAuthority) return { ...unavailable("project_authority_unavailable"), ...context };
  const created = await resolveSolanaMintCreator({ connection, mint });
  if (created.creator) {
    return {
      currentAuthority: created.creator,
      authoritySource: "mint_creator",
      authorityEvidenceAccount: created.signature,
      ownershipReason: "mint_creator_resolved",
      projectAuthorityEvidence: { authorityType: "mint_creator", creator: created.creator, creationSignature: created.signature, slot: created.slot, blockTime: created.blockTime },
      ...context,
    };
  }
  return { ...unavailable(created.reason || "project_authority_unavailable"), ...context };
}

function signableWallet(value) {
  try {
    const key = new PublicKey(String(value || ""));
    return !key.equals(ZERO) && PublicKey.isOnCurve(key.toBytes()) ? key.toBase58() : null;
  } catch { return null; }
}

function keyString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

function initializesMint(ix, mint) {
  const type = String(ix?.parsed?.type || "");
  return TOKEN_PROGRAMS.has(keyString(ix?.programId)) && (type === "initializeMint" || type === "initializeMint2") && keyString(ix?.parsed?.info?.mint) === mint;
}

/**
 * Fee payer of the successful transaction that initialized `mint`, when that is the mint's
 * oldest successful transaction, the payer is a signing, on-curve wallet other than the mint,
 * and the initializeMint instruction set that same wallet as the initial mint authority.
 * Returns { creator, signature, slot, blockTime } or { creator: null, reason }. Throws
 * PROJECT_IMPORT_RPC_UNAVAILABLE on RPC failure so a transient error is never read as "no creator".
 */
export function mintCreatorFromParsedTransaction(tx, mint) {
  if (!tx || tx.meta?.err) return null;
  const message = tx.transaction?.message;
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const payer = keys[0];
  const payerKey = keyString(payer?.pubkey ?? payer);
  if (!payerKey || payer?.signer !== true || payerKey === mint) return null;
  let payerPublicKey;
  try { payerPublicKey = new PublicKey(payerKey); } catch { return null; }
  if (payerPublicKey.equals(ZERO) || !PublicKey.isOnCurve(payerPublicKey.toBytes())) return null;
  const inner = (Array.isArray(tx.meta?.innerInstructions) ? tx.meta.innerInstructions : []).flatMap((entry) => Array.isArray(entry?.instructions) ? entry.instructions : []);
  const instructions = [...(Array.isArray(message?.instructions) ? message.instructions : []), ...inner];
  const init = instructions.filter((ix) => initializesMint(ix, mint));
  if (init.length !== 1) return null;
  if (keyString(init[0]?.parsed?.info?.mintAuthority) !== payerPublicKey.toBase58()) return null;
  return payerPublicKey.toBase58();
}

export async function resolveSolanaMintCreator({ connection, mint }) {
  const mintKey = new PublicKey(mint);
  const mintAddress = mintKey.toBase58();
  if (mintCreatorCache.has(mintAddress)) return mintCreatorCache.get(mintAddress);
  if (typeof connection?.getSignaturesForAddress !== "function" || typeof connection?.getParsedTransaction !== "function") {
    throw rpcError("Solana mint-history lookup is unavailable. Please retry.");
  }
  let before;
  let oldestPage = [];
  for (let page = 0; ; page += 1) {
    if (page >= MINT_CREATOR_MAX_PAGES) return remember(mintAddress, { creator: null, reason: "mint_creator_history_too_long" });
    let rows;
    try { rows = await connection.getSignaturesForAddress(mintKey, { limit: MINT_CREATOR_PAGE, ...(before ? { before } : {}) }, "confirmed"); }
    catch { throw rpcError("Solana mint-history lookup is temporarily unavailable. Please retry."); }
    if (!Array.isArray(rows) || rows.length === 0) break;
    oldestPage = rows;
    if (rows.length < MINT_CREATOR_PAGE) break;
    before = rows[rows.length - 1].signature;
  }
  const first = [...oldestPage].reverse().find((row) => row && !row.err && row.signature);
  if (!first) return { creator: null, reason: "mint_creator_unavailable" };
  // Negative results are not cached: a lagging RPC must not pin a mint to manual review.
  let tx;
  try { tx = await connection.getParsedTransaction(first.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); }
  catch { throw rpcError("Solana mint-history lookup is temporarily unavailable. Please retry."); }
  if (!tx) throw rpcError("Solana mint-history lookup is temporarily unavailable. Please retry.");
  const creator = mintCreatorFromParsedTransaction(tx, mintAddress);
  if (!creator) return { creator: null, reason: "mint_creator_unverified" };
  return remember(mintAddress, { creator, signature: first.signature, slot: tx.slot ?? first.slot ?? null, blockTime: tx.blockTime ?? first.blockTime ?? null });
}

function remember(mint, result) {
  if (mintCreatorCache.size >= MINT_CREATOR_CACHE_MAX) mintCreatorCache.delete(mintCreatorCache.keys().next().value);
  mintCreatorCache.set(mint, result);
  return result;
}

export function clearMintCreatorCacheForTest() { mintCreatorCache.clear(); }
