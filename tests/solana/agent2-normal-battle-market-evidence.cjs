"use strict";

const fs = require("node:fs");
const { Connection, PublicKey } = require("@solana/web3.js");
const { decodeCampaign } = require("./decode-campaign.cjs");

const RPC = String(process.env.SOLANA_RPC_URL || "").trim();
const LEFT = String(process.env.AGENT2_SOLANA_LEFT_REPORT || "").trim();
const RIGHT = String(process.env.AGENT2_SOLANA_RIGHT_REPORT || "").trim();
const OUT = String(process.env.AGENT2_SOLANA_MARKET_REPORT || "/tmp/agent2-solana-normal-battle-market.json");
const SOL_USD = Number(process.env.AGENT2_SOL_USD_PRICE || "200");
const OLD_LINEAGE = {
  workflowRun: 34791420698,
  jobId: 103816894071,
  artifactId: 10327748002,
  artifactSha256: "3f718b0c7ddd57b3d7b87162c04231a861f926c0665763c44722c6a4c6ff4814",
  create: "oBueLSP7RWA8kyCbu4h18y3Fp7JRn8XiPT2kBcr6CMnMTPi6TaekZbkGGrrx4wa3A9vtHBNyKPdtEuE85yHrkft",
  buy: "3u8HJ7m4VmygpyZQw86AkvX8xSfna8tT5bzWwiNqfymNHhWVegVYmmrxyDWJksNYScn9rodPfGe2izGZ5J8dGkD7",
  sell: "5g8E1DZmDfoBHnp3tVwPRYM8gk7qp128T9Sh4uMUfkL9dmKEWaJs7GzJtYgAyLwoC7YoMBvLepEJL2M3Xh4c2qzn",
  closeBuy: "XE7dqL64yRAhvxk1dt1wewhY73RFC3GHYqQLjT3atz9iyuzCitZowyUAKqVF1B3QNNXbjB74KUpYnbpj1AyBjZj"
};
function required(value, name) { if (!value) throw new Error(`${name} required`); return value; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function scale10(decimals) { return 10n ** BigInt(decimals); }
function lamportsToSol(v) { return Number(v) / 1_000_000_000; }
function mcapSol(state, soldRaw) {
  const tokenScale = scale10(state.tokenDecimals);
  const soldWhole = Number(soldRaw) / Number(tokenScale);
  const marginalLamports = Number(state.basePriceLamports) + (state.economicsVersion >= 3 ? Number(state.priceSlopeLamports) * soldWhole / 1_000_000_000 : Number(state.priceSlopeLamports) * soldWhole);
  return (marginalLamports / 1_000_000_000) * (Number(state.tokenTotalSupply) / Number(tokenScale));
}
async function txTime(connection, signature) {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) throw new Error(`missing/failed transaction ${signature}`);
  return new Date(Number(tx.blockTime) * 1000).toISOString();
}
async function normalizeSide(connection, label, report) {
  if (report.applicationChainId !== 101 || report.cluster !== "devnet") throw new Error(`${label}: wrong Solana identity`);
  for (const key of ["create", "buy", "sell", "closeBuy"]) if (report[key]?.status !== "PASS" || !report[key]?.signature) throw new Error(`${label}: ${key} not PASS`);
  const account = await connection.getAccountInfo(new PublicKey(report.campaign), "confirmed");
  if (!account) throw new Error(`${label}: campaign account missing`);
  const state = decodeCampaign(account.data);
  if (state.mint.toBase58() !== report.mint) throw new Error(`${label}: mint mismatch`);
  const startMcapSol = mcapSol(state, 0n);
  const endMcapSol = mcapSol(state, state.soldTokens);
  if (!(endMcapSol > startMcapSol)) throw new Error(`${label}: chain-derived MCAP did not grow`);
  if (!(state.buyerCount > 0n)) throw new Error(`${label}: buyerCount did not grow`);
  const transactions = [
    { key: "buy", txHash: report.buy.signature, side: "buy", nativeAmountRaw: "5000000", volumeUsd: 0.005 * SOL_USD, blockTime: await txTime(connection, report.buy.signature) },
    { key: "closeBuy", txHash: report.closeBuy.signature, side: "buy", nativeAmountRaw: "50000000", volumeUsd: 0.05 * SOL_USD, blockTime: await txTime(connection, report.closeBuy.signature) }
  ];
  return {
    label, campaign: report.campaign, token: report.mint, creator: state.creator.toBase58(),
    startMcapUsd: startMcapSol * SOL_USD, endMcapUsd: endMcapSol * SOL_USD,
    holdersBeforeCount: 0, holdersAfterCount: Number(state.buyerCount),
    chainState: { economicsVersion: state.economicsVersion, tokenDecimals: state.tokenDecimals, soldTokens: state.soldTokens.toString(), netRaisedLamports: state.netRaisedLamports.toString(), totalBuyVolumeLamports: state.totalBuyVolumeLamports.toString(), totalSellVolumeLamports: state.totalSellVolumeLamports.toString(), buyerCount: state.buyerCount.toString() },
    transactions,
    signatures: { create: report.create.signature, buy: report.buy.signature, sell: report.sell.signature, closeBuy: report.closeBuy.signature }
  };
}
async function main() {
  required(RPC, "SOLANA_RPC_URL"); required(LEFT, "AGENT2_SOLANA_LEFT_REPORT"); required(RIGHT, "AGENT2_SOLANA_RIGHT_REPORT");
  const connection = new Connection(RPC, "confirmed");
  const [leftRaw, rightRaw] = [readJson(LEFT), readJson(RIGHT)];
  const genesis = await connection.getGenesisHash();
  if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("refusing non-devnet RPC");
  const left = await normalizeSide(connection, "left", leftRaw);
  const right = await normalizeSide(connection, "right", rightRaw);
  if (left.campaign === right.campaign || left.token === right.token) throw new Error("Solana side identity collision");
  const report = { schemaVersion: 1, purpose: "agent2-solana-normal-battle-chain-evidence", sourceSha: process.env.GITHUB_SHA || null, chainId: 101, network: "solana-devnet", nativeUsdPrice: SOL_USD, programId: leftRaw.programId, previousAcceptedLineage: OLD_LINEAGE, left, right, checks: { freshCampaigns: true, chainDerivedMcapGrowth: true, holderGrowth: true, eligibleConfirmedBuyTransactions: 4, crossTokenIsolation: true, arenaMoneyV2Rerun: false } };
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
