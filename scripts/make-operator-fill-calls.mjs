#!/usr/bin/env node
/**
 * Print the calls.json for a ProtocolRevenueVault.setOperatorFill Safe batch,
 * with the native/USD price read from the chain's Chainlink feed at build time.
 *
 * Both mainnet vaults carry the $10,000 cap from their constructor but no
 * operator and no overflow treasury (read from chain 2026-09-24), so today
 * nothing is filled and everything sits for the Safe. setOperatorFill arms it:
 * the operator receives protocol revenue until a LIFETIME $10k (usd = amount *
 * nativeUsdPrice / 1e18; operatorFilledUsd never resets), then everything goes
 * to the overflow treasury -- the Safe, mirroring Solana's route.
 *
 *   EVM_OPERATOR=0x... node scripts/make-operator-fill-calls.mjs 56   > /tmp/fill-56.json
 *   EVM_OPERATOR=0x... node scripts/make-operator-fill-calls.mjs 4663 > /tmp/fill-4663.json
 *   npx ts-node scripts/make-safe-batch.ts deployments/bnb/mainnet.V3-operator-fill.safe-batch.json 56 "..." "..." /tmp/fill-56.json
 */
import { ethers } from "ethers";

const CHAINS = {
  56: { rpc: process.env.BSC_RPC_HTTP_56 || "https://bsc-dataseed.binance.org", vault: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c", feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", native: "BNB" },
  4663: { rpc: process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com", vault: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7", native: "ETH" },
};
const chainId = Number(process.argv[2]);
const cfg = CHAINS[chainId];
if (!cfg) { console.error("chain must be 56 or 4663"); process.exit(2); }
const operator = String(process.env.EVM_OPERATOR || "").trim();
if (!ethers.isAddress(operator) || operator === ethers.ZeroAddress) { console.error("EVM_OPERATOR must be the operator wallet (the founder names it); zero would arm nothing"); process.exit(2); }
const capUsd = ethers.parseUnits(process.env.OPERATOR_CAP_USD || "10000", 18);

const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: true });
const feed = new ethers.Contract(cfg.feed, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"], provider);
const vault = new ethers.Contract(cfg.vault, ["function admin() view returns (address)", "function operator() view returns (address)", "function operatorFillCapUsd() view returns (uint256)", "function nativeUsdPrice() view returns (uint256)"], provider);
const [dec, round, admin, currentOperator, currentCap, currentPrice] = await Promise.all([feed.decimals(), feed.latestRoundData(), vault.admin(), vault.operator(), vault.operatorFillCapUsd(), vault.nativeUsdPrice()]);
const [, answer, , updatedAt] = round;
const ageSec = Math.floor(Date.now() / 1000) - Number(updatedAt);
if (answer <= 0n) { console.error("feed answer <= 0"); process.exit(1); }
const priceWad = (BigInt(answer) * 10n ** 18n) / 10n ** BigInt(dec);
if (ethers.getAddress(admin) !== ethers.getAddress(cfg.safe)) { console.error(`vault admin is ${admin}, not the Safe -- the batch would be refused on chain`); process.exit(1); }

console.error(`[operator-fill] chain ${chainId}  vault ${cfg.vault}  admin ${admin} (Safe)`);
console.error(`[operator-fill] today: operator ${currentOperator}  cap ${ethers.formatUnits(currentCap, 18)} USD  price ${ethers.formatUnits(currentPrice, 18)}`);
console.error(`[operator-fill] feed ${cfg.native}/USD = ${ethers.formatUnits(priceWad, 18)} (${ageSec}s old)  -> nativeUsdPrice ${priceWad}`);
console.error(`[operator-fill] setOperatorFill(operator=${operator}, overflow=${cfg.safe}, capUsd=${capUsd}, nativeUsdPrice=${priceWad})`);
process.stdout.write(JSON.stringify([{ contract: "ProtocolRevenueVault", to: cfg.vault, fn: "setOperatorFill", args: [operator, cfg.safe, capUsd.toString(), priceWad.toString()] }], null, 2) + "\n");
