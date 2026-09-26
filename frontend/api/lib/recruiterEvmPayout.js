/**
 * EVM recruiter payouts (2026-09-26): a recruiter's claimable BNB / Robinhood ETH earnings are paid by
 * RecruiterRewardsVault.payout(to, amount) (contracts/RecruiterRewardsVault.sol), signed by the
 * vault's operator key RECRUITER_PAYOUT_OPERATOR_PK. The vault's own controls bound the key: the
 * Safe (vault admin) sets the operator, maxPayoutPerTx and dailyPayoutCap and can pause it.
 *
 * Nothing is shrunk: a claim above a cap is refused with the reason and stays claimable.
 * Every amount paid is a sum of the chain's own recruiter slices (creditRecruiterEarnings), which the
 * router sent into this same vault, so the vault always holds at least what it owes.
 */
import { ethers } from "ethers";

const VAULT_ABI = [
  "function operator() view returns (address)",
  "function payoutsPaused() view returns (bool)",
  "function maxPayoutPerTx() view returns (uint256)",
  "function dailyPayoutCap() view returns (uint256)",
  "function dailySpent() view returns (uint256)",
  "function lastDay() view returns (uint256)",
  "function payout(address payable to, uint256 amount)",
];

const MAINNET_VAULTS = {
  56: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
  4663: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
};

export function recruiterEvmChainId(chain) {
  if (chain === "bnb") return Number(process.env.RECRUITER_BNB_CHAIN_ID || 56);
  if (chain === "robinhood") return Number(process.env.RECRUITER_ROBINHOOD_CHAIN_ID || 4663);
  return 0;
}

function vaultAddress(chainId) {
  const configured = String(process.env[`RECRUITER_REWARDS_VAULT_ADDRESS_${chainId}`] || "").trim();
  return configured || MAINNET_VAULTS[chainId] || "";
}

function rpcUrl(chainId) {
  const perChain = String(process.env[`ROBINHOOD_RPC_HTTP_${chainId}`] || process.env[`BSC_RPC_HTTP_${chainId}`] || process.env[`VITE_PUBLIC_RPC_${chainId}`] || "").trim();
  if (perChain) return perChain.split(",")[0].trim();
  if (chainId === 4663) return String(process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
  if (chainId === 46630) return String(process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com").trim();
  if (chainId === 56) return String(process.env.BSC_RPC_HTTP || "https://bsc-dataseed.binance.org").trim();
  return "";
}

function operatorWallet(provider) {
  const pk = String(process.env.RECRUITER_PAYOUT_OPERATOR_PK || "").trim();
  if (!pk) return null;
  return new ethers.Wallet(pk, provider);
}

function contractFor(chain) {
  const chainId = recruiterEvmChainId(chain);
  const address = vaultAddress(chainId);
  const url = rpcUrl(chainId);
  if (!chainId || !address || !url) throw Object.assign(new Error(`Recruiter payouts are not configured for ${chain}.`), { code: "RECRUITER_PAYOUT_NOT_CONFIGURED" });
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
  const wallet = operatorWallet(provider);
  if (!wallet) throw Object.assign(new Error("Recruiter payouts are not switched on yet (no operator key)."), { code: "RECRUITER_PAYOUT_NOT_CONFIGURED" });
  return { chainId, address, provider, wallet, vault: new ethers.Contract(address, VAULT_ABI, wallet) };
}

/** Every reason a payout of `amountRaw` would revert, checked before any DB state changes. */
export async function preflightRecruiterPayout(chain, amountRaw) {
  const { chainId, address, provider, wallet, vault } = contractFor(chain);
  const amount = BigInt(amountRaw);
  const [operator, paused, maxPerTx, dailyCap, dailySpent, lastDay, balance] = await Promise.all([
    vault.operator(), vault.payoutsPaused(), vault.maxPayoutPerTx(), vault.dailyPayoutCap(), vault.dailySpent(), vault.lastDay(), provider.getBalance(address),
  ]);
  const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
  const spentToday = BigInt(lastDay) === today ? BigInt(dailySpent) : 0n;
  const refuse = (code, message) => Object.assign(new Error(message), { code });
  if (String(operator).toLowerCase() !== wallet.address.toLowerCase()) throw refuse("RECRUITER_PAYOUT_NOT_CONFIGURED", "Recruiter payouts are not switched on yet for this chain.");
  if (paused) throw refuse("RECRUITER_PAYOUT_PAUSED", "Recruiter payouts are paused on this chain.");
  if (amount > BigInt(maxPerTx)) throw refuse("RECRUITER_PAYOUT_ABOVE_CAP", "This claim is above the vault's per-payout cap; it stays claimable until the cap is raised.");
  if (spentToday + amount > BigInt(dailyCap)) throw refuse("RECRUITER_PAYOUT_DAILY_CAP", "Today's payout cap is reached; your claim stays claimable, try again tomorrow.");
  if (amount > BigInt(balance)) throw refuse("RECRUITER_PAYOUT_VAULT_SHORT", "The recruiter vault cannot cover this claim yet; it stays claimable.");
  return { chainId, address };
}

/** Broadcasts the payout. Throws before broadcast if anything is wrong; returns the tx once sent. */
export async function sendRecruiterPayout(chain, recipient, amountRaw) {
  const { chainId, address, vault } = contractFor(chain);
  const tx = await vault.payout(ethers.getAddress(recipient), BigInt(amountRaw));
  return { chainId, vaultAddress: address, tx };
}
