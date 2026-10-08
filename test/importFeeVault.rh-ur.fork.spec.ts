/**
 * CO-IMP rev 2 CI3 proof on a local anvil fork of Robinhood 4663: imported-coin swaps through Uniswap's Universal Router
 * 0x88767899 run by frontend/src/lib/robinhoodImportSwap.mjs itself (quoteImportSwap4663 + executeImportSwap4663, the
 * code the app runs), with the switch set the CI3 way in-process: IMPORT_FEE_VAULT_4663 = IMPORT_SWAP_FEE_RECEIVER_4663 =
 * an ImportFeeVault deployed on this fork by scripts/deploy-import-fee-vault.ts (IF1 executed as the impersonated Safe).
 * The module then produces PAY_PORTION at 100 bps to the vault by itself. Proven to the wei, against quotes taken from
 * the same state:
 *   buy:  PAY_PORTION before the swap: ONE vault Deposit, from = Universal Router, of value * 100 / 10_000; tokens ==
 *         QuoterV2(value - fee); minTokensOut = that passes (the module's own call), + 1 reverts
 *   sell: PAY_PORTION after UNWRAP_WETH: ONE vault Deposit, from = Universal Router, of gross * 100 / 10_000 (gross ==
 *         QuoterV2); the wallet gets gross - fee; the module's SWEEP minimum (gross - fee) passes, + 1 reverts (min-out
 *         is checked after the fee; the + 1 call is the module's encodeImportSell with only the SWEEP word raised)
 *   gas:  executeImportSwap4663 sends estimate * 1.2 (one earlier run went out of gas at exactly the estimate)
 * Then the operator sweeps to the real Robinhood ProtocolRevenueVault with payout(). Nothing is sent to Robinhood Chain.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8646 --accounts 0 --no-rate-limit
 *   npx hardhat test test/importFeeVault.rh-ur.fork.spec.ts --network robinhoodForkRehearsal
 * The public RPC keeps ~5,000 blocks of state, so run it right after starting anvil. IMPORT_FEE_RH_TOKEN overrides the
 * coin (default HOODFUN 0xfbeD2D06; the live rehearsal's stand-in 0x117cc213 also passes).
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, gasCost, rpc, vaultDeposits } from "./helpers/importFeeVaultFork";

// HOODFUN, a Robinhood memecoin with a 1% WETH V3 pool (1.2 WETH deep on 2026-10-08, found from the V3 factory's
// PoolCreated logs). 0x117cc213 (SPY, the live rehearsal's stand-in) passes the same proof.
const TOKEN = ethers.getAddress(process.env.IMPORT_FEE_RH_TOKEN || "0xfbed2d0698b3140358816969789559745efe600d");
const PROTOCOL_REVENUE_VAULT_4663 = "0x632061cA786f7B585Bbd46A792FDA92B02f70671";
const BPS = 100n;
// The module's command bytes and recipient sentinels (robinhoodImportSwap.mjs, not exported), for the checks only.
const CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, PAY_PORTION: 0x06, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c };
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ETH = ethers.ZeroAddress;
const coder = ethers.AbiCoder.defaultAbiCoder();
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

const ROUTER_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const QUOTER_ABI = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"];
const PERMIT2_ABI = ["function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)"];

/** The Universal Router custom error a call reverts with (V3TooLittleReceived on the swap, InsufficientETH on SWEEP). */
async function expectRevertWith(promise: Promise<unknown>, signature: string) {
  const selector = ethers.id(signature).slice(0, 10);
  try {
    await promise;
  } catch (error: any) {
    const data = String(error?.data ?? error?.info?.error?.data ?? error?.error?.data ?? "");
    expect(data.slice(0, 10), `${signature} expected, got ${data || error?.shortMessage || error}`).to.equal(selector);
    return;
  }
  throw new Error(`expected a revert with ${signature}`);
}

const d = network.name === "robinhoodForkRehearsal" ? describe : describe.skip;

