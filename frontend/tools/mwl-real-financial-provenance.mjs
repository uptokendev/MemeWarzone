import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ethers } from "ethers";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { pool } from "../server/db.js";

const outPath = String(process.argv[2] || "artifacts/mwl-financial-provenance.json").trim();
const BSC97_RPC_URL = String(process.env.BSC97_RPC_URL || "").trim();
const BSC_TESTNET_PRIVATE_KEY = String(process.env.BSC_TESTNET_PRIVATE_KEY || "").trim();
const BSC_WAR_POOL = String(process.env.ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97 || "").trim();
const SOLANA_RPC = String(process.env.SOLANA_DEVNET_RPC_URL || "").trim();
const SOLANA_GENESIS = String(process.env.SOLANA_DEVNET_GENESIS_HASH || "").trim();
const SOLANA_SIGNER = String(process.env.SOLANA_DEVNET_ROUTE_SIGNER_SECRET_KEY || "").trim();
const CERT_YEAR = Number(process.env.CERT_YEAR || 0);
const CERT_MONTH = Number(process.env.CERT_MONTH || 0);

const SOLANA_PROGRAM = new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const BSC_CHAIN_ID = 97;
const SOLANA_CHAIN_ID = 101;

function assert(ok, code, details = {}) {
  if (!ok) {
    const e = new Error(code);
    e.code = code;
    e.details = details;
    throw e;
  }
}

function quarterForMonth(month) {
  return Math.floor((month - 1) / 3) + 1;
}

function mwlSeason(chainId) {
  return `mwl-${CERT_YEAR}-m${String(CERT_MONTH).padStart(2, "0")}-c${chainId}`;
}

function quarterlyEpoch(chainId) {
  return `quarterly-championship-${CERT_YEAR}-q${quarterForMonth(CERT_MONTH)}-c${chainId}`;
}

