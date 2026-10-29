#!/usr/bin/env node
// Read-only audit: which imported tokens would pass the graduation hard rule (founder 2026-10-29) today.
// Existing imports are NOT changed by the rule; this only reports. It runs the same checks a new import gets.
//
// Usage: node frontend/scripts/audit-import-graduation.mjs <list.json|list.csv>
//   list: JSON array of {chain_id, token_address, symbol?} or CSV with header chain_id,token_address[,symbol]
//   RPCs come from exported SOLANA_RPC_URL / BNB_RPC_URL / ROBINHOOD_RPC_URL (no env file is read);
//   without them public endpoints are used (Solana's public RPC refuses some reads; results say "retry").
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "ethers";

process.env.ENABLE_PROJECT_IMPORT_ROBINHOOD ||= "true";
process.env.SOLANA_RPC_URL ||= "https://api.mainnet-beta.solana.com";
process.env.BNB_RPC_URL ||= "https://bsc-dataseed.bnbchain.org";
process.env.ROBINHOOD_RPC_URL ||= "https://rpc.mainnet.chain.robinhood.com";

const { registerDefaultProjectImportResolvers } = await import("../api/lib/projectImportResolverAdapters.js");
const { resolveProjectToken } = await import("../api/lib/projectImportResolvers.js");
const { robinhoodGraduationProof } = await import("../api/lib/projectImportRobinhoodGraduation.js");
registerDefaultProjectImportResolvers();

function readList(path) {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return JSON.parse(text);
  const [header, ...rows] = text.split(/\r?\n/);
  const cols = header.split(",").map((c) => c.trim());
  return rows.map((row) => Object.fromEntries(row.split(",").map((v, i) => [cols[i], v.trim()])));
}

const list = readList(process.argv[2]);
const robinhood = new JsonRpcProvider(process.env.ROBINHOOD_RPC_URL, 4663, { staticNetwork: true });
const results = [];
for (const item of list) {
  const chainId = Number(item.chain_id ?? item.chainId);
  const token = String(item.token_address ?? item.tokenAddress);
  let proof;
  try {
    proof = chainId === 4663
      ? await robinhoodGraduationProof({ provider: robinhood, token })
      : (await resolveProjectToken({ chainId, tokenAddress: token, signedWallet: chainId === 101 ? "11111111111111111111111111111111" : "0x0000000000000000000000000000000000000001", registrationOnly: true })).graduationProof;
  } catch (error) {
    proof = { proven: false, reason: `lookup_failed: ${error?.code || error?.message}`, retryable: true };
  }
  const row = { chainId, token, symbol: item.symbol || "", proven: proof?.proven === true, detail: proof?.proven ? proof.method + (proof.venue ? ` (${proof.venue})` : "") : proof?.reason || "no proof", retry: Boolean(proof?.retryable) };
  results.push(row);
  console.log(`${String(chainId).padEnd(5)} ${row.symbol.padEnd(12)} ${row.proven ? "GRADUATED  " : row.retry ? "RETRY      " : "NOT PROVEN "} ${row.detail}  ${token}`);
}
const failing = results.filter((r) => !r.proven && !r.retry);
console.log(`\n${results.length} checked: ${results.filter((r) => r.proven).length} graduated, ${failing.length} not proven, ${results.filter((r) => r.retry).length} to retry.`);
