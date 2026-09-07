import fs from "node:fs";

import {
  fetchConcentratedLiquidityPool,
  openFullRangePosition,
  orderMints,
  setPayerFromBytes,
  setRpc,
  WhirlpoolDeployment,
} from "@orca-so/whirlpools";
import { address, createSolanaRpc, devnet } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const ORCA_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const ORCA_DEVNET_CONFIG = "FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR";
const CIRCLE_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WSOL = NATIVE_MINT.toBase58();
const CERT_POOL = "6XqJUqX4zUL7KEm9wGqTvJmE7DdC8e6MYeMBF9uYLckX";
const CERT_TICK_SPACING = 1;
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PRICE = 145.948162;
const DEFAULT_SEED_SOL = 0.10;
const MAX_REFERENCE_DRIFT_BPS = 25;
const REPORT_PATH = process.env.ORCA_DEVNET_CERT_REPORT || "/tmp/mwz-orca-devnet-cert-pool.json";

function fail(message) { throw new Error(`[orca-devnet-cert-pool] ${message}`); }
function loadOperatorBytes() {
  const keypairPath = String(process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR || "").trim();
  if (!keypairPath) fail("SOLANA_GRADUATION_OPERATOR_KEYPAIR is required");
  if (!fs.existsSync(keypairPath)) fail(`operator keypair not found: ${keypairPath}`);
  const parsed = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length < 64) fail("operator keypair must be a Solana secret-key byte array");
  return new Uint8Array(parsed);
}
function decimalSeedRaw(sol) { return BigInt(Math.round(sol * 1_000_000_000)); }
async function tokenBalance(connection, owner, mint) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID);
  try {
    const account = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return { ata: ata.toBase58(), raw: account.amount };
  } catch { return { ata: ata.toBase58(), raw: 0n }; }
}
function toJson(value) { return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2); }
function priceDriftBps(price, reference) { return Math.round(Math.abs(Number(price) - reference) / reference * 10_000); }
function poolSnapshot(pool) {
  if (!pool?.initialized) return null;
  return {
    address: String(pool.address), priceTokenBPerTokenA: pool.price, liquidity: pool.liquidity,
    tickSpacing: pool.tickSpacing, feeRate: pool.feeRate, tokenMintA: String(pool.tokenMintA), tokenMintB: String(pool.tokenMintB),
    tokenVaultA: String(pool.tokenVaultA), tokenVaultB: String(pool.tokenVaultB),
  };
}

