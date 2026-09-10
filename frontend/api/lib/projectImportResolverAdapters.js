import { JsonRpcProvider, FetchRequest } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { resolveProjectOwnershipBnb } from "./projectOwnershipResolveBnb.js";
import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";
import { assertSolanaImportMainnet, resolveSolanaProjectAuthority } from "./projectSolanaProjectAuthority.js";
import { readBnbImportMarket } from "./projectImportBnbMarket.js";
import { registerProjectImportResolver } from "./projectImportResolvers.js";

const BNB_CHAIN_ID = 56;
const SOLANA_CHAIN_ID = 101;
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
let bnbProvider = null;
let solanaConnection = null;

function bnbRpcUrl() { return String(process.env.BNB_RPC_URL || process.env.BSC_RPC_URL || process.env.BSC_MAINNET_RPC_URL || "").trim(); }
function solanaRpcUrl() { return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL || "").trim(); }
function getBnbProvider() {
  if (bnbProvider) return bnbProvider;
  const url = bnbRpcUrl();
  if (!url) throw Object.assign(new Error("BNB project import resolver is not configured"), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
  const request = new FetchRequest(url);
  request.timeout = 7000;
  bnbProvider = new JsonRpcProvider(request, BNB_CHAIN_ID, { batchMaxCount: 1 });
  return bnbProvider;
}
function getSolanaConnection() {
  if (solanaConnection) return solanaConnection;
  const url = solanaRpcUrl();
  if (!url) throw Object.assign(new Error("Solana project import resolver is not configured"), { code: "PROJECT_IMPORT_RPC_UNAVAILABLE" });
  solanaConnection = new Connection(url, {commitment:"confirmed",disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)})});
  return solanaConnection;
}

export function setProjectImportReadClientsForTest({ bnb = null, solana = null } = {}) {
  bnbProvider = bnb;
  solanaConnection = solana;
}

export async function resolveBnbProjectImport({ chainId, tokenAddress, signedWallet }) {
  const provider = getBnbProvider();
  const raw = await resolveProjectOwnershipBnb({
    provider,
    chainId,
    contractAddress: tokenAddress,
    signedConnectedWallet: signedWallet,
  });
  if (!raw?.ok) throw Object.assign(new Error(raw?.error || "BNB token resolution failed"), { code: raw?.errorCode || "PROJECT_IMPORT_RESOLVE_FAILED" });
  const marketEvidence = await readBnbImportMarket({ provider, tokenAddress: raw.contractAddress });
  return {
    ...marketEvidence,
    chainId: BNB_CHAIN_ID,
    tokenAddress: raw.contractAddress,
    name: raw.token?.name ?? null,
    symbol: raw.token?.symbol ?? null,
    decimals: raw.token?.decimals ?? null,
    totalSupply: raw.token?.totalSupply ?? null,
    metadataSource: "erc20_contract",
    metadataType: "erc20_readonly",
    automaticOwnershipAvailable: raw.ownership?.automaticOwnershipVerification !== "unavailable" && Boolean(raw.ownership?.currentOwner),
    currentAuthority: raw.ownership?.currentOwner ?? null,
    signedWalletMatchesAuthority: Boolean(raw.ownership?.automaticOwnershipVerified),
  };
}

function readMetadataString(data, offset, maxBytes) {
  if (offset + 4 > data.length) throw new Error("metadata string length missing");
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length > maxBytes || end > data.length) throw new Error("metadata string invalid");
  return { value: data.subarray(start, end).toString("utf8").replace(/\0/g, "").trim(), next: end };
}

function emptySolanaMetadata() {
  return { name: null, symbol: null, source: null, type: null };
}

async function resolveMetaplexMetadata(connection, mintKey) {
  try {
    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID,
    );
    const account = await connection.getAccountInfo(metadataAddress, "confirmed");
    if (!account?.data || !account.owner?.equals?.(TOKEN_METADATA_PROGRAM_ID)) return null;
    const data = Buffer.from(account.data);
    if (data.length < 65) return null;
    const name = readMetadataString(data, 65, 256);
    const symbol = readMetadataString(data, name.next, 64);
    const cleanName = name.value || null;
    const cleanSymbol = symbol.value || null;
    if (!cleanName && !cleanSymbol) return null;
    return { name: cleanName, symbol: cleanSymbol, source: "metaplex", type: "token_metadata_pda" };
  } catch {
    return null;
  }
}

async function resolveToken2022Metadata(connection, mintKey) {
  try {
    const mintAccount = await connection.getAccountInfo(mintKey, "confirmed");
    if (!mintAccount?.owner?.equals?.(TOKEN_2022_PROGRAM_ID)) return null;
    const metadata = await getTokenMetadata(connection, mintKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    const name = String(metadata?.name || "").replace(/\0/g, "").trim().slice(0, 256) || null;
    const symbol = String(metadata?.symbol || "").replace(/\0/g, "").trim().slice(0, 64) || null;
    if (!name && !symbol) return null;
    return { name, symbol, source: "token_2022", type: "metadata_extension" };
  } catch {
    return null;
  }
}

export async function resolveSolanaDisplayMetadata(connection, mint) {
  let mintKey;
  try { mintKey = mint instanceof PublicKey ? mint : new PublicKey(String(mint)); }
  catch { return emptySolanaMetadata(); }

  const metaplex = await resolveMetaplexMetadata(connection, mintKey);
  if (metaplex) return metaplex;

  const token2022 = await resolveToken2022Metadata(connection, mintKey);
  return token2022 || emptySolanaMetadata();
}

export async function resolveSolanaProjectImport({ chainId, tokenAddress, signedWallet }) {
  if (Number(chainId) !== SOLANA_CHAIN_ID) throw Object.assign(new Error("Solana project import resolver only supports chain 101"), { code: "UNSUPPORTED_CHAIN" });
  const connection = getSolanaConnection();
  await assertSolanaImportMainnet(connection);
  const raw = await resolveProjectOwnershipSolana({ mint: tokenAddress, connectedWallet: signedWallet, connection });
  if (!raw?.validMint) throw Object.assign(new Error(raw?.reason === "mint_lookup_failed" ? "Solana token lookup is temporarily unavailable." : "No valid Solana token was found. Check the Contract Address and selected chain."), { code: raw?.reason === "mint_lookup_failed" ? "PROJECT_IMPORT_RPC_UNAVAILABLE" : "SOLANA_MINT_INVALID" });
  const authority = await resolveSolanaProjectAuthority({ connection, mint: raw.mint, mintAuthority: raw.mintAuthority, claimant: new PublicKey(signedWallet).toBase58(), tokenProgram: new PublicKey(raw.tokenProgramId) });
  const metadata = await resolveSolanaDisplayMetadata(connection, raw.mint);
  return {
    chainId: SOLANA_CHAIN_ID,
    tokenAddress: raw.mint,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: raw.decimals,
    totalSupply: raw.totalSupply,
    metadataSource: metadata.source,
    metadataType: metadata.type,
    automaticOwnershipAvailable: Boolean(authority.currentAuthority),
    ...authority,
    mintAuthority: raw.mintAuthority ?? null,
    observedSlot: raw.observedSlot ?? null,
    signedWalletMatchesAuthority: Boolean(authority.currentAuthority && authority.currentAuthority === new PublicKey(signedWallet).toBase58()),
  };
}

export function registerDefaultProjectImportResolvers() {
  registerProjectImportResolver(BNB_CHAIN_ID, resolveBnbProjectImport);
  registerProjectImportResolver(SOLANA_CHAIN_ID, resolveSolanaProjectImport);
}
