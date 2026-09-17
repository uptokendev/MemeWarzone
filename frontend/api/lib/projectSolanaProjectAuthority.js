import { PublicKey } from "@solana/web3.js";
import { readPumpImportEvidence } from "./projectImportPumpEvidence.js";

// Pump's published IDL: BondingCurve = discriminator + 5*u64 + bool + creator.
// The account is derived for the requested mint; no token suffix, holder list,
// transaction fee payer or off-chain metadata is accepted as ownership proof.
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const ZERO = new PublicKey("11111111111111111111111111111111");

function unavailable(reason, evidenceAccount = null) {
  return { currentAuthority: null, authoritySource: null, authorityEvidenceAccount: evidenceAccount, ownershipReason: reason };
}
function rpcError(message) {
  return Object.assign(new Error(message), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
}
export async function assertSolanaImportMainnet(connection) {
  if (typeof connection?.getGenesisHash !== "function") throw rpcError("Solana network verification is unavailable. Please retry.");
  let genesis;
  try { genesis = await connection.getGenesisHash(); }
  catch { throw rpcError("Solana network verification is temporarily unavailable. Please retry."); }
  if (genesis !== SOLANA_MAINNET_GENESIS) {
    throw Object.assign(new Error("The import service is connected to the wrong Solana network. Solana mainnet is required."), { code: "PROJECT_IMPORT_CHAIN_MISMATCH" });
  }
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
export async function resolveSolanaProjectAuthority({ connection, mint, mintAuthority, claimant = null, tokenProgram = null }) {
  const curve = pumpBondingCurveAddress(mint);
  if (typeof connection?.getAccountInfo !== "function") throw rpcError("Solana project-wallet lookup is unavailable. Please retry.");
  let account;
  try { account = await connection.getAccountInfo(curve, "confirmed"); }
  catch { throw rpcError("Solana project-wallet lookup is temporarily unavailable. Please retry."); }
  if (account) {
    const projectAuthorityEvidence = await readPumpImportEvidence({ connection, mint, curveAccount: account, claimant, tokenProgram });
    const context = { projectAuthorityEvidence, market: projectAuthorityEvidence.market, custody: projectAuthorityEvidence.custody };
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
  if (mintAuthority) {
    const authority = new PublicKey(mintAuthority);
    if (!authority.equals(ZERO) && PublicKey.isOnCurve(authority.toBytes())) {
      return { currentAuthority: authority.toBase58(), authoritySource: "mint_authority", authorityEvidenceAccount: new PublicKey(mint).toBase58(), ownershipReason: "mint_authority_resolved", market: { phase: "unknown", verified: false, reason: "launch_platform_unverified" } };
    }
  }
  return { ...unavailable("project_authority_unavailable"), market: { phase: "unknown", verified: false, reason: "launch_platform_unverified" } };
}
