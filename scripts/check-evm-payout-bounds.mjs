#!/usr/bin/env node
/**
 * Every payout bound on BNB (56) and Robinhood (4663), read from chain and expressed in DOLLARS.
 * Read-only; sends nothing. Exits 1 if any bound is absurd.
 *
 * Why (2026-09-27): both MonthlyLeagueTreasury vaults were deployed with monthlyCapUsd = 30000 raw.
 * The contract's unit is 18-decimal USD, so the cap was 38 / 11 wei. The setup scripts, the deploy
 * rehearsal and the P1 read-back all checked that a cap was *set*, never what it was *worth*. This
 * checks what it is worth: each bound is priced through the chain's own oracle and must sit between
 * $1 and $1,000,000. A unit mistake lands 18 orders of magnitude outside that window.
 *
 *   node scripts/check-evm-payout-bounds.mjs            # both chains
 *   MONTHLY_LEAGUE_TREASURY_56=0x.. node scripts/...    # check a replacement vault instead
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { ethers } = require("ethers");

const WAD = 10n ** 18n;
const MIN_USD = 1n;
const MAX_USD = 1_000_000n;

const CHAINS = {
  56: {
    rpc: process.env.BSC_RPC_HTTP_56 || "https://bsc-dataseed.binance.org",
    native: "BNB",
    oracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    monthly: process.env.MONTHLY_LEAGUE_TREASURY_56 || "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    protocol: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
  },
  4663: {
    rpc: process.env.ROBINHOOD_RPC_HTTP_4663 || "https://rpc.mainnet.chain.robinhood.com",
    native: "ETH",
    oracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    monthly: process.env.MONTHLY_LEAGUE_TREASURY_4663 || "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
  },
};

const fmtUsd = (v) => `$${v.toLocaleString("en-US")}`;
let failures = 0;

function judge(label, usd, detail) {
  const ok = usd >= MIN_USD && usd <= MAX_USD;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${fmtUsd(usd).padStart(16)}   ${detail}`);
}

async function read(contract, fn) {
  try {
    return BigInt(await contract[fn]());
  } catch {
    return null;
  }
}

for (const [chainId, chain] of Object.entries(CHAINS)) {
  const network = ethers.Network.from(Number(chainId));
  const provider = new ethers.JsonRpcProvider(chain.rpc, network, { staticNetwork: network, batchMaxCount: 1 });
  const price = BigInt(await new ethers.Contract(chain.oracle, ["function nativeUsdPrice() view returns (uint256)"], provider).nativeUsdPrice());
  const nativeToUsd = (wei) => (wei * price) / WAD / WAD;
  console.log(`\nchain ${chainId}: ${chain.native} = $${ethers.formatEther(price)} (oracle ${chain.oracle})`);

  // Monthly league: a USD cap in 18 decimals, priced by the contract as cap * 1e18 / price.
  const monthly = new ethers.Contract(chain.monthly, ["function monthlyCapUsd() view returns (uint256)"], provider);
  const capUsd = await read(monthly, "monthlyCapUsd");
  if (capUsd === null) { failures += 1; console.log(`  FAIL monthly league ${chain.monthly}: monthlyCapUsd unreadable`); }
  else {
    const capNative = (capUsd * WAD + price - 1n) / price;
    judge(`monthly league cap`, nativeToUsd(capNative), `${ethers.formatEther(capNative)} ${chain.native} (${chain.monthly})`);
  }

  // Protocol vault operator fill: USD in 18 decimals, plus the price it books with.
  const protocol = new ethers.Contract(chain.protocol, ["function operatorFillCapUsd() view returns (uint256)", "function nativeUsdPrice() view returns (uint256)"], provider);
  const fillCap = await read(protocol, "operatorFillCapUsd");
  if (fillCap !== null) judge("protocol operator fill cap", fillCap / WAD, `raw ${fillCap}`);
  const bookedPrice = await read(protocol, "nativeUsdPrice");
  if (bookedPrice !== null) judge("protocol vault booked price", bookedPrice / WAD, `oracle says $${ethers.formatEther(price)}`);

  // Native-denominated caps.
  const native = [
    ["weekly league max claim / tx", chain.weekly, "maxClaimPerTx"],
    ["weekly league max epoch total", chain.weekly, "maxEpochTotal"],
    ["recruiter max payout / tx", chain.recruiter, "maxPayoutPerTx"],
    ["recruiter daily payout cap", chain.recruiter, "dailyPayoutCap"],
  ];
  for (const [label, address, fn] of native) {
    const wei = await read(new ethers.Contract(address, [`function ${fn}() view returns (uint256)`], provider), fn);
    if (wei === null) { console.log(`  n/a  ${label.padEnd(34)} (${address} has no ${fn})`); continue; }
    judge(label, nativeToUsd(wei), `${ethers.formatEther(wei)} ${chain.native}`);
  }
}

console.log(failures ? `\n${failures} bound(s) outside ${fmtUsd(MIN_USD)}..${fmtUsd(MAX_USD)} -- a unit mistake until proven otherwise` : "\nall payout bounds are within $1..$1,000,000");
process.exit(failures ? 1 : 0);