d("CI3: Robinhood Universal Router import swaps pay exactly 1% to ImportFeeVault (4663 fork, real V3 pool)", function () {
  this.timeout(900_000);
  let m: any;
  let vault: any;
  let vaultAddress: string;
  let operator: string;
  let route: { pool: string; fee: number; liquidity: bigint };
  let wallet: any;
  const results: Record<string, string> = {};
  const deadline = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 1200);
  const quote = async (tokenIn: string, tokenOut: string, amountIn: bigint) => {
    const q = new ethers.Contract(m.QUOTER_V2_4663, QUOTER_ABI, ethers.provider);
    const [out] = await q.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n });
    return BigInt(out);
  };

  before(async function () {
    const fork = await assertLocalFork(4663);
    console.log(`      fork of 4663 at block ${fork.forkBlock}`);
    m = await esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", "src", "lib", "robinhoodImportSwap.mjs")).href);
    expect(m.activeImportSwapFeeTerms4663().feeBps).to.equal(50); // switch off until the env names the vault
    ({ vault, vaultAddress, operator } = await deployVaultOnFork(4663));
    route = await m.resolveImportPool(ethers.provider, TOKEN);
    expect(route, "no WETH V3 pool for the token").to.not.equal(null);
    let symbol = "?";
    try { symbol = await new ethers.Contract(TOKEN, ERC20_ABI, ethers.provider).symbol(); } catch {}
    results.token = `${symbol} ${TOKEN} pool ${route.pool} fee tier ${route.fee}`;
    // PAY_PORTION takes a share of the router's whole ETH balance: it must start empty for the fee to be 1% of value.
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    wallet = await freshWallet("2");
    // The CI3 switch, read by the module at call time.
    process.env.IMPORT_FEE_VAULT_4663 = vaultAddress;
    process.env.IMPORT_SWAP_FEE_RECEIVER_4663 = vaultAddress;
    const terms = m.activeImportSwapFeeTerms4663();
    expect(terms).to.deep.equal({ feeBps: 100, feeReceiver: ethers.getAddress(vaultAddress), creatorShareBps: 50, split: true });
  });

  after(() => {
    delete process.env.IMPORT_FEE_VAULT_4663;
    delete process.env.IMPORT_SWAP_FEE_RECEIVER_4663;
    for (const [k, v] of Object.entries(results)) console.log(`      ${k}: ${v}`);
  });

  /** The module's sellPermit (not exported), same typed data; only for the + 1 revert check. */
  async function signPermit(amount: bigint) {
    const [, , nonce] = await new ethers.Contract(m.PERMIT2, PERMIT2_ABI, ethers.provider).allowance(wallet.address, TOKEN, m.UNIVERSAL_ROUTER_4663);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const permitSingle = { details: { token: TOKEN, amount, expiration: BigInt(now + 1800), nonce: BigInt(nonce) }, spender: m.UNIVERSAL_ROUTER_4663, sigDeadline: BigInt(now + 1800) };
    const signature = await wallet.signTypedData(
      { name: "Permit2", chainId: 4663, verifyingContract: m.PERMIT2 },
      {
        PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      },
      permitSingle,
    );
    return { permitSingle, signature };
  }

  it("the module's own calls carry PAY_PORTION 100 bps to the vault; command lists unchanged", async function () {
    const buy = m.encodeImportBuy({ token: TOKEN, fee: route.fee, amountInWei: 10n ** 16n, minTokensOut: 123n });
    expect(buy.commands).to.equal(ethers.hexlify(Uint8Array.from([CMD.PAY_PORTION, CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN])));
    expect(coder.decode(["address", "address", "uint256"], buy.inputs[0]).map(String)).to.deep.equal([ETH, ethers.getAddress(vaultAddress), "100"]);
    const permit = { permitSingle: { details: { token: TOKEN, amount: 5n, expiration: 1n, nonce: 0n }, spender: m.UNIVERSAL_ROUTER_4663, sigDeadline: 1n }, signature: "0x" + "11".repeat(65) };
    const minGross = 10_000_000n;
    const sell = m.encodeImportSell({ token: TOKEN, fee: route.fee, amountIn: 5n, minGrossEthOut: minGross, permit });
    expect(sell.commands).to.equal(ethers.hexlify(Uint8Array.from([CMD.PERMIT2_PERMIT, CMD.V3_SWAP_EXACT_IN, CMD.UNWRAP_WETH, CMD.PAY_PORTION, CMD.SWEEP])));
    expect(coder.decode(["address", "address", "uint256"], sell.inputs[3]).map(String)).to.deep.equal([ETH, ethers.getAddress(vaultAddress), "100"]);
    expect(sell.minNetEthOut).to.equal(minGross - (minGross * BPS) / 10_000n);
    expect(coder.decode(["address", "address", "uint256"], sell.inputs[4])[2]).to.equal(minGross - (minGross * BPS) / 10_000n);
  });

  it("buy: PAY_PORTION before the swap, one Deposit from the Universal Router of exactly 1% of the ETH in", async function () {
    const value = ethers.parseEther("0.01");
    const fee = (value * BPS) / 10_000n;
    const expected = await quote(m.WETH_4663, TOKEN, value - fee);
    // The module's quote at 0 slippage: its minimum is exactly the QuoterV2 output.
    const q = await m.quoteImportSwap4663({ provider: ethers.provider, token: TOKEN, side: "buy", amountIn: value, slippageBps: 0 });
    expect(q.feeBps).to.equal(100);
    expect(q.creatorShareBps).to.equal(50);
    expect(q.feeWei).to.equal(fee);
    expect(q.minOut).to.equal(expected);
    const ur = new ethers.Contract(m.UNIVERSAL_ROUTER_4663, ROUTER_ABI, wallet);
    const tooMuch = m.encodeImportBuy({ token: TOKEN, fee: route.fee, amountInWei: value, minTokensOut: expected + 1n });
    await expectRevertWith(ur.execute.staticCall(tooMuch.commands, tooMuch.inputs, await deadline(), { value }), "V3TooLittleReceived()");
    const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, ethers.provider);
    const t0 = await erc20.balanceOf(wallet.address);
    const b0 = await ethers.provider.getBalance(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const rc = await m.executeImportSwap4663({ signer: wallet, quote: q, token: TOKEN });
    expect(Number(rc.status)).to.equal(1);
    const tx = await ethers.provider.getTransaction(rc.hash);
    const got = (await erc20.balanceOf(wallet.address)) - t0;
    expect(got).to.equal(expected);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(m.UNIVERSAL_ROUTER_4663.toLowerCase());
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    expect(b0 - (await ethers.provider.getBalance(wallet.address))).to.equal(value + gasCost(rc));
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    results.buy = `value ${value}, vault Deposit ${fee} from ${deposits[0].from}, tokens ${got} == QuoterV2(${value - fee}), min ${expected} ok / ${expected + 1n} reverts, gas used ${rc.gasUsed} of limit ${tx!.gasLimit}`;
  });

  it("sell: PAY_PORTION after UNWRAP_WETH, one Deposit of exactly 1% of the gross; SWEEP minimum checked after the fee", async function () {
    const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, wallet);
    const amountIn = (await erc20.balanceOf(wallet.address)) / 2n;
    const gross = await quote(TOKEN, m.WETH_4663, amountIn);
    const fee = (gross * BPS) / 10_000n;
    const net = gross - fee;
    const q = await m.quoteImportSwap4663({ provider: ethers.provider, token: TOKEN, side: "sell", amountIn, slippageBps: 0 });
    expect(q.grossOut).to.equal(gross);
    expect(q.feeWei).to.equal(fee);
    expect(q.amountOut).to.equal(net);
    // + 1 on the SWEEP minimum (the module's call with only that word raised) reverts after the fee.
    await (await erc20.approve(m.PERMIT2, amountIn)).wait();
    const ur = new ethers.Contract(m.UNIVERSAL_ROUTER_4663, ROUTER_ABI, wallet);
    const permit = await signPermit(amountIn);
    const tooMuch = m.encodeImportSell({ token: TOKEN, fee: route.fee, amountIn, minGrossEthOut: gross, permit });
    expect(tooMuch.minNetEthOut).to.equal(net);
    tooMuch.inputs[4] = coder.encode(["address", "address", "uint256"], [ETH, MSG_SENDER, net + 1n]);
    await expectRevertWith(ur.execute.staticCall(tooMuch.commands, tooMuch.inputs, await deadline()), "InsufficientETH()");
    const b0 = await ethers.provider.getBalance(wallet.address);
    const t0 = await erc20.balanceOf(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const rc = await m.executeImportSwap4663({ signer: wallet, quote: q, token: TOKEN });
    expect(Number(rc.status)).to.equal(1);
    const tx = await ethers.provider.getTransaction(rc.hash);
    expect(t0 - (await erc20.balanceOf(wallet.address))).to.equal(amountIn);
    // The approval to Permit2 already covers the amount, so the module sends only the swap.
    const received = (await ethers.provider.getBalance(wallet.address)) - b0 + gasCost(rc);
    expect(received).to.equal(net);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(m.UNIVERSAL_ROUTER_4663.toLowerCase());
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    results.sell = `tokens ${amountIn}, gross ${gross} == QuoterV2, vault Deposit ${fee} from ${deposits[0].from}, wallet ${net}, SWEEP min ${net} ok / ${net + 1n} reverts, gas used ${rc.gasUsed} of limit ${tx!.gasLimit}`;
  });

  it("operator sweeps to the real Robinhood ProtocolRevenueVault with payout()", async function () {
    const bal = await ethers.provider.getBalance(vaultAddress);
    const half = bal / 2n;
    await rpc("anvil_impersonateAccount", [operator]);
    await rpc("anvil_setBalance", [operator, ethers.toQuantity(ethers.parseEther("1"))]);
    const op = await ethers.getSigner(operator);
    const prv = await ethers.getContractAt("ProtocolRevenueVault", PROTOCOL_REVENUE_VAULT_4663);
    const rc = await (await vault.connect(op).payout(PROTOCOL_REVENUE_VAULT_4663, half)).wait();
    const prvDeposits = vaultDeposits(prv, rc);
    expect(prvDeposits.length).to.equal(1);
    expect(prvDeposits[0].from.toLowerCase()).to.equal(vaultAddress.toLowerCase());
    expect(prvDeposits[0].amount).to.equal(half);
    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(bal - half);
    results.sweep = `payout(ProtocolRevenueVault, ${half}) -> its Deposit(from = vault, ${half})`;
  });
});