async function dbClaim(chainId, txHash) {
  for (let i = 0; i < 10; i += 1) {
    const q = await pool.query(
      `select pool_id,bucket,wallet,amount_wei::text as amount_raw,tx_hash,chain_id,created_at
         from public.arena_war_pool_claims
        where chain_id=$1 and lower(tx_hash)=lower($2) and bucket='mwl'
        order by created_at desc limit 1`,
      [chainId, txHash],
    );
    if (q.rows[0]) return q.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

function parseKeypair(raw) {
  const bytes = Uint8Array.from(raw.startsWith("[") ? JSON.parse(raw) : Buffer.from(raw, "base64"));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`SOLANA_SIGNER_BAD_LENGTH_${bytes.length}`);
}

async function proveBsc97() {
  if (!BSC97_RPC_URL || !BSC_TESTNET_PRIVATE_KEY || !BSC_WAR_POOL) {
    return { status: "OPERATOR_BLOCKER", reason: "BSC97_PROVENANCE_SECRETS_OR_WAR_POOL_ADDRESS_MISSING" };
  }
  const provider = new ethers.JsonRpcProvider(BSC97_RPC_URL);
  const network = await provider.getNetwork();
  assert(Number(network.chainId) === BSC_CHAIN_ID, "BSC97_CHAIN_ID_MISMATCH", { actual: Number(network.chainId) });
  assert(ethers.isAddress(BSC_WAR_POOL), "BSC97_WAR_POOL_ADDRESS_INVALID");
  const code = await provider.getCode(BSC_WAR_POOL);
  assert(code && code !== "0x", "BSC97_WAR_POOL_NOT_DEPLOYED", { address: BSC_WAR_POOL });

  const signer = new ethers.Wallet(BSC_TESTNET_PRIVATE_KEY, provider);
  const warAbi = [
    "event PoolResolved(bytes32 indexed poolId,address indexed winnerPayout,uint256 pendingWinner,uint256 pendingProtocol,uint256 pendingLeague,uint256 entryGross,uint256 boostGross)",
    "function postGradLeagueTreasury() view returns (address)",
    "function claimLeague(bytes32 poolId,bytes32 monthlyEpoch,bytes32 quarterlyEpoch)",
  ];
  const leagueAbi = [
    "event CompetitionShareCredited(bytes32 indexed sourcePool,bytes32 indexed monthlyEpoch,bytes32 indexed quarterlyEpoch,uint256 grossNativeRaw,uint256 monthlyNativeRaw,uint256 quarterlyNativeRaw,address source)",
    "function pendingMonthly() view returns (uint256)",
    "function pendingQuarterly() view returns (uint256)",
    "function pendingMonthlyByEpoch(bytes32) view returns (uint256)",
    "function pendingQuarterlyByEpoch(bytes32) view returns (uint256)",
    "function creditedSourcePools(bytes32) view returns (bool)",
  ];
  const war = new ethers.Contract(BSC_WAR_POOL, warAbi, signer);
  const leagueAddress = ethers.getAddress(await war.postGradLeagueTreasury());
  assert((await provider.getCode(leagueAddress)) !== "0x", "BSC97_LEAGUE_TREASURY_NOT_DEPLOYED", { leagueAddress });
  const league = new ethers.Contract(leagueAddress, leagueAbi, provider);
  const monthKey = ethers.id(mwlSeason(BSC_CHAIN_ID));
  const quarterKey = ethers.id(quarterlyEpoch(BSC_CHAIN_ID));
  const iface = new ethers.Interface(warAbi);
  const resolvedTopic = iface.getEvent("PoolResolved").topicHash;
  const latest = await provider.getBlockNumber();
  let candidate = null;
  const maxLookback = 750000;
  const chunk = 5000;
  for (let to = latest; to >= Math.max(0, latest - maxLookback) && !candidate; to -= chunk) {
    const from = Math.max(0, to - chunk + 1);
    const logs = await provider.getLogs({ address: BSC_WAR_POOL, fromBlock: from, toBlock: to, topics: [resolvedTopic] });
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const parsed = iface.parseLog(logs[i]);
      const poolId = parsed.args.poolId;
      const leagueAmount = BigInt(parsed.args.pendingLeague);
      if (leagueAmount <= 0n || await league.creditedSourcePools(poolId)) continue;
      try {
        await war.claimLeague.staticCall(poolId, monthKey, quarterKey);
        candidate = { poolId, leagueAmount, resolvedTxHash: logs[i].transactionHash, resolvedBlock: logs[i].blockNumber };
        break;
      } catch {
        // Resolved but no longer claimable; continue to the next real pool.
      }
    }
  }
  if (!candidate) return { status: "STAGING_BLOCKER", reason: "NO_UNCLAIMED_REAL_BSC97_COMPETITION_LEAGUE_POOL_FOUND", warPool: BSC_WAR_POOL, leagueAddress };

  const before = {
    leagueBalance: await provider.getBalance(leagueAddress),
    monthly: await league.pendingMonthly(),
    quarterly: await league.pendingQuarterly(),
    monthEpoch: await league.pendingMonthlyByEpoch(monthKey),
    quarterEpoch: await league.pendingQuarterlyByEpoch(quarterKey),
  };
  const tx = await war.claimLeague(candidate.poolId, monthKey, quarterKey);
  const receipt = await tx.wait();
  assert(receipt && Number(receipt.status) === 1, "BSC97_LEAGUE_CLAIM_FAILED");

  const leagueIface = new ethers.Interface(leagueAbi);
  const creditLog = receipt.logs
    .map((log) => { try { return leagueIface.parseLog(log); } catch { return null; } })
    .find((log) => log?.name === "CompetitionShareCredited");
  assert(creditLog, "BSC97_COMPETITION_SHARE_EVENT_MISSING");
  const gross = BigInt(creditLog.args.grossNativeRaw);
  const monthly = BigInt(creditLog.args.monthlyNativeRaw);
  const quarterly = BigInt(creditLog.args.quarterlyNativeRaw);
  assert(gross === candidate.leagueAmount, "BSC97_GROSS_DOES_NOT_MATCH_RESOLUTION");
  assert(monthly === (gross * 6000n) / 10000n && quarterly === gross - monthly, "BSC97_60_40_SPLIT_MISMATCH");

  const after = {
    leagueBalance: await provider.getBalance(leagueAddress),
    monthly: await league.pendingMonthly(),
    quarterly: await league.pendingQuarterly(),
    monthEpoch: await league.pendingMonthlyByEpoch(monthKey),
    quarterEpoch: await league.pendingQuarterlyByEpoch(quarterKey),
  };
  assert(after.leagueBalance - before.leagueBalance === gross, "BSC97_RECEIVER_BALANCE_DELTA_MISMATCH");
  assert(after.monthly - before.monthly === monthly && after.quarterly - before.quarterly === quarterly, "BSC97_TREASURY_STATE_DELTA_MISMATCH");
  assert(after.monthEpoch - before.monthEpoch === monthly && after.quarterEpoch - before.quarterEpoch === quarterly, "BSC97_EPOCH_STATE_DELTA_MISMATCH");

  const db = await dbClaim(BSC_CHAIN_ID, receipt.hash);
  return {
    status: db ? "PASS" : "CHAIN_PASS_DB_RECONCILIATION_BLOCKER",
    warPool: BSC_WAR_POOL,
    leagueAddress,
    sourcePool: candidate.poolId,
    sourceResolveTx: candidate.resolvedTxHash,
    sourceResolveBlock: candidate.resolvedBlock,
    intakeTx: receipt.hash,
    intakeBlock: receipt.blockNumber,
    grossRaw: gross.toString(),
    monthlyRaw: monthly.toString(),
    quarterlyRaw: quarterly.toString(),
    receiverBalanceDeltaRaw: (after.leagueBalance - before.leagueBalance).toString(),
    monthlyStateDeltaRaw: (after.monthly - before.monthly).toString(),
    quarterlyStateDeltaRaw: (after.quarterly - before.quarterly).toString(),
    monthlyEpochKey: monthKey,
    quarterlyEpochKey: quarterKey,
    dbReconciliation: db,
  };
}