async function main() {
  const rpcUrl = String(process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  const referencePriceUsd = Number(process.env.ORCA_DEVNET_CERT_SOL_USDC_PRICE || DEFAULT_PRICE);
  const seedSol = Number(process.env.ORCA_DEVNET_CERT_SEED_SOL || DEFAULT_SEED_SOL);
  if (!Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) fail("ORCA_DEVNET_CERT_SOL_USDC_PRICE must be > 0");
  if (!Number.isFinite(seedSol) || seedSol <= 0) fail("ORCA_DEVNET_CERT_SEED_SOL must be > 0");

  const operatorBytes = loadOperatorBytes();
  await setRpc(rpcUrl);
  const payer = await setPayerFromBytes(operatorBytes);
  const rpc = createSolanaRpc(devnet(rpcUrl));
  const web3 = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(String(payer.address));
  const [mintA, mintB] = orderMints(address(WSOL), address(CIRCLE_DEVNET_USDC));
  if (String(mintA) !== WSOL || String(mintB) !== CIRCLE_DEVNET_USDC) fail("certification pool canonical mint order unexpectedly changed");

  const pool = await fetchConcentratedLiquidityPool(rpc, mintA, mintB, CERT_TICK_SPACING, WhirlpoolDeployment.devnet);
  if (!pool.initialized) fail("policy-selected Orca certification pool is not initialized");
  if (String(pool.address) !== CERT_POOL) fail(`policy-selected pool mismatch: ${pool.address}`);
  if (String(pool.tokenMintA) !== WSOL || String(pool.tokenMintB) !== CIRCLE_DEVNET_USDC) fail("policy-selected pool mint binding mismatch");
  if (Number(pool.tickSpacing) !== CERT_TICK_SPACING) fail("policy-selected pool tick spacing mismatch");
  if (priceDriftBps(pool.price, referencePriceUsd) > MAX_REFERENCE_DRIFT_BPS) fail(`policy-selected pool price ${pool.price} is outside ${MAX_REFERENCE_DRIFT_BPS} bps of ${referencePriceUsd}`);

  const usdc = await tokenBalance(web3, owner, CIRCLE_DEVNET_USDC);
  const solLamports = await web3.getBalance(owner, "confirmed");
  const desiredSolRaw = decimalSeedRaw(seedSol);
  const desiredUsdcRaw = BigInt(Math.ceil(seedSol * referencePriceUsd * 1_000_000));
  const report = {
    rpcUrl, network: "solana-devnet", operator: owner.toBase58(),
    orca: { programId: ORCA_PROGRAM, config: ORCA_DEVNET_CONFIG, deployment: "devnet" },
    poolAddress: CERT_POOL, poolWasReused: true, poolCreationSignature: null, tickSpacing: CERT_TICK_SPACING,
    poolStateBeforeSeed: poolSnapshot(pool), tokenA: String(mintA), tokenB: String(mintB),
    wsolMint: WSOL, circleDevnetUsdcMint: CIRCLE_DEVNET_USDC, referencePriceUsdPerSol: referencePriceUsd,
    balancesBeforeSeed: { solLamports, usdcAta: usdc.ata, usdcRaw: usdc.raw },
    desiredSeed: { solRaw: desiredSolRaw, usdcRaw: desiredUsdcRaw }, liquiditySeedingSignature: null, liquidityPositionMint: null,
    status: BigInt(pool.liquidity || 0) > 0n ? "READY_EXISTING_LIQUIDITY" : "POOL_READY_UNSEEDED",
  };

  if (BigInt(pool.liquidity || 0) === 0n) {
    if (usdc.raw < desiredUsdcRaw) {
      report.status = "BLOCKED_CIRCLE_DEVNET_USDC_FUNDING";
      fs.writeFileSync(REPORT_PATH, toJson(report)); console.log(toJson(report));
      fail(`operator Circle devnet USDC balance ${usdc.raw} is below required seed ${desiredUsdcRaw}; fund ${usdc.ata} with canonical Circle devnet USDC`);
    }
    if (BigInt(solLamports) <= desiredSolRaw + 50_000_000n) {
      report.status = "BLOCKED_DEVNET_SOL_FUNDING";
      fs.writeFileSync(REPORT_PATH, toJson(report)); console.log(toJson(report));
      fail("operator does not have enough devnet SOL for liquidity plus transaction rent/fees");
    }
    const opened = await openFullRangePosition(address(CERT_POOL), { tokenMaxA: desiredSolRaw }, {
      slippageToleranceBps: 100, funder: payer, whirlpoolDeployment: WhirlpoolDeployment.devnet,
    });
    report.liquiditySeedingSignature = await opened.callback();
    report.liquidityPositionMint = String(opened.positionMint || "");
    report.initializationCost = opened.initializationCost;
  }

  const after = await fetchConcentratedLiquidityPool(rpc, mintA, mintB, CERT_TICK_SPACING, WhirlpoolDeployment.devnet);
  report.poolStateAfterSeed = poolSnapshot(after);
  report.status = BigInt(after.liquidity || 0) > 0n ? "READY" : "POOL_READY_UNSEEDED";
  fs.writeFileSync(REPORT_PATH, toJson(report)); console.log(toJson(report));
  if (report.status !== "READY") fail("certification pool remains unseeded");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
