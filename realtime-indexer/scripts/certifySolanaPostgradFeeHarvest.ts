import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CpAmm, derivePositionNftAccount, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { Pool } from "pg";
import { harvestSolanaLpFees, listSolanaLpFees } from "../src/solanaLpFees.ts";

const CHAIN_ID = 101;
const EXPECTED_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const METEORA_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const CREATOR_BPS = 8000n;
const BPS = 10000n;
const REPORT = process.env.SOLANA_FEE_HARVEST_REPORT || "reports/agent5-solana-postgrad-fee-harvest.json";
const PRE_REPORT = process.env.SOLANA_NETWORK_CANARY_REPORT || "/tmp/mwz-solana-101-canary.json";
const GRAD_REPORT = process.env.SOLANA_BASIC_RESULT_REPORT || "/tmp/mwz-solana-101-graduation-result.json";
const POST_REPORT = process.env.SOLANA_POSTGRAD_CANARY_REPORT || "/tmp/mwz-solana-101-postgrad.json";

function fail(message: string): never { throw new Error(`[agent5-solana-fee-harvest] ${message}`); }
function required(name: string): string { const v = String(process.env[name] || "").trim(); if (!v) fail(`${name} is required`); return v; }
function readJson(file: string): any { if (!fs.existsSync(file)) fail(`missing evidence file ${file}`); return JSON.parse(fs.readFileSync(file, "utf8")); }
function bi(value: any): bigint { try { return BigInt(value?.toString?.() ?? value ?? 0); } catch { return 0n; } }
function split(total: bigint) { const creator = total * CREATOR_BPS / BPS; return { creator, protocol: total - creator }; }
function loadOperator(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) fail("operator keypair file must contain 64 bytes");
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function tokenProgramFromFlag(flag: unknown): PublicKey {
  return Number(flag ?? 0) === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

async function balanceForMint(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  // Meteora pool assets are SPL token mints. So111... is WSOL in this context,
  // not the owner's native system-account lamports.
  const ata = deriveAta(owner, mint, tokenProgram);
  try {
    const response = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(response.value.amount || "0");
  } catch {
    return 0n;
  }
}

async function snapshot(
  connection: Connection,
  owner: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  tokenAProgram: PublicKey,
  tokenBProgram: PublicKey,
) {
  const [a, b] = await Promise.all([
    balanceForMint(connection, owner, mintA, tokenAProgram),
    balanceForMint(connection, owner, mintB, tokenBProgram),
  ]);
  return { a, b };
}

function delta(after: {a: bigint; b: bigint}, before: {a: bigint; b: bigint}) {
  return { a: after.a - before.a, b: after.b - before.b };
}

function assertEvidence(input: {
  chainId: number; campaign: string; mint: string; creator: string; pool: string; position: string;
}, canonical: {
  campaign: string; mint: string; creator: string; pool: string; position: string;
}) {
  if (input.chainId !== CHAIN_ID) fail(`wrong chain proof rejected: ${input.chainId}`);
  if (input.campaign !== canonical.campaign) fail("wrong campaign proof rejected");
  if (input.mint !== canonical.mint) fail("wrong mint proof rejected");
  if (input.creator !== canonical.creator) fail("wrong recipient/creator proof rejected");
  if (input.pool !== canonical.pool) fail("wrong pool proof rejected");
  if (input.position !== canonical.position) fail("wrong position proof rejected");
}

function expectRejected(label: string, fn: () => void) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  if (!rejected) fail(`${label} proof was not rejected`);
}

async function ensureCertificationCampaign(pool: Pool, canonical: any) {
  await pool.query(`create table if not exists public.campaigns (
    chain_id integer not null,
    campaign_address text not null,
    token_address text,
    creator_address text,
    name text,
    symbol text,
    graduated_at_chain timestamptz,
    meta jsonb not null default '{}'::jsonb,
    primary key (chain_id, campaign_address)
  )`);
  await pool.query(`insert into public.campaigns(chain_id,campaign_address,token_address,creator_address,name,symbol,graduated_at_chain,meta)
    values($1,$2,$3,$4,'Agent 5 fee harvest proof','A5FEE',now(),$5::jsonb)
    on conflict(chain_id,campaign_address) do update set token_address=excluded.token_address, creator_address=excluded.creator_address,
      graduated_at_chain=excluded.graduated_at_chain, meta=excluded.meta`, [
    CHAIN_ID, canonical.campaign, canonical.mint, canonical.creator,
    JSON.stringify({ solanaGraduation: { pool: canonical.pool, position: canonical.position, certificationOnly: true } }),
  ]);
}