function accountDisc(name) {
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
function ixDisc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64(buf, offset) {
  return buf.readBigUInt64LE(offset);
}
function decodePool(data) {
  if (!data.subarray(0, 8).equals(accountDisc("CompetitionPoolV2"))) return null;
  const b = data.subarray(8);
  let o = 0;
  const generation = b[o++];
  const id = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const kind = b[o++];
  const state = b[o++];
  o += 32 * 5;
  o += 8 + 8 + 4 + 8 + 8 + 8;
  o += 32 + 32;
  const pendingWinner = u64(b, o); o += 8;
  const pendingLeague = u64(b, o); o += 8;
  const pendingProtocol = u64(b, o); o += 8;
  const winnerClaimed = Boolean(b[o++]);
  const leagueClaimed = Boolean(b[o++]);
  const protocolClaimed = Boolean(b[o++]);
  return { generation, id, kind, state, pendingWinner, pendingLeague, pendingProtocol, winnerClaimed, leagueClaimed, protocolClaimed };
}
function decodeTreasury(data) {
  assert(data.subarray(0, 8).equals(accountDisc("PostGradLeagueTreasuryV2")), "SOLANA_TREASURY_DISCRIMINATOR_MISMATCH");
  const b = data.subarray(8);
  return { generation: b[0], monthly: u64(b, 97), quarterly: u64(b, 105) };
}
function decodeLeagueReceipt(data) {
  assert(data.subarray(0, 8).equals(accountDisc("LeagueSourceReceiptV2")), "SOLANA_LEAGUE_RECEIPT_DISCRIMINATOR_MISMATCH");
  const b = data.subarray(8);
  return {
    generation: b[0],
    sourceId: Buffer.from(b.subarray(1, 33)).toString("hex"),
    sourceKind: b[33],
    gross: u64(b, 34),
    monthly: u64(b, 42),
    quarterly: u64(b, 50),
  };
}

async function proveSolana() {
  if (!SOLANA_RPC || !SOLANA_SIGNER) return { status: "OPERATOR_BLOCKER", reason: "SOLANA_DEVNET_RPC_OR_ROUTE_SIGNER_MISSING" };
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const genesis = await connection.getGenesisHash();
  assert(genesis === (SOLANA_GENESIS || SOLANA_DEVNET_GENESIS), "SOLANA_DEVNET_GENESIS_MISMATCH", { actual: genesis });
  const signer = parseKeypair(SOLANA_SIGNER);
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("postgrad_league_v2")], SOLANA_PROGRAM);
  const treasuryBeforeInfo = await connection.getAccountInfo(treasury, "confirmed");
  assert(treasuryBeforeInfo, "SOLANA_POSTGRAD_LEAGUE_TREASURY_MISSING", { treasury: treasury.toBase58() });
  const treasuryBefore = decodeTreasury(treasuryBeforeInfo.data);
  assert(treasuryBefore.generation === 2, "SOLANA_TREASURY_GENERATION_MISMATCH");

  const accounts = await connection.getProgramAccounts(SOLANA_PROGRAM, { commitment: "confirmed" });
  let candidate = null;
  for (const account of accounts) {
    const decoded = decodePool(account.account.data);
    if (!decoded || decoded.generation !== 2 || decoded.state !== 2 || decoded.leagueClaimed || decoded.pendingLeague <= 0n) continue;
    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from("arena_money_league_src_v2"), decoded.id], SOLANA_PROGRAM);
    if (await connection.getAccountInfo(receipt, "confirmed")) continue;
    candidate = { publicKey: account.pubkey, account: account.account, decoded, receipt };
    break;
  }
  if (!candidate) return { status: "STAGING_BLOCKER", reason: "NO_UNROUTED_REAL_SOLANA_COMPETITION_LEAGUE_POOL_FOUND", treasury: treasury.toBase58() };

  const poolBalanceBefore = candidate.account.lamports;
  const treasuryBalanceBefore = treasuryBeforeInfo.lamports;
  const keys = [
    { pubkey: signer.publicKey, isSigner: true, isWritable: true },
    { pubkey: candidate.publicKey, isSigner: false, isWritable: true },
    { pubkey: treasury, isSigner: false, isWritable: true },
    { pubkey: candidate.receipt, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const instruction = new TransactionInstruction({
    programId: SOLANA_PROGRAM,
    keys,
    data: Buffer.concat([ixDisc("route_competition_league_v2"), candidate.decoded.id]),
  });
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(instruction), [signer], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const poolAfterInfo = await connection.getAccountInfo(candidate.publicKey, "confirmed");
  const treasuryAfterInfo = await connection.getAccountInfo(treasury, "confirmed");
  const receiptInfo = await connection.getAccountInfo(candidate.receipt, "confirmed");
  assert(poolAfterInfo && treasuryAfterInfo && receiptInfo, "SOLANA_POST_ROUTE_ACCOUNT_MISSING");
  const poolAfter = decodePool(poolAfterInfo.data);
  const treasuryAfter = decodeTreasury(treasuryAfterInfo.data);
  const routeReceipt = decodeLeagueReceipt(receiptInfo.data);
  const gross = candidate.decoded.pendingLeague;
  const quarterly = (gross * 4000n) / 10000n;
  const monthly = gross - quarterly;
  assert(poolAfter.pendingLeague === 0n && poolAfter.leagueClaimed, "SOLANA_SOURCE_POOL_NOT_CLEARED");
  assert(routeReceipt.gross === gross && routeReceipt.monthly === monthly && routeReceipt.quarterly === quarterly, "SOLANA_ROUTE_RECEIPT_SPLIT_MISMATCH");
  assert(BigInt(treasuryAfterInfo.lamports - treasuryBalanceBefore) === gross, "SOLANA_TREASURY_BALANCE_DELTA_MISMATCH");
  assert(BigInt(poolBalanceBefore - poolAfterInfo.lamports) === gross, "SOLANA_SOURCE_POOL_BALANCE_DELTA_MISMATCH");
  assert(treasuryAfter.monthly - treasuryBefore.monthly === monthly && treasuryAfter.quarterly - treasuryBefore.quarterly === quarterly, "SOLANA_TREASURY_STATE_DELTA_MISMATCH");

  const db = await dbClaim(SOLANA_CHAIN_ID, signature);
  return {
    status: db ? "PASS" : "CHAIN_PASS_DB_RECONCILIATION_BLOCKER",
    programId: SOLANA_PROGRAM.toBase58(),
    sourcePool: candidate.publicKey.toBase58(),
    sourceCompetitionIdHex: candidate.decoded.id.toString("hex"),
    leagueTreasury: treasury.toBase58(),
    leagueReceipt: candidate.receipt.toBase58(),
    intakeSignature: signature,
    grossRaw: gross.toString(),
    monthlyRaw: monthly.toString(),
    quarterlyRaw: quarterly.toString(),
    sourcePoolBalanceDeltaRaw: String(poolBalanceBefore - poolAfterInfo.lamports),
    treasuryBalanceDeltaRaw: String(treasuryAfterInfo.lamports - treasuryBalanceBefore),
    monthlyStateDeltaRaw: (treasuryAfter.monthly - treasuryBefore.monthly).toString(),
    quarterlyStateDeltaRaw: (treasuryAfter.quarterly - treasuryBefore.quarterly).toString(),
    receiptDecoded: {
      sourceId: routeReceipt.sourceId,
      sourceKind: routeReceipt.sourceKind,
      grossRaw: routeReceipt.gross.toString(),
      monthlyRaw: routeReceipt.monthly.toString(),
      quarterlyRaw: routeReceipt.quarterly.toString(),
    },
    dbReconciliation: db,
  };
}

async function main() {
  assert(Number.isInteger(CERT_YEAR) && CERT_YEAR >= 2030 && CERT_YEAR <= 2199, "CERT_YEAR_INVALID");
  assert(Number.isInteger(CERT_MONTH) && CERT_MONTH >= 1 && CERT_MONTH <= 12, "CERT_MONTH_INVALID");
  const evidence = {
    schema: "memewarzone.mwl-real-financial-provenance.v1",
    generatedAt: new Date().toISOString(),
    financialAuthority: {
      bsc97: "ArenaWarPoolTreasuryV2.claimLeague -> PostGradLeagueTreasuryV2.depositCompetitionShare -> CompetitionShareCredited",
      solanaDevnet: "route_competition_league_v2 -> PostGradLeagueTreasuryV2 state -> LeagueSourceReceiptV2",
    },
    bsc97: null,
    solanaDevnet: null,
  };
  try { evidence.bsc97 = await proveBsc97(); } catch (error) { evidence.bsc97 = { status: "FAIL", error: error.code || error.message, details: error.details || null }; }
  try { evidence.solanaDevnet = await proveSolana(); } catch (error) { evidence.solanaDevnet = { status: "FAIL", error: error.code || error.message, details: error.details || null }; }
  const statuses = [evidence.bsc97?.status, evidence.solanaDevnet?.status];
  evidence.verdict = statuses.every((s) => s === "PASS") ? "PASS" : "BLOCKED";
  await fs.writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.verdict !== "PASS") process.exitCode = 2;
}

main().catch(async (error) => {
  const evidence = { schema: "memewarzone.mwl-real-financial-provenance.v1", verdict: "FAIL", error: error.code || error.message, details: error.details || null };
  try { await fs.writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"); } catch {}
  console.error(error?.stack || error);
  process.exitCode = 1;
});
