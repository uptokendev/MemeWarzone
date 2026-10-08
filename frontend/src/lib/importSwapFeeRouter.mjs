/**
 * BNB imports that only trade on Topaz and have no KyberSwap route (always on testnet 97, where Kyber
 * does not exist; on 56 Kyber routes Topaz V2 / V3 itself since 2026-10-08): the swap goes
 * through ImportSwapFeeRouter (contracts/integrations/ImportSwapFeeRouter.sol, CO-IMP rev 2 CI4), so
 * an import swap never runs without the fee. The router takes its fee in BNB inside the swap and pays
 * it to the ImportFeeVault (deployment: protocolBps 100, creatorBps 0, both receivers = the vault);
 * half of it is the coin creator's, split afterwards by the finance ledger and the payout worker.
 *   buyV2(token, stable, minTokensOut, recipient, deadline) payable
 *       fee = value * bps / 10_000 stays with the router, value - fee is swapped on Topaz; minTokensOut is
 *       checked on the recipient's token delta.
 *   sellV2(token, stable, amountIn, minNativeOut, recipient, deadline)
 *       pulls amountIn (exact approval to the router), swaps on Topaz, fee = gross * bps / 10_000;
 *       minNativeOut is checked on gross - fee.
 * The router fixes the Topaz factory (v2Router.defaultFactory()); the coin's pool must be on it.
 * No router configured (VITE_IMPORT_SWAP_FEE_ROUTER_<chainId>): no trade. Never the fee-free Topaz swap.
 * Imported tokens only; our launchpad coins and their post-graduation trading never come through here.
 * Plain ESM so node tests and the fork proof run the same code as the app.
 */
import { Contract, Interface, ethers } from "ethers";

export const IMPORT_SWAP_FEE_ROUTER_CHAINS = Object.freeze([56, 97]);
/** Shown when no fee-taking route exists (no Kyber route and no fee router / Topaz pool): no trade. */
export const NO_IMPORT_SWAP_ROUTE = "No DEX route for this coin";

/** The functions and the event of ImportSwapFeeRouter the app uses (checked against src/abi/ImportSwapFeeRouter.json by the tests). */
export const IMPORT_SWAP_FEE_ROUTER_ABI = Object.freeze([
  "function buyV2(address token, bool stable, uint256 minTokensOut, address recipient, uint256 deadline) payable returns (uint256 tokensOut)",
  "function sellV2(address token, bool stable, uint256 amountIn, uint256 minNativeOut, address recipient, uint256 deadline) returns (uint256 nativeOut)",
  "function protocolBps() view returns (uint256)",
  "function creatorBps() view returns (uint256)",
  "function wrappedNative() view returns (address)",
  "function v2Router() view returns (address)",
  "function v2Factory() view returns (address)",
  "function deployedChainId() view returns (uint256)",
  "event ImportSwap(address indexed trader, address indexed token, uint8 venue, bool isBuy, uint256 nativeGross, uint256 feeProtocol, uint256 feeCreator, uint256 tokenAmount, address recipient)",
]);
const routerInterface = new Interface(IMPORT_SWAP_FEE_ROUTER_ABI);
const TOPAZ_QUOTE_ABI = ["function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)"];
const ERC20_ABI = ["function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)"];
const DEADLINE_SECONDS = 10 * 60;

function moduleEnv() {
  let vite = {};
  try {
    vite = import.meta.env || {};
  } catch {
    vite = {};
  }
  const node = typeof process !== "undefined" && process?.env ? process.env : {};
  return { ...node, ...vite };
}

