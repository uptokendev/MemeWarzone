import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const SPL_TOKEN_PROGRAM_IDS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

function emptyResult(reason) {
  return { validMint: false, decimals: null, totalSupply: null, mintAuthority: null, verified: false, automaticVerificationAvailable: false, reason };
}

function canonicalAddress(value) { return new PublicKey(String(value || "").trim()).toBase58(); }

export async function resolveProjectOwnershipSolana({ mint, connectedWallet, connection }) {
  if (!connection || typeof connection.getParsedAccountInfo !== "function") throw new TypeError("A Solana read connection with getParsedAccountInfo is required.");
  let mintAddress;
  let walletAddress;
  try { mintAddress = canonicalAddress(mint); walletAddress = canonicalAddress(connectedWallet); }
  catch { return emptyResult("invalid_address"); }
  let response;
  try { response = await connection.getParsedAccountInfo(new PublicKey(mintAddress), "confirmed"); }
  catch { return emptyResult("mint_lookup_failed"); }
  const account = response?.value;
  if (!account) return emptyResult("mint_not_found");
  const owner = account.owner?.toBase58?.() || String(account.owner || "");
  if (!SPL_TOKEN_PROGRAM_IDS.has(owner)) return emptyResult("not_spl_token_mint");
  const parsed = account.data?.parsed;
  const info = parsed?.info;
  if (parsed?.type !== "mint" || !info) return emptyResult("invalid_mint_account");
  const decimals = Number(info.decimals);
  const supply = String(info.supply ?? "");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+$/.test(supply)) return emptyResult("invalid_mint_data");
  let mintAuthority = null;
  if (info.mintAuthority !== null && info.mintAuthority !== undefined) {
    try { mintAuthority = canonicalAddress(info.mintAuthority); }
    catch { return emptyResult("invalid_mint_authority"); }
  }
  const automaticVerificationAvailable = mintAuthority !== null;
  const verified = automaticVerificationAvailable && walletAddress === mintAuthority;
  return {
    validMint: true,
    mint: mintAddress,
    decimals,
    totalSupply: supply,
    mintAuthority,
    verified,
    automaticVerificationAvailable,
    reason: !automaticVerificationAvailable ? "mint_authority_unavailable" : verified ? "mint_authority_match" : "mint_authority_mismatch",
  };
}
