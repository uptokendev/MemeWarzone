import fs from "node:fs";

import {
  createSplashPool,
  fetchWhirlpoolsByTokenPair,
  openFullRangePosition,
  orderMints,
  setPayerFromBytes,
  setRpc,
  setWhirlpoolsConfig,
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
const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PRICE = 150;
const DEFAULT_SEED_SOL = 0.25;
const REPORT_PATH = process.env.ORCA_DEVNET_CERT_REPORT || "/tmp/mwz-orca-devnet-cert-pool.json";

function fail(message) {
  throw new Error(`[orca-devnet-cert-pool] ${message}`);
}

function loadOperatorBytes() {
  const keypairPath = String(process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR || "").trim();
  if (!keypairPath) fail("SOLANA_GRADUATION_OPERATOR_KEYPAIR is required");
  if (!fs.existsSync(keypairPath)) fail(`operator keypair not found: ${keypairPath}`);
  const parsed = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length < 64) fail("operator keypair must be a Solana secret-key byte array");
  return new Uint8Array(parsed);
}

function decimalSeedRaw(sol) {
  return BigInt(Math.round(sol * 1_000_000_000));
}

async function tokenBalance(connection, owner, mint) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_PROGRAM_ID);
  try {
    const account = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return { ata: ata.toBase58(), raw: account.amount };
  } catch {
    return { ata: ata.toBase58(), raw: 0n };
  }
}

function toJson(value) {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

async function main() {
  const rpcUrl = String(process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
  const initialPriceUsd = Number(process.env.ORCA_DEVNET_CERT_SOL_USDC_PRICE || DEFAULT_PRICE);
  const seedSol = Number(process.env.ORCA_DEVNET_CERT_SEED_SOL || DEFAULT_SEED_SOL);
  if (!Number.isFinite(initialPriceUsd) || initialPriceUsd <= 0) fail("ORCA_DEVNET_CERT_SOL_USDC_PRICE must be > 0");
  if (!Number.isFinite(seedSol) || seedSol <= 0) fail("ORCA_DEVNET_CERT_SEED_SOL must be > 0");

  const operatorBytes = loadOperatorBytes();
  await setRpc(rpcUrl);
  await setWhirlpoolsConfig("solanaDevnet");
  const payer = await setPayerFromBytes(operatorBytes);
  const rpc = createSolanaRpc(devnet(rpcUrl));
  const web3 = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(String(payer.address));

  const [mintA, mintB] = orderMints(address(WSOL), address(CIRCLE_DEVNET_USDC));
  const wsolIsA = String(mintA) === WSOL;
  const initialPrice = wsolIsA ? initialPriceUsd : 1 / initialPriceUsd;

  const poolInfos = await fetchWhirlpoolsByTokenPair(
    rpc,
    address(WSOL),
    address(CIRCLE_DEVNET_USDC),
    WhirlpoolDeployment.devnet,
  );
  const existingSplash = poolInfos.find((pool) => Number(pool.tickSpacing) === 32896 && pool.initialized);
  let poolAddress = existingSplash ? String(existingSplash.address) : null;
  let poolCreationSignature = null;

  if (!poolAddress) {
    const created = await createSplashPool(
      rpc,
      mintA,
      mintB,
      initialPrice,
      payer,
      { whirlpoolDeployment: WhirlpoolDeployment.devnet },
    );
    poolAddress = String(created.poolAddress);
    poolCreationSignature = await created.callback();
  }

  const usdc = await tokenBalance(web3, owner, CIRCLE_DEVNET_USDC);
  const solLamports = await web3.getBalance(owner, "confirmed");
  const desiredSolRaw = decimalSeedRaw(seedSol);
  const desiredUsdcRaw = BigInt(Math.ceil(seedSol * initialPriceUsd * 1_000_000));

  const report = {
    rpcUrl,
    network: "solana-devnet",
    operator: owner.toBase58(),
    orca: { programId: ORCA_PROGRAM, config: ORCA_DEVNET_CONFIG },
    poolAddress,
    tokenA: String(mintA),
    tokenB: String(mintB),
    wsolMint: WSOL,
    circleDevnetUsdcMint: CIRCLE_DEVNET_USDC,
    initialPriceUsdPerSol: initialPriceUsd,
    poolCreationSignature,
    balancesBeforeSeed: { solLamports, usdcAta: usdc.ata, usdcRaw: usdc.raw },
    desiredSeed: { solRaw: desiredSolRaw, usdcRaw: desiredUsdcRaw },
    liquiditySeedingSignature: null,
    liquidityPositionMint: null,
    status: "POOL_READY_UNSEEDED",
  };

  if (usdc.raw < desiredUsdcRaw) {
    report.status = "BLOCKED_CIRCLE_DEVNET_USDC_FUNDING";
    fs.writeFileSync(REPORT_PATH, toJson(report));
    console.log(toJson(report));
    fail(`operator Circle devnet USDC balance ${usdc.raw} is below required seed ${desiredUsdcRaw}; fund ${usdc.ata} from the Circle devnet faucet or an existing funded devnet wallet`);
  }
  if (BigInt(solLamports) <= desiredSolRaw + 50_000_000n) {
    report.status = "BLOCKED_DEVNET_SOL_FUNDING";
    fs.writeFileSync(REPORT_PATH, toJson(report));
    console.log(toJson(report));
    fail("operator does not have enough devnet SOL for liquidity plus transaction rent/fees");
  }

  const seedParam = wsolIsA ? { tokenA: desiredSolRaw } : { tokenB: desiredSolRaw };
  const opened = await openFullRangePosition(
    rpc,
    address(poolAddress),
    seedParam,
    100,
    payer,
    { whirlpoolDeployment: WhirlpoolDeployment.devnet },
  );
  report.liquiditySeedingSignature = await opened.callback();
  report.liquidityPositionMint = String(opened.positionMint || opened.positionAddress || "");
  report.seedQuote = opened.quote;
  report.status = "READY";
  fs.writeFileSync(REPORT_PATH, toJson(report));
  console.log(toJson(report));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
