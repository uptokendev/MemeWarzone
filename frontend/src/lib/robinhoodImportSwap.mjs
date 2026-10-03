/**
 * Imported-token swaps on Robinhood Chain mainnet through Uniswap's Universal Router, with the same
 * 0.5% platform fee BNB and Solana imports pay (founder, 2026-10-03). The fee is taken in ETH inside
 * the one swap transaction and paid to the Robinhood ProtocolRevenueVault:
 *   buy:  PAY_PORTION(ETH 0.5% of msg.value -> vault), WRAP_ETH(rest), V3_SWAP_EXACT_IN(WETH -> token, to you)
 *   sell: [PERMIT2_PERMIT], V3_SWAP_EXACT_IN(token -> WETH, to router), UNWRAP_WETH, PAY_PORTION(ETH 0.5% -> vault),
 *         SWEEP(ETH -> you, at least the quoted minimum after the fee)
 * Imported tokens only. Our own Robinhood coins never come through here.
 * Plain ESM so the app and the fork rehearsal (scripts/rehearse-robinhood-import-swap.mjs) run the same code.
 */
import { AbiCoder, Contract, ethers } from "ethers";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const IMPORT_SWAP_FEE_BPS = 50;
// developers.uniswap.org, Robinhood Chain deployments; code verified on chain 2026-10-03.
export const UNIVERSAL_ROUTER_4663 = ethers.getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const WETH_4663 = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const QUOTER_V2_4663 = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const V3_FACTORY_4663 = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
/** Robinhood ProtocolRevenueVault (capped protocol wallet, overflow to the Safe); accepts plain ETH. */
export const IMPORT_SWAP_FEE_RECEIVER_4663 = "0x632061cA786f7B585Bbd46A792FDA92B02f70671";

const CMD = Object.freeze({ V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, PAY_PORTION: 0x06, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c });
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;
const ETH = ethers.ZeroAddress;
const FEE_TIERS = [500, 3000, 10000];
const DEADLINE_SECONDS = 20 * 60;
const PERMIT_SECONDS = 30 * 60;
const MAX_UINT160 = (1n << 160n) - 1n;
const coder = AbiCoder.defaultAbiCoder();

const ROUTER_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const QUOTER_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = ["function liquidity() view returns (uint128)"];
const ERC20_ABI = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const PERMIT2_ABI = ["function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)"];

export function importSwapFee(amount, feeBps = IMPORT_SWAP_FEE_BPS) {
  return (BigInt(amount) * BigInt(feeBps)) / 10_000n;
}

export function minimumOut(amount, slippageBps) {
  const bps = BigInt(Math.max(0, Math.min(5000, Math.floor(Number(slippageBps) || 0))));
  return (BigInt(amount) * (10_000n - bps)) / 10_000n;
}