async function execute() {
  if (String(process.env.SOLANA_APPLICATION_CHAIN_ID || "") !== "101") fail("certification is chain 101 only");
  const rpc = required("SOLANA_RPC_URL");
  const db = required("DATABASE_URL");
  const operator = loadOperator(required("SOLANA_OPERATOR_KEYPAIR"));
  const treasury = new PublicKey(required("SOLANA_PROTOCOL_TREASURY_ADDRESS"));
  if (treasury.equals(operator.publicKey)) fail("protocol treasury must be distinct from harvest operator; hidden operator custody is forbidden");
  const connection = new Connection(rpc, "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_GENESIS) fail("refusing to certify outside Solana devnet");

  const pre = readJson(PRE_REPORT);
  const grad = readJson(GRAD_REPORT);
  const post = readJson(POST_REPORT);
  if (pre.applicationChainId !== CHAIN_ID || post.applicationChainId !== CHAIN_ID) fail("non-101 canary evidence rejected");
  if (post.pool !== grad.meteoraPool || pre.mint !== post.mint) fail("graduation/post-grad identity mismatch");

  const campaignPk = new PublicKey(pre.campaign);
  const campaignInfo = await connection.getAccountInfo(campaignPk, "confirmed");
  if (!campaignInfo) fail("campaign account is missing on devnet");
  const require = createRequire(import.meta.url);
  const { decodeCampaign } = require("../../tests/solana/decode-campaign.cjs");
  const campaignState = decodeCampaign(campaignInfo.data);
  const canonical = {
    campaign: pre.campaign,
    mint: campaignState.mint.toBase58(),
    creator: campaignState.creator.toBase58(),
    pool: grad.meteoraPool,
    position: grad.meteoraPosition,
  };
  if (canonical.mint !== pre.mint) fail("on-chain campaign mint does not match canary mint");

  assertEvidence({ chainId: CHAIN_ID, ...canonical }, canonical);
  expectRejected("wrong-chain", () => assertEvidence({ chainId: 56, ...canonical }, canonical));
  expectRejected("wrong-pool", () => assertEvidence({ chainId: CHAIN_ID, ...canonical, pool: Keypair.generate().publicKey.toBase58() }, canonical));
  expectRejected("wrong-mint", () => assertEvidence({ chainId: CHAIN_ID, ...canonical, mint: Keypair.generate().publicKey.toBase58() }, canonical));
  expectRejected("wrong-recipient", () => assertEvidence({ chainId: CHAIN_ID, ...canonical, creator: Keypair.generate().publicKey.toBase58() }, canonical));

  const cpAmm = new CpAmm(connection as any);
  const poolPk = new PublicKey(canonical.pool);
  const positionPk = new PublicKey(canonical.position);
  const [poolInfo, positionInfo, poolState, positionState] = await Promise.all([
    connection.getAccountInfo(poolPk, "confirmed"),
    connection.getAccountInfo(positionPk, "confirmed"),
    cpAmm.fetchPoolState(poolPk),
    cpAmm.fetchPositionState(positionPk),
  ]);
  if (!poolInfo?.owner.equals(METEORA_PROGRAM) || !positionInfo?.owner.equals(METEORA_PROGRAM)) fail("pool/position not owned by Meteora CP-AMM");
  const positionPool = (positionState as any).pool || (positionState as any).poolAddress || (positionState as any).pool_address;
  if (positionPool && new PublicKey(positionPool).toBase58() !== canonical.pool) fail("position/pool binding mismatch");
  const nftMintRaw = (positionState as any).nftMint || (positionState as any).nft_mint;
  if (!nftMintRaw) fail("position NFT mint missing");
  const nftMint = nftMintRaw instanceof PublicKey ? nftMintRaw : new PublicKey(String(nftMintRaw));
  if (nftMint.toBase58() !== grad.positionNftMint) fail("position NFT mint differs from graduation proof");
  const custody = derivePositionNftAccount(nftMint);
  const custodyInfo = await connection.getAccountInfo(custody, "confirmed");
  if (!custodyInfo) fail("Meteora position NFT custody PDA is missing");
  if (String(grad.unlockedLiquidity) !== "0" || bi(grad.permanentLockedLiquidity) <= 0n || grad.permanentCustody !== true) fail("position principal is not permanently locked");

  const pair = [poolState.tokenAMint.toBase58(), poolState.tokenBMint.toBase58()];
  if (!pair.includes(canonical.mint) || !pair.includes(WSOL.toBase58())) fail("pool is not exact campaign mint/WSOL pair");
  const mintA = poolState.tokenAMint;
  const mintB = poolState.tokenBMint;
  const tokenAProgram = tokenProgramFromFlag((poolState as any).tokenAFlag);
  const tokenBProgram = tokenProgramFromFlag((poolState as any).tokenBFlag);
  const unclaimed = getUnClaimLpFee(poolState as any, positionState as any);
  const feeA = bi((unclaimed as any).feeTokenA);
  const feeB = bi((unclaimed as any).feeTokenB);
  if (feeA <= 0n && feeB <= 0n) fail("real post-grad BUY/SELL generated no claimable Meteora LP fee entitlement");
  const expectedA = split(feeA);
  const expectedB = split(feeB);

  const pg = new Pool({ connectionString: db, ssl: false });
  await ensureCertificationCampaign(pg, canonical);
  const listedBefore: any = await listSolanaLpFees({ pool: pg, campaign: canonical.campaign, creator: null, limit: 5 });
  const listItemBefore = listedBefore.items?.find((x: any) => x.campaignAddress === canonical.campaign);
  if (!listItemBefore?.fees?.registered) fail("runtime LP fee reader did not register exact campaign position");

  const creatorPk = new PublicKey(canonical.creator);
  const creatorAtaA = deriveAta(creatorPk, mintA, tokenAProgram);
  const creatorAtaB = deriveAta(creatorPk, mintB, tokenBProgram);
  const treasuryAtaA = deriveAta(treasury, mintA, tokenAProgram);
  const treasuryAtaB = deriveAta(treasury, mintB, tokenBProgram);
  const operatorAtaA = deriveAta(operator.publicKey, mintA, tokenAProgram);
  const operatorAtaB = deriveAta(operator.publicKey, mintB, tokenBProgram);

  const [creatorBefore, treasuryBefore, operatorBefore] = await Promise.all([
    snapshot(connection, creatorPk, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, treasury, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, operator.publicKey, mintA, mintB, tokenAProgram, tokenBProgram),
  ]);

  const harvest: any = await harvestSolanaLpFees({ pool: pg, campaign: canonical.campaign, pair: canonical.pool });
  if (!harvest?.claimTx) fail("runtime harvest did not return a Meteora claim signature");
  if (!harvest?.splitTx) fail("runtime harvest did not return a receiver split signature");

  const [creatorAfter, treasuryAfter, operatorAfter] = await Promise.all([
    snapshot(connection, creatorPk, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, treasury, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, operator.publicKey, mintA, mintB, tokenAProgram, tokenBProgram),
  ]);
  const creatorDelta = delta(creatorAfter, creatorBefore);
  const treasuryDelta = delta(treasuryAfter, treasuryBefore);
  const operatorDelta = delta(operatorAfter, operatorBefore);

  const claimTx = await connection.getTransaction(harvest.claimTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const splitTx = await connection.getTransaction(harvest.splitTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!claimTx || claimTx.meta?.err || !splitTx || splitTx.meta?.err) fail("claim/split transaction is missing or failed on chain");

  if (creatorDelta.a !== expectedA.creator || creatorDelta.b !== expectedB.creator) {
    fail(`creator receiver delta mismatch expected=${expectedA.creator}/${expectedB.creator} actual=${creatorDelta.a}/${creatorDelta.b}`);
  }
  if (treasuryDelta.a !== expectedA.protocol || treasuryDelta.b !== expectedB.protocol) {
    fail(`protocol receiver delta mismatch expected=${expectedA.protocol}/${expectedB.protocol} actual=${treasuryDelta.a}/${treasuryDelta.b}`);
  }
  if (operatorDelta.a > 0n || operatorDelta.b > 0n) fail(`harvest operator retained positive fee custody delta ${operatorDelta.a}/${operatorDelta.b}`);

  const persisted = await pg.query(`select meta #> '{solanaGraduation,harvest}' as harvest from public.campaigns where chain_id=$1 and campaign_address=$2`, [CHAIN_ID, canonical.campaign]);
  const dbHarvest = persisted.rows[0]?.harvest;
  if (!dbHarvest || dbHarvest.claimTx !== harvest.claimTx || dbHarvest.splitTx !== harvest.splitTx) fail("DB reconciliation does not bind exact claim/split signatures");

  const [retryCreatorBefore, retryTreasuryBefore] = await Promise.all([
    snapshot(connection, creatorPk, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, treasury, mintA, mintB, tokenAProgram, tokenBProgram),
  ]);
  const retry: any = await harvestSolanaLpFees({ pool: pg, campaign: canonical.campaign, pair: canonical.pool });
  const [retryCreatorAfter, retryTreasuryAfter] = await Promise.all([
    snapshot(connection, creatorPk, mintA, mintB, tokenAProgram, tokenBProgram),
    snapshot(connection, treasury, mintA, mintB, tokenAProgram, tokenBProgram),
  ]);
  const retryCreatorDelta = delta(retryCreatorAfter, retryCreatorBefore);
  const retryTreasuryDelta = delta(retryTreasuryAfter, retryTreasuryBefore);
  if ([retryCreatorDelta.a,retryCreatorDelta.b,retryTreasuryDelta.a,retryTreasuryDelta.b].some((x) => x !== 0n)) fail("retry caused a duplicate receiver transfer");
  if (retry?.claimTx || retry?.splitTx || retry?.retryNoop !== true) fail("zero-fee retry sent or reported a second settlement transaction");
  if (retry?.txHash !== dbHarvest.lastTx) fail("zero-fee retry did not preserve original settlement identity");

  const report = {
    schemaVersion: 2,
    sourceSha: process.env.GITHUB_SHA || null,
    status: "PASS",
    chainId: CHAIN_ID,
    cluster: "devnet",
    campaign: canonical.campaign,
    mint: canonical.mint,
    pool: canonical.pool,
    position: canonical.position,
    positionNftMint: nftMint.toBase58(),
    positionNftCustodyPda: custody.toBase58(),
    custodyAccountOwner: custodyInfo.owner.toBase58(),
    permanentLockedLiquidity: String(grad.permanentLockedLiquidity),
    unlockedLiquidity: String(grad.unlockedLiquidity),
    postgradTradeSignatures: { buy: post.buy?.signature, sell: post.sell?.signature },
    feeAssets: {
      tokenA: {
        mint: mintA.toBase58(), tokenProgram: tokenAProgram.toBase58(), sourceFeeAccount: poolState.tokenAVault.toBase58(),
        creatorReceiverAccount: creatorAtaA.toBase58(), protocolReceiverAccount: treasuryAtaA.toBase58(), operatorClaimAccount: operatorAtaA.toBase58(),
        creatorPreBalance: creatorBefore.a.toString(), creatorExpectedEntitlement: expectedA.creator.toString(), creatorPostBalance: creatorAfter.a.toString(), creatorActualDelta: creatorDelta.a.toString(),
        protocolPreBalance: treasuryBefore.a.toString(), protocolExpectedEntitlement: expectedA.protocol.toString(), protocolPostBalance: treasuryAfter.a.toString(), protocolActualDelta: treasuryDelta.a.toString(),
      },
      tokenB: {
        mint: mintB.toBase58(), tokenProgram: tokenBProgram.toBase58(), sourceFeeAccount: poolState.tokenBVault.toBase58(),
        creatorReceiverAccount: creatorAtaB.toBase58(), protocolReceiverAccount: treasuryAtaB.toBase58(), operatorClaimAccount: operatorAtaB.toBase58(),
        creatorPreBalance: creatorBefore.b.toString(), creatorExpectedEntitlement: expectedB.creator.toString(), creatorPostBalance: creatorAfter.b.toString(), creatorActualDelta: creatorDelta.b.toString(),
        protocolPreBalance: treasuryBefore.b.toString(), protocolExpectedEntitlement: expectedB.protocol.toString(), protocolPostBalance: treasuryAfter.b.toString(), protocolActualDelta: treasuryDelta.b.toString(),
      },
    },
    feeBeforeHarvestRaw: { tokenA: feeA.toString(), tokenB: feeB.toString(), tokenAMint: mintA.toBase58(), tokenBMint: mintB.toBase58() },
    expectedReceiversRaw: {
      creator: { address: canonical.creator, tokenA: expectedA.creator.toString(), tokenB: expectedB.creator.toString() },
      protocol: { address: treasury.toBase58(), tokenA: expectedA.protocol.toString(), tokenB: expectedB.protocol.toString() },
    },
    receiverDeltasRaw: {
      creator: { tokenA: creatorDelta.a.toString(), tokenB: creatorDelta.b.toString() },
      protocol: { tokenA: treasuryDelta.a.toString(), tokenB: treasuryDelta.b.toString() },
      operator: { address: operator.publicKey.toBase58(), tokenA: operatorDelta.a.toString(), tokenB: operatorDelta.b.toString() },
    },
    transactions: { graduation: grad.signature, claim: harvest.claimTx, split: harvest.splitTx, retryClaim: retry?.claimTx || null, retrySplit: retry?.splitTx || null },
    transactionPrograms: {
      claim: "Meteora CP-AMM claimPositionFee -> operator SPL token accounts",
      split: `SPL token transfers via ${tokenAProgram.toBase58()} / ${tokenBProgram.toBase58()}`,
    },
    dbReconciliation: { claimTx: dbHarvest.claimTx, splitTx: dbHarvest.splitTx, lastTx: dbHarvest.lastTx, status: "PASS" },
    retry: { receiverTransferDeltaRaw: { creatorA: retryCreatorDelta.a.toString(), creatorB: retryCreatorDelta.b.toString(), protocolA: retryTreasuryDelta.a.toString(), protocolB: retryTreasuryDelta.b.toString() }, duplicateTransfer: false, retryNoop: true, preservedTxHash: retry.txHash },
    negativeProofs: { wrongChain: "REJECTED", wrongPool: "REJECTED", wrongMint: "REJECTED", wrongRecipient: "REJECTED" },
    noHiddenCustody: true,
    noBnbContamination: true,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  await pg.end();
  console.log(JSON.stringify(report, null, 2));
}

async function reload() {
  const report = readJson(REPORT);
  if (report.chainId !== CHAIN_ID || report.cluster !== "devnet" || report.status !== "PASS") fail("saved proof is not canonical Solana devnet PASS evidence");
  const pool = new Pool({ connectionString: required("DATABASE_URL"), ssl: false });
  const persisted = await pool.query(`select chain_id, campaign_address, meta #> '{solanaGraduation,harvest}' as harvest from public.campaigns where chain_id=$1 and campaign_address=$2`, [CHAIN_ID, report.campaign]);
  await pool.end();
  const row = persisted.rows[0];
  if (!row || Number(row.chain_id) !== CHAIN_ID || row.harvest?.claimTx !== report.transactions.claim || row.harvest?.splitTx !== report.transactions.split) fail("fresh-process reload did not preserve settled DB state");
  console.log(JSON.stringify({ status: "PASS", reload: "fresh-process", chainId: CHAIN_ID, campaign: report.campaign, claimTx: row.harvest.claimTx, splitTx: row.harvest.splitTx }, null, 2));
}

const mode = process.argv[2] || "execute";
(mode === "reload" ? reload() : execute()).catch((error) => { console.error(error?.stack || error); process.exit(1); });