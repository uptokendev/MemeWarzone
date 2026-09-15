import fs from "node:fs";
import { CpAmm, derivePositionNftAccount, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Pool } from "pg";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".slice(0, 43));
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const SOLANA_CHAIN_ID = 101;
const CREATOR_FEE_BPS = 8000;
const PROTOCOL_FEE_BPS = 2000;
const BPS = 10_000;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function solanaRpcUrl(): string {
  return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com").trim();
}

export type ProtocolTreasuryResolution = {
  configured: boolean;
  invalid: boolean;
  address: PublicKey | null;
  reason: "missing" | "malformed" | "same_as_operator" | null;
};

export function resolveProtocolTreasury(operator: PublicKey | null = null): ProtocolTreasuryResolution {
  const raw = String(process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS || "").trim();
  if (!raw) return { configured: false, invalid: false, address: null, reason: "missing" };
  let address: PublicKey;
  try {
    address = new PublicKey(raw);
  } catch {
    return { configured: true, invalid: true, address: null, reason: "malformed" };
  }
  if (operator && address.equals(operator)) return { configured: true, invalid: true, address: null, reason: "same_as_operator" };
  return { configured: true, invalid: false, address, reason: null };
}

function requireProtocolTreasury(operator: PublicKey): PublicKey {
  const resolved = resolveProtocolTreasury(operator);
  if (!resolved.configured) throw Object.assign(new Error("Solana LP protocol treasury is not configured. Set explicit SOLANA_PROTOCOL_TREASURY_ADDRESS before harvest; Vote Treasury and harvest-operator fallbacks are forbidden."), { status: 503 });
  if (resolved.reason === "malformed") throw Object.assign(new Error("SOLANA_PROTOCOL_TREASURY_ADDRESS is not a valid Solana public key."), { status: 503 });
  if (resolved.reason === "same_as_operator") throw Object.assign(new Error("SOLANA_PROTOCOL_TREASURY_ADDRESS must be distinct from the Solana harvest signing operator."), { status: 503 });
  if (!resolved.address) throw Object.assign(new Error("Solana LP protocol treasury failed closed."), { status: 503 });
  return resolved.address;
}

function tokenProgramFromFlag(flag: unknown): PublicKey {
  return Number(flag ?? 0) === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: deriveAta(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferTokenIx(source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  try {
    const res = await connection.getTokenAccountBalance(account);
    return BigInt(res.value.amount || "0");
  } catch {
    return 0n;
  }
}

async function requiredTokenBalance(connection: Connection, account: PublicKey, label: string): Promise<bigint> {
  try {
    const res = await connection.getTokenAccountBalance(account, "confirmed");
    return BigInt(res.value.amount || "0");
  } catch (error: any) {
    throw Object.assign(new Error(`${label} token balance unavailable: ${String(error?.message || error)}`), { status: 500 });
  }
}

export function settlementModeForMint(mint: PublicKey | string): "native-sol" | "spl-token" {
  const pk = mint instanceof PublicKey ? mint : new PublicKey(mint);
  return pk.equals(NATIVE_MINT) ? "native-sol" : "spl-token";
}

export function splitAmounts(total: bigint): { creator: bigint; protocol: bigint } {
  if (total <= 0n) return { creator: 0n, protocol: 0n };
  const creator = (total * BigInt(CREATOR_FEE_BPS)) / BigInt(BPS);
  return { creator, protocol: total - creator };
}

export function grossClaimFromVaultMovement(input: {
  before: bigint;
  after: bigint;
  expectedClaimable: bigint;
  label?: string;
}): bigint {
  const label = input.label || "Meteora fee vault";
  if (input.before < 0n || input.after < 0n || input.expectedClaimable < 0n) throw new Error(`${label} evidence contains a negative amount`);
  if (input.after > input.before) throw new Error(`${label} increased during claim; authoritative gross claim is ambiguous`);
  const gross = input.before - input.after;
  if (gross !== input.expectedClaimable) {
    throw new Error(`${label} movement mismatch expected=${input.expectedClaimable} actual=${gross}`);
  }
  return gross;
}

export function grossClaimPairFromVaultMovement(input: {
  beforeA: bigint;
  afterA: bigint;
  expectedA: bigint;
  beforeB: bigint;
  afterB: bigint;
  expectedB: bigint;
}): { tokenA: bigint; tokenB: bigint } {
  return {
    tokenA: grossClaimFromVaultMovement({ before: input.beforeA, after: input.afterA, expectedClaimable: input.expectedA, label: "Meteora token A fee vault" }),
    tokenB: grossClaimFromVaultMovement({ before: input.beforeB, after: input.afterB, expectedClaimable: input.expectedB, label: "Meteora token B fee vault" }),
  };
}

function unclaimedFees(poolState: unknown, positionState: unknown): { tokenA: bigint; tokenB: bigint } {
  try {
    const fees = getUnClaimLpFee(poolState as any, positionState as any);
    return { tokenA: toBigInt(fees.feeTokenA), tokenB: toBigInt(fees.feeTokenB) };
  } catch {
    return { tokenA: toBigInt((positionState as any)?.feeAPending), tokenB: toBigInt((positionState as any)?.feeBPending) };
  }
}

async function resolvePositionNftAccount(connection: Connection, owner: PublicKey, nftMint: PublicKey): Promise<PublicKey> {
  const pda = derivePositionNftAccount(nftMint);
  const pdaInfo = await connection.getAccountInfo(pda, "confirmed");
  if (pdaInfo) return pda;
  const token2022 = deriveAta(owner, nftMint, TOKEN_2022_PROGRAM_ID);
  const classic = deriveAta(owner, nftMint, TOKEN_PROGRAM_ID);
  const [info22, infoClassic] = await Promise.all([connection.getAccountInfo(token2022, "confirmed"), connection.getAccountInfo(classic, "confirmed")]);
  if (info22) return token2022;
  if (infoClassic) return classic;
  return pda;
}

async function sendServerV0Instructions(connection: Connection, instructions: TransactionInstruction[], operator: Keypair, label: string): Promise<string> {
  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: operator.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([operator]);
    return { transaction, latest };
  };
  try {
    const simulated = await compile();
    const simulation = await connection.simulateTransaction(simulated.transaction, { commitment: "confirmed", sigVerify: true, replaceRecentBlockhash: false });
    if (simulation.value.err) {
      const logs = simulation.value.logs?.slice(-12).join(" | ") || "";
      throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? ` | ${logs}` : ""}`);
    }
    const final = await compile();
    const signature = await connection.sendRawTransaction(final.transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, ...final.latest }, "confirmed");
    if (confirmation.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    return signature;
  } catch (error: any) {
    let logs = "";
    try {
      if (typeof error?.getLogs === "function") {
        const fetched = await error.getLogs(connection);
        logs = Array.isArray(fetched) ? fetched.join(" | ") : String(fetched || "");
      } else if (Array.isArray(error?.logs)) logs = error.logs.join(" | ");
    } catch {}
    throw Object.assign(new Error(logs ? `${label} failed: ${String(error?.message || error)} | ${logs}` : `${label} failed: ${String(error?.message || error)}`), { status: 500 });
  }
}

async function sendClaimTransaction(connection: Connection, transaction: Transaction, operator: Keypair): Promise<string> {
  const instructions = Array.from(transaction.instructions || []);
  if (!instructions.length) throw Object.assign(new Error("Meteora claim transaction contained no instructions."), { status: 500 });
  return sendServerV0Instructions(connection, instructions, operator, "Meteora claim");
}

function txAccountKeys(tx: any): PublicKey[] {
  const message = tx?.transaction?.message;
  const staticKeys = Array.from(message?.staticAccountKeys || message?.accountKeys || []).map((x: any) => x instanceof PublicKey ? x : new PublicKey(String(x)));
  const loaded = tx?.meta?.loadedAddresses || {};
  const writable = Array.from(loaded.writable || []).map((x: any) => x instanceof PublicKey ? x : new PublicKey(String(x)));
  const readonly = Array.from(loaded.readonly || []).map((x: any) => x instanceof PublicKey ? x : new PublicKey(String(x)));
  return [...staticKeys, ...writable, ...readonly];
}

function tokenAmountAt(tx: any, accountIndex: number, side: "pre" | "post"): bigint | null {
  const rows = side === "pre" ? tx?.meta?.preTokenBalances : tx?.meta?.postTokenBalances;
  const found = Array.isArray(rows) ? rows.find((x: any) => Number(x.accountIndex) === accountIndex) : null;
  if (!found?.uiTokenAmount?.amount) return null;
  return BigInt(String(found.uiTokenAmount.amount));
}

function verifyVaultMovementInClaimTransaction(tx: any, vault: PublicKey, expectedGross: bigint, label: string): void {
  const keys = txAccountKeys(tx);
  const index = keys.findIndex((key) => key.equals(vault));
  if (index < 0) throw new Error(`${label} missing from confirmed claim transaction account keys`);
  const pre = tokenAmountAt(tx, index, "pre");
  const post = tokenAmountAt(tx, index, "post");
  if (pre === null || post === null) throw new Error(`${label} missing token-balance evidence in confirmed claim transaction`);
  const observed = grossClaimFromVaultMovement({ before: pre, after: post, expectedClaimable: expectedGross, label: `${label} transaction` });
  if (observed !== expectedGross) throw new Error(`${label} transaction movement mismatch`);
}

function mintDecimals(mint: PublicKey, tokenMint: PublicKey, tokenDecimals: number): number {
  if (mint.equals(NATIVE_MINT)) return 9;
  if (mint.equals(tokenMint)) return tokenDecimals;
  return 6;
}

function operatorSecretCandidates(): string[] {
  return [process.env.SOLANA_HARVEST_OPERATOR_SECRET, process.env.SOLANA_TREASURY_OPERATOR_SECRET, process.env.SOLANA_OPERATOR_SECRET, process.env.SOLANA_OPERATOR_KEYPAIR, process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR]
    .map((value) => String(value || "").trim()).filter(Boolean);
}

function decodeBase58(raw: string): Uint8Array {
  const bytes = [0];
  for (const ch of raw) {
    const val = BASE58_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error("invalid base58");
    let carry = val;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const ch of raw) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function keypairFromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`secret length must be 32 or 64 bytes, got ${bytes.length}`);
}

function parseSecretMaterial(raw: string): Keypair | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const looksLikePath = trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.endsWith(".json") || trimmed.includes("\\");
  if (looksLikePath) {
    try {
      const filePath = trimmed.startsWith("~") ? trimmed.replace(/^~(?=$|[/\\])/, process.env.HOME || "") : trimmed;
      if (fs.existsSync(filePath)) return parseSecretMaterial(fs.readFileSync(filePath, "utf8"));
    } catch {}
  }
  try {
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) return null;
      return keypairFromBytes(Uint8Array.from(arr));
    }
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) return keypairFromBytes(Uint8Array.from(Buffer.from(trimmed, "hex")));
    return keypairFromBytes(decodeBase58(trimmed));
  } catch {
    return null;
  }
}

function parseOperatorKey(): { keypair: Keypair | null; configured: boolean; invalid: boolean } {
  const candidates = operatorSecretCandidates();
  if (!candidates.length) return { keypair: null, configured: false, invalid: false };
  for (const raw of candidates) {
    const keypair = parseSecretMaterial(raw);
    if (keypair) return { keypair, configured: true, invalid: false };
  }
  return { keypair: null, configured: true, invalid: true };
}

export function solanaHarvestStatus() {
  const parsed = parseOperatorKey();
  const treasury = resolveProtocolTreasury(parsed.keypair?.publicKey || null);
  return {
    ok: true,
    chainId: SOLANA_CHAIN_ID,
    operatorConfigured: Boolean(parsed.keypair),
    operatorInvalid: parsed.invalid,
    operatorAddress: parsed.keypair ? parsed.keypair.publicKey.toBase58() : null,
    protocolTreasuryConfigured: treasury.configured,
    protocolTreasuryInvalid: treasury.invalid,
    protocolTreasury: treasury.address ? treasury.address.toBase58() : null,
    note: parsed.keypair
      ? treasury.invalid || !treasury.configured
        ? "Indexer signing operator is configured, but LP protocol treasury is not safely configured. Harvest remains fail-closed."
        : "Indexer can sign Meteora fee claims and an explicit distinct LP protocol treasury is configured."
      : parsed.invalid
        ? "Operator secret is set but could not be parsed."
        : "Set SOLANA_HARVEST_OPERATOR_SECRET on the realtime-indexer; protocol revenue separately requires SOLANA_PROTOCOL_TREASURY_ADDRESS.",
  };
}

function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (value && typeof value === "object" && "toString" in value) return BigInt(String(value.toString()));
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function formatAmount(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const scale = 10n ** BigInt(Math.max(0, decimals));
  const whole = raw / scale;
  const frac = raw % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export async function listSolanaLpFees(input: { pool: Pool; creator?: string | null; campaign?: string | null; limit: number }) {
  const params: unknown[] = [SOLANA_CHAIN_ID];
  const clauses = ["c.chain_id = $1", "c.graduated_at_chain is not null", "coalesce(c.meta #>> '{solanaGraduation,pool}','') <> ''"];
  if (input.campaign) {
    params.push(input.campaign);
    clauses.push(`(c.campaign_address = $${params.length} or c.token_address = $${params.length} or lower(c.campaign_address) = lower($${params.length}))`);
  }
  if (input.creator) {
    params.push(input.creator);
    clauses.push(`c.creator_address = $${params.length}`);
  }
  params.push(input.limit);
  const { rows } = await input.pool.query(
    `select c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol, c.graduated_at_chain, c.meta
       from public.campaigns c where ${clauses.join(" and ")} order by c.graduated_at_chain desc nulls last limit $${params.length}`,
    params,
  );
  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const cpAmm = new CpAmm(connection as any);
  const items = [];
  for (const row of rows) {
    const meta = row.meta?.solanaGraduation || {};
    const poolAddress = String(meta.pool || "").trim();
    const positionAddress = String(meta.position || "").trim();
    const base = {
      chainId: SOLANA_CHAIN_ID,
      campaignAddress: String(row.campaign_address || ""),
      tokenAddress: row.token_address ? String(row.token_address) : null,
      creatorAddress: row.creator_address ? String(row.creator_address) : null,
      name: row.name || null,
      symbol: row.symbol || null,
      graduatedAt: row.graduated_at_chain || null,
      marketStage: "GRADUATED",
      pairAddress: poolAddress || null,
    };
    if (!poolAddress || !positionAddress) {
      items.push({ ...base, fees: { registered: false, note: "Missing Meteora pool/position on campaign meta." } });
      continue;
    }
    try {
      const position = await cpAmm.fetchPositionState(new PublicKey(positionAddress));
      const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
      const claimed = unclaimedFees(poolState, position);
      const mintA = poolState.tokenAMint;
      const mintB = poolState.tokenBMint;
      const tokenMint = String(row.token_address || "");
      const decA = mintDecimals(mintA, tokenMint ? new PublicKey(tokenMint) : mintA, 6);
      const decB = mintDecimals(mintB, tokenMint ? new PublicKey(tokenMint) : mintB, 6);
      const symA = mintA.equals(NATIVE_MINT) ? "SOL" : (row.symbol || "TOKEN");
      const symB = mintB.equals(NATIVE_MINT) ? "SOL" : (row.symbol || "TOKEN");
      const splitA = splitAmounts(claimed.tokenA);
      const splitB = splitAmounts(claimed.tokenB);
      const harvested = row.meta?.solanaGraduation?.harvest || {};
      items.push({
        ...base,
        fees: {
          registered: true,
          pairLabel: "Meteora DAMM v2",
          token0Meta: { symbol: symA },
          token1Meta: { symbol: symB },
          unharvested: {
            token0: Number(formatAmount(claimed.tokenA, decA)),
            token1: Number(formatAmount(claimed.tokenB, decB)),
            token0Display: formatAmount(claimed.tokenA, decA),
            token1Display: formatAmount(claimed.tokenB, decB),
            token0Symbol: symA,
            token1Symbol: symB,
            creatorShareToken0Display: formatAmount(splitA.creator, decA),
            creatorShareToken1Display: formatAmount(splitB.creator, decB),
            protocolShareToken0Display: formatAmount(splitA.protocol, decA),
            protocolShareToken1Display: formatAmount(splitB.protocol, decB),
            source: "meteora_unclaimed_lp_fee",
            note: "Includes pending + uncheckpointed pool fees. 80% creator / 20% protocol on collect. Principal stays locked.",
          },
          harvestedLifetime: harvested.lastTx ? {
            lastTx: harvested.lastTx,
            lastAt: harvested.lastAt || null,
            creatorToken0Display: harvested.creatorADisplay || null,
            creatorToken1Display: harvested.creatorBDisplay || null,
            protocolToken0Display: harvested.protocolADisplay || null,
            protocolToken1Display: harvested.protocolBDisplay || null,
          } : undefined,
        },
      });
    } catch (error: any) {
      items.push({ ...base, fees: { registered: true, pairLabel: "Meteora DAMM v2", error: String(error?.message || error) } });
    }
  }
  const parsed = parseOperatorKey();
  const treasury = resolveProtocolTreasury(parsed.keypair?.publicKey || null);
  return {
    ok: true,
    chainId: SOLANA_CHAIN_ID,
    service: "realtime-indexer",
    lockerAddress: null,
    treasuryRouter: null,
    protocolTreasuryConfigured: treasury.configured,
    protocolTreasuryInvalid: treasury.invalid,
    protocolTreasury: treasury.address ? treasury.address.toBase58() : null,
    split: { creatorBps: CREATOR_FEE_BPS, protocolBps: PROTOCOL_FEE_BPS },
    notes: [
      "Solana LP fees accrue on the permanently locked DAMM v2 position.",
      "There is no EVM TreasuryRouter. LP protocol revenue requires explicit SOLANA_PROTOCOL_TREASURY_ADDRESS.",
      "Harvest gross amount is authoritative Meteora source-vault movement; transaction fees are operator costs and never reduce the 80/20 entitlement.",
    ],
    items,
    updatedAt: new Date().toISOString(),
  };
}

export function buildZeroFeeRetryResult(input: { campaignAddress: string; pairAddress: string; creatorAddress: string; protocolTreasury: PublicKey; priorHarvest?: Record<string, unknown> | null }) {
  const priorHarvest = input.priorHarvest || {};
  return {
    ok: true,
    chainId: SOLANA_CHAIN_ID,
    campaignAddress: input.campaignAddress,
    pairAddress: input.pairAddress,
    creatorAddress: input.creatorAddress,
    protocolTreasury: input.protocolTreasury.toBase58(),
    split: { creatorBps: CREATOR_FEE_BPS, protocolBps: PROTOCOL_FEE_BPS },
    claimed: { tokenA: "0", tokenB: "0", creatorA: "0", creatorB: "0", protocolA: "0", protocolB: "0" },
    grossClaimRaw: { tokenA: "0", tokenB: "0" },
    txHash: typeof priorHarvest.lastTx === "string" ? priorHarvest.lastTx : null,
    claimTx: null,
    splitTx: null,
    retryNoop: true,
    note: "No unclaimed Meteora fees on this position. Existing settled harvest reconciliation was preserved.",
  };
}

export async function harvestSolanaLpFees(input: { pool: Pool; campaign?: string | null; pair?: string | null }) {
  const parsed = parseOperatorKey();
  if (!parsed.keypair) {
    throw Object.assign(new Error(parsed.invalid
      ? "Solana harvest operator key is set but could not be parsed. Use a JSON byte array, Phantom base58 secret, hex seed, or a keypair file path in SOLANA_HARVEST_OPERATOR_SECRET / SOLANA_OPERATOR_SECRET / SOLANA_OPERATOR_KEYPAIR on the realtime-indexer — not the web-dashboard. SOLANA_ROUTE_SIGNER_SECRET_KEY is a different wallet and is ignored."
      : "Solana harvest operator key is not configured on the realtime-indexer. Set SOLANA_HARVEST_OPERATOR_SECRET (or SOLANA_OPERATOR_SECRET / SOLANA_OPERATOR_KEYPAIR) on the indexer service — not the web-dashboard. SOLANA_ROUTE_SIGNER_SECRET_KEY is a different wallet and is ignored."), { status: 503 });
  }
  const operator = parsed.keypair;
  const treasury = requireProtocolTreasury(operator.publicKey);
  const clauses = ["c.chain_id = $1", "c.graduated_at_chain is not null"];
  const params: unknown[] = [SOLANA_CHAIN_ID];
  if (input.campaign) {
    params.push(input.campaign);
    clauses.push(`(c.campaign_address = $${params.length} or c.token_address = $${params.length} or lower(c.campaign_address) = lower($${params.length}))`);
  }
  if (input.pair) {
    params.push(input.pair);
    clauses.push(`c.meta #>> '{solanaGraduation,pool}' = $${params.length}`);
  }
  const { rows } = await input.pool.query(`select c.campaign_address, c.token_address, c.creator_address, c.meta from public.campaigns c where ${clauses.join(" and ")} limit 1`, params);
  const row = rows[0];
  if (!row) throw Object.assign(new Error("Graduated Solana campaign with a Meteora pool was not found."), { status: 404 });
  const meta = row.meta?.solanaGraduation || {};
  const poolAddress = String(meta.pool || "").trim();
  const positionAddress = String(meta.position || "").trim();
  const mint = String(row.token_address || "").trim();
  const creator = String(row.creator_address || "").trim();
  if (!poolAddress || !positionAddress || !mint || !creator) throw Object.assign(new Error("Campaign is missing Meteora pool, position, mint, or creator."), { status: 400 });

  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const cpAmm = new CpAmm(connection as any);
  const poolPk = new PublicKey(poolAddress);
  const positionPk = new PublicKey(positionAddress);
  const tokenMint = new PublicKey(mint);
  const creatorPk = new PublicKey(creator);
  const poolState = await cpAmm.fetchPoolState(poolPk);
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;
  const tokenAProgram = tokenProgramFromFlag((poolState as any).tokenAFlag);
  const tokenBProgram = tokenProgramFromFlag((poolState as any).tokenBFlag);
  const positionState = await cpAmm.fetchPositionState(positionPk);
  const positionNftMint = (positionState as any).nftMint || (positionState as any).nft_mint;
  if (!positionNftMint) throw Object.assign(new Error("Meteora position is missing its NFT mint."), { status: 400 });
  const nftMint = positionNftMint instanceof PublicKey ? positionNftMint : new PublicKey(String(positionNftMint));
  const positionNftAccount = await resolvePositionNftAccount(connection, operator.publicKey, nftMint);
  const pendingBefore = unclaimedFees(poolState, positionState);
  if (pendingBefore.tokenA <= 0n && pendingBefore.tokenB <= 0n) {
    return buildZeroFeeRetryResult({ campaignAddress: String(row.campaign_address), pairAddress: poolAddress, creatorAddress: creator, protocolTreasury: treasury, priorHarvest: meta.harvest || {} });
  }

  const vaultA = poolState.tokenAVault;
  const vaultB = poolState.tokenBVault;
  const [vaultBeforeA, vaultBeforeB] = await Promise.all([
    requiredTokenBalance(connection, vaultA, "Meteora token A fee source vault"),
    requiredTokenBalance(connection, vaultB, "Meteora token B fee source vault"),
  ]);

  const operatorAtaA = deriveAta(operator.publicKey, tokenAMint, tokenAProgram);
  const operatorAtaB = deriveAta(operator.publicKey, tokenBMint, tokenBProgram);
  const claimTx = await cpAmm.claimPositionFee({
    owner: operator.publicKey,
    position: positionPk,
    pool: poolPk,
    positionNftAccount,
    tokenAMint,
    tokenBMint,
    tokenAVault: vaultA,
    tokenBVault: vaultB,
    tokenAProgram,
    tokenBProgram,
    feePayer: operator.publicKey,
  });
  const claimTransaction = claimTx as unknown as Transaction;
  if (!claimTransaction || !Array.isArray(claimTransaction.instructions)) throw Object.assign(new Error("Meteora claimPositionFee did not return a transaction."), { status: 500 });
  const claimSignature = await sendClaimTransaction(connection, claimTransaction, operator);

  const [vaultAfterA, vaultAfterB] = await Promise.all([
    requiredTokenBalance(connection, vaultA, "Meteora token A fee source vault"),
    requiredTokenBalance(connection, vaultB, "Meteora token B fee source vault"),
  ]);
  const gross = grossClaimPairFromVaultMovement({
    beforeA: vaultBeforeA,
    afterA: vaultAfterA,
    expectedA: pendingBefore.tokenA,
    beforeB: vaultBeforeB,
    afterB: vaultAfterB,
    expectedB: pendingBefore.tokenB,
  });

  const confirmedClaim = await connection.getTransaction(claimSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!confirmedClaim || confirmedClaim.meta?.err) throw Object.assign(new Error("Confirmed Meteora claim transaction is missing or failed."), { status: 500 });
  verifyVaultMovementInClaimTransaction(confirmedClaim, vaultA, gross.tokenA, "Meteora token A fee source vault");
  verifyVaultMovementInClaimTransaction(confirmedClaim, vaultB, gross.tokenB, "Meteora token B fee source vault");

  const splitA = splitAmounts(gross.tokenA);
  const splitB = splitAmounts(gross.tokenB);
  const decA = mintDecimals(tokenAMint, tokenMint, 6);
  const decB = mintDecimals(tokenBMint, tokenMint, 6);

  const splitIxs: TransactionInstruction[] = [];
  const addSplit = (splitMint: PublicKey, sourceAta: PublicKey, split: { creator: bigint; protocol: bigint }, tokenProgram: PublicKey) => {
    const native = splitMint.equals(NATIVE_MINT);
    if (split.creator > 0n && !creatorPk.equals(operator.publicKey)) {
      if (native) splitIxs.push(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: creatorPk, lamports: split.creator }));
      else {
        splitIxs.push(createAtaIdempotentIx(operator.publicKey, creatorPk, splitMint, tokenProgram));
        splitIxs.push(transferTokenIx(sourceAta, deriveAta(creatorPk, splitMint, tokenProgram), operator.publicKey, split.creator, tokenProgram));
      }
    }
    if (split.protocol > 0n) {
      if (native) splitIxs.push(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: treasury, lamports: split.protocol }));
      else {
        splitIxs.push(createAtaIdempotentIx(operator.publicKey, treasury, splitMint, tokenProgram));
        splitIxs.push(transferTokenIx(sourceAta, deriveAta(treasury, splitMint, tokenProgram), operator.publicKey, split.protocol, tokenProgram));
      }
    }
  };
  addSplit(tokenAMint, operatorAtaA, splitA, tokenAProgram);
  addSplit(tokenBMint, operatorAtaB, splitB, tokenBProgram);

  let splitSignature = "";
  if (splitIxs.length) splitSignature = await sendServerV0Instructions(connection, splitIxs, operator, "Meteora LP fee split");
  const harvestMeta = {
    lastTx: splitSignature || claimSignature,
    claimTx: claimSignature,
    splitTx: splitSignature || null,
    lastAt: new Date().toISOString(),
    grossARaw: gross.tokenA.toString(),
    grossBRaw: gross.tokenB.toString(),
    sourceVaultA: vaultA.toBase58(),
    sourceVaultB: vaultB.toBase58(),
    creatorADisplay: formatAmount(splitA.creator, decA),
    creatorBDisplay: formatAmount(splitB.creator, decB),
    protocolADisplay: formatAmount(splitA.protocol, decA),
    protocolBDisplay: formatAmount(splitB.protocol, decB),
    protocolTreasury: treasury.toBase58(),
  };
  await input.pool.query(
    `update public.campaigns set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{solanaGraduation,harvest}', $3::jsonb, true) where chain_id = $1 and campaign_address = $2`,
    [SOLANA_CHAIN_ID, String(row.campaign_address), JSON.stringify(harvestMeta)],
  ).catch((error) => console.warn("[solana-lp-fees] harvest meta persist failed", error instanceof Error ? error.message : error));

  return {
    ok: true,
    chainId: SOLANA_CHAIN_ID,
    campaignAddress: String(row.campaign_address),
    pairAddress: poolAddress,
    creatorAddress: creator,
    protocolTreasury: treasury.toBase58(),
    split: { creatorBps: CREATOR_FEE_BPS, protocolBps: PROTOCOL_FEE_BPS },
    claimed: {
      tokenA: formatAmount(gross.tokenA, decA),
      tokenB: formatAmount(gross.tokenB, decB),
      creatorA: harvestMeta.creatorADisplay,
      creatorB: harvestMeta.creatorBDisplay,
      protocolA: harvestMeta.protocolADisplay,
      protocolB: harvestMeta.protocolBDisplay,
    },
    grossClaimRaw: { tokenA: gross.tokenA.toString(), tokenB: gross.tokenB.toString() },
    sourceVaultEvidence: {
      tokenA: { address: vaultA.toBase58(), before: vaultBeforeA.toString(), after: vaultAfterA.toString(), gross: gross.tokenA.toString() },
      tokenB: { address: vaultB.toBase58(), before: vaultBeforeB.toString(), after: vaultAfterB.toString(), gross: gross.tokenB.toString() },
    },
    settlementMode: { tokenA: settlementModeForMint(tokenAMint), tokenB: settlementModeForMint(tokenBMint) },
    txHash: harvestMeta.lastTx,
    claimTx: claimSignature,
    splitTx: splitSignature || null,
    retryNoop: false,
    note: gross.tokenA === 0n && gross.tokenB === 0n
      ? "No unclaimed Meteora fees on this position."
      : "Claimed gross locked-position fees from authoritative Meteora source-vault movement and sent the full 80% creator / 20% protocol entitlement. Transaction fees remain operator costs. Principal stays locked.",
  };
}