export function encodeV3Path(tokenIn, fee, tokenOut) {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

/**
 * V3_SWAP_EXACT_IN on the deployed router (Sourcify-verified source, 2026-10-03) decodes six fields:
 * (recipient, amountIn, amountOutMin, path, payerIsUser, uint256[] minHopPriceX36). The empty array
 * turns the per-hop price check off; amountOutMin still bounds the whole swap. Encoding only the
 * older five fields makes the router read past the input (SliceOutOfBounds, or garbage when the
 * input happens to be last), so the sixth field is always written.
 */
export function encodeV3SwapExactIn(recipient, amountIn, amountOutMin, path, payerIsUser) {
  return coder.encode(["address", "uint256", "uint256", "bytes", "bool", "uint256[]"], [recipient, amountIn, amountOutMin, path, payerIsUser, []]);
}

function commandBytes(list) {
  return ethers.hexlify(Uint8Array.from(list));
}

/** Buy: the fee comes off the ETH you send; the rest is swapped and the tokens go to you. */
export function encodeImportBuy({ token, fee, amountInWei, minTokensOut, feeReceiver = IMPORT_SWAP_FEE_RECEIVER_4663, weth = WETH_4663 }) {
  return {
    commands: commandBytes([CMD.PAY_PORTION, CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN]),
    inputs: [
      coder.encode(["address", "address", "uint256"], [ETH, feeReceiver, IMPORT_SWAP_FEE_BPS]),
      coder.encode(["address", "uint256"], [ADDRESS_THIS, CONTRACT_BALANCE]),
      encodeV3SwapExactIn(MSG_SENDER, CONTRACT_BALANCE, BigInt(minTokensOut), encodeV3Path(weth, fee, token), false),
    ],
    value: BigInt(amountInWei),
  };
}

/**
 * Sell: the tokens are swapped to WETH held by the router, unwrapped, 0.5% of the ETH goes to the
 * vault and the rest is swept to you; SWEEP reverts if you would get less than minEthOut.
 */
export function encodeImportSell({ token, fee, amountIn, minGrossEthOut, permit = null, feeReceiver = IMPORT_SWAP_FEE_RECEIVER_4663, weth = WETH_4663 }) {
  const minGross = BigInt(minGrossEthOut);
  const minNet = minGross - importSwapFee(minGross);
  const commands = [];
  const inputs = [];
  if (permit) {
    commands.push(CMD.PERMIT2_PERMIT);
    inputs.push(coder.encode(
      ["tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)", "bytes"],
      [permit.permitSingle, permit.signature],
    ));
  }
  commands.push(CMD.V3_SWAP_EXACT_IN, CMD.UNWRAP_WETH, CMD.PAY_PORTION, CMD.SWEEP);
  inputs.push(
    encodeV3SwapExactIn(ADDRESS_THIS, BigInt(amountIn), minGross, encodeV3Path(token, fee, weth), true),
    coder.encode(["address", "uint256"], [ADDRESS_THIS, minGross]),
    coder.encode(["address", "address", "uint256"], [ETH, feeReceiver, IMPORT_SWAP_FEE_BPS]),
    coder.encode(["address", "address", "uint256"], [ETH, MSG_SENDER, minNet]),
  );
  return { commands: commandBytes(commands), inputs, value: 0n, minNetEthOut: minNet };
}

/** The import's deepest Uniswap V3 pool against WETH, or null. */
export async function resolveImportPool(provider, token, { factory = V3_FACTORY_4663, weth = WETH_4663 } = {}) {
  if (!ethers.isAddress(token)) return null;
  const f = new Contract(factory, FACTORY_ABI, provider);
  let best = null;
  for (const fee of FEE_TIERS) {
    const pool = String(await f.getPool(token, weth, fee));
    if (!pool || pool === ethers.ZeroAddress) continue;
    const liquidity = BigInt(await new Contract(pool, POOL_ABI, provider).liquidity().catch(() => 0n));
    if (!best || liquidity > best.liquidity) best = { pool: ethers.getAddress(pool), fee, liquidity };
  }
  return best;
}

async function quoteSingle(provider, tokenIn, tokenOut, fee, amountIn) {
  const quoter = new Contract(QUOTER_V2_4663, QUOTER_ABI, provider);
  const [out] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
  return BigInt(out);
}

/** Quote in the panel's preview shape; amountOut is what you receive after the fee. */
export async function quoteImportSwap4663({ provider, token, side, amountIn, slippageBps = 100 }) {
  const route = await resolveImportPool(provider, token);
  if (!route) throw new Error("No Uniswap V3 pool with ETH for this token.");
  const amount = BigInt(amountIn);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  if (side === "buy") {
    const fee = importSwapFee(amount);
    const out = await quoteSingle(provider, WETH_4663, token, route.fee, amount - fee);
    return { route, side, amountIn: amount, feeWei: fee, amountOut: out, minOut: minimumOut(out, slippageBps), slippageBps };
  }
  const gross = await quoteSingle(provider, token, WETH_4663, route.fee, amount);
  const fee = importSwapFee(gross);
  return { route, side, amountIn: amount, feeWei: fee, grossOut: gross, amountOut: gross - fee, minOut: minimumOut(gross, slippageBps), slippageBps };
}

/**
 * Sells pull the token through Permit2: a one-time ERC20 approval to Permit2 (exact amount), then a
 * signed, gasless permit for exactly this sell that expires in 30 minutes, sent inside the swap.
 */
async function sellPermit(signer, owner, token, amountIn, chainId) {
  const erc20 = new Contract(token, ERC20_ABI, signer);
  if (BigInt(await erc20.allowance(owner, PERMIT2)) < amountIn) {
    const approval = await erc20.approve(PERMIT2, amountIn);
    await approval.wait();
  }
  const [, , nonce] = await new Contract(PERMIT2, PERMIT2_ABI, signer).allowance(owner, token, UNIVERSAL_ROUTER_4663);
  if (amountIn > MAX_UINT160) throw new Error("Sell amount is too large.");
  const now = Math.floor(Date.now() / 1000);
  const permitSingle = {
    details: { token, amount: amountIn, expiration: BigInt(now + PERMIT_SECONDS), nonce: BigInt(nonce) },
    spender: UNIVERSAL_ROUTER_4663,
    sigDeadline: BigInt(now + PERMIT_SECONDS),
  };
  const signature = await signer.signTypedData(
    { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    {
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    permitSingle,
  );
  return { permitSingle, signature };
}

/** Signs and sends one import swap on chain 4663; returns the confirmed receipt. */
export async function executeImportSwap4663({ signer, quote, chainId = ROBINHOOD_MAINNET_CHAIN_ID, token }) {
  const owner = await signer.getAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  const router = new Contract(UNIVERSAL_ROUTER_4663, ROUTER_ABI, signer);
  let call;
  if (quote.side === "buy") {
    call = encodeImportBuy({ token, fee: quote.route.fee, amountInWei: quote.amountIn, minTokensOut: quote.minOut });
  } else {
    const permit = await sellPermit(signer, owner, token, quote.amountIn, chainId);
    call = encodeImportSell({ token, fee: quote.route.fee, amountIn: quote.amountIn, minGrossEthOut: quote.minOut, permit });
  }
  const tx = await router.execute(call.commands, call.inputs, deadline, { value: call.value });
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error("Swap transaction reverted.");
  return receipt;
}