/** The router for this chain from VITE_IMPORT_SWAP_FEE_ROUTER_<chainId> (56 / 97), or null. */
export function importSwapFeeRouterAddress(chainId, env = moduleEnv()) {
  const id = Number(chainId);
  if (!IMPORT_SWAP_FEE_ROUTER_CHAINS.includes(id)) return null;
  const raw = String(env?.[`VITE_IMPORT_SWAP_FEE_ROUTER_${id}`] ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(raw) && raw !== ethers.ZeroAddress ? ethers.getAddress(raw) : null;
}

function bpsMin(amount, slippageBps) {
  const bps = BigInt(Math.max(0, Math.min(5000, Math.floor(Number(slippageBps) || 0))));
  return (BigInt(amount) * (10_000n - bps)) / 10_000n;
}

/** Buy: the contract's fee on msg.value (floor(value * bps / 10_000)) and what is swapped. */
export function feeRouterBuyAmounts(value, feeBps) {
  const v = BigInt(value);
  const fee = (v * BigInt(feeBps)) / 10_000n;
  return { fee, swapIn: v - fee };
}

/** Sell: the contract's fee on the swap's native out and what the recipient gets. */
export function feeRouterSellAmounts(gross, feeBps) {
  const g = BigInt(gross);
  const fee = (g * BigInt(feeBps)) / 10_000n;
  return { fee, net: g - fee };
}

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const addr = (a) => ethers.getAddress(String(a || "").toLowerCase());

/** The router's immutables, read from chain. */
export async function readImportSwapFeeRouter(provider, routerAddress) {
  const router = new Contract(addr(routerAddress), IMPORT_SWAP_FEE_ROUTER_ABI, provider);
  const [protocolBps, creatorBps, wrappedNative, v2Router, v2Factory] = await Promise.all([
    router.protocolBps(), router.creatorBps(), router.wrappedNative(), router.v2Router(), router.v2Factory(),
  ]);
  const feeBps = Number(protocolBps) + Number(creatorBps);
  if (!(feeBps > 0)) throw new Error("Import fee router has no fee.");
  return { address: addr(routerAddress), feeBps, wrappedNative: String(wrappedNative), v2Router: String(v2Router), v2Factory: String(v2Factory) };
}

/** Throws unless the coin's resolved Topaz route is on the router's Topaz router, factory and wrapped BNB. */
export function assertRouteOnFeeRouter(info, resolved) {
  if (!same(info.v2Router, resolved.routerAddress) || !same(info.v2Factory, resolved.factoryAddress) || !same(info.wrappedNative, resolved.wrappedNativeAddress)) {
    throw new Error(NO_IMPORT_SWAP_ROUTE);
  }
}

function stableOf(resolved) {
  return Boolean(resolved?.route?.[0]?.stable ?? resolved?.market?.stable ?? false);
}

/**
 * Quote a Topaz-only import trade through the fee router. Buy: tokens out for value - fee, minimum after
 * slippage on the tokens. Sell: gross native for amountIn, fee on the gross, minimum after slippage on
 * gross - fee (the contract checks the minimum after its fee).
 */
export async function quoteFeeRouterTrade({ provider, routerAddress, resolved, side, amountIn, slippageBps = 100, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const info = await readImportSwapFeeRouter(provider, routerAddress);
  assertRouteOnFeeRouter(info, resolved);
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  const token = addr(resolved.tokenAddress);
  const stable = stableOf(resolved);
  const topaz = new Contract(info.v2Router, TOPAZ_QUOTE_ABI, provider);
  const leg = (from, to) => [{ from, to, stable, factory: info.v2Factory }];
  const base = { provider: "import-swap-fee-router", routerAddress: info.address, token, stable, side, amountIn: amount, slippageBps, feeBps: info.feeBps, creatorShareBps: Math.floor(info.feeBps / 2), deadline: BigInt(nowSeconds + DEADLINE_SECONDS) };
  if (side === "buy") {
    const { fee, swapIn } = feeRouterBuyAmounts(amount, info.feeBps);
    if (fee <= 0n || swapIn <= 0n) throw new Error("Amount too small.");
    const amounts = await topaz.getAmountsOut(swapIn, leg(info.wrappedNative, token));
    const out = BigInt(amounts[amounts.length - 1]);
    const minOut = bpsMin(out, slippageBps);
    if (minOut <= 0n) throw new Error("Amount too small.");
    return { ...base, feeWei: fee, amountOut: out, minOut };
  }
  const amounts = await topaz.getAmountsOut(amount, leg(token, info.wrappedNative));
  const gross = BigInt(amounts[amounts.length - 1]);
  const { fee, net } = feeRouterSellAmounts(gross, info.feeBps);
  const minOut = bpsMin(net, slippageBps);
  if (fee <= 0n || minOut <= 0n) throw new Error("Amount too small.");
  return { ...base, feeWei: fee, grossOut: gross, amountOut: net, minOut };
}

/** The router call for a quote: { to, data, value }. */
export function buildFeeRouterCall(quote, recipient) {
  const to = addr(quote.routerAddress);
  if (quote.side === "buy") {
    return { to, value: BigInt(quote.amountIn), data: routerInterface.encodeFunctionData("buyV2", [quote.token, quote.stable, quote.minOut, recipient, quote.deadline]) };
  }
  return { to, value: 0n, data: routerInterface.encodeFunctionData("sellV2", [quote.token, quote.stable, quote.amountIn, quote.minOut, recipient, quote.deadline]) };
}

/** Sign and send; a sell first approves exactly the amount to the router (no standing allowance). Returns the tx hash. */
export async function executeFeeRouterTrade({ signer, account, quote }) {
  const owner = account || (await signer.getAddress());
  if (quote.side === "sell") {
    const erc20 = new Contract(addr(quote.token), ERC20_ABI, signer);
    const allowance = BigInt(await erc20.allowance(owner, addr(quote.routerAddress)));
    if (allowance < BigInt(quote.amountIn)) {
      const approval = await signer.sendTransaction({ to: addr(quote.token), data: erc20.interface.encodeFunctionData("approve", [addr(quote.routerAddress), quote.amountIn]) });
      const approved = await approval.wait();
      if (!approved || Number(approved.status) !== 1) throw new Error("Approval reverted.");
    }
  }
  const call = buildFeeRouterCall(quote, owner);
  // The estimate plus 20%: on a BSC fork the router buy ran out of gas at exactly the node's estimate.
  const estimate = await signer.estimateGas({ ...call, from: owner });
  const tx = await signer.sendTransaction({ ...call, gasLimit: (BigInt(estimate) * 12n) / 10n });
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error("Swap transaction reverted.");
  return tx.hash;
}
