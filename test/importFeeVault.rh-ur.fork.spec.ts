/**
 * CO-IMP rev 2 CI3 proof on a local anvil fork of Robinhood 4663: imported-coin swaps through Uniswap's Universal Router
 * 0x88767899 with the command list of frontend/src/lib/robinhoodImportSwap.mjs and PAY_PORTION at 100 bps to an
 * ImportFeeVault deployed on this fork by scripts/deploy-import-fee-vault.ts (IF1 executed as the impersonated Safe).
 *
 * robinhoodImportSwap.mjs hard-codes the bps (IMPORT_SWAP_FEE_BPS = 50 inside encodeImportBuy / encodeImportSell /
 * importSwapFee), so the 100 bps call is assembled here from the module's exported pieces (encodeV3SwapExactIn,
 * encodeV3Path, resolveImportPool, minimumOut-style math) with the module's command bytes, and the test proves it is
 * the module's own output for feeReceiver = vault with ONLY the PAY_PORTION bps word (and, on sells, the SWEEP minimum
 * derived from it) changed. Proven to the wei, against quotes taken from the same state:
 *   buy:  PAY_PORTION before the swap: ONE vault Deposit, from = Universal Router, of value * 100 / 10_000; tokens ==
 *         QuoterV2(value - fee); minTokensOut = that passes, + 1 reverts
 *   sell: PAY_PORTION after UNWRAP_WETH: ONE vault Deposit, from = Universal Router, of gross * 100 / 10_000 (gross ==
 *         QuoterV2); the wallet gets gross - fee; SWEEP minimum = gross - fee passes, + 1 reverts (min-out is checked
 *         after the fee)
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
// The module's command bytes and recipient sentinels (robinhoodImportSwap.mjs:24-27; not exported).
const CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, PAY_PORTION: 0x06, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c };
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;
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
const GAS = { gasLimit: 1_500_000n }; // anvil's estimate on this fork came out short once (OOG at the last PAY_PORTION hop)

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
    expect(m.IMPORT_SWAP_FEE_BPS).to.equal(50); // today's module value: CI3 changes it
    ({ vault, vaultAddress, operator } = await deployVaultOnFork(4663));
    route = await m.resolveImportPool(ethers.provider, TOKEN);
    expect(route, "no WETH V3 pool for the token").to.not.equal(null);
    let symbol = "?";
    try { symbol = await new ethers.Contract(TOKEN, ERC20_ABI, ethers.provider).symbol(); } catch {}
    results.token = `${symbol} ${TOKEN} pool ${route.pool} fee tier ${route.fee}`;
    // PAY_PORTION takes a share of the router's whole ETH balance: it must start empty for the fee to be 1% of value.
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    wallet = await freshWallet("2");
  });

  after(() => {
    for (const [k, v] of Object.entries(results)) console.log(`      ${k}: ${v}`);
  });

  function buyCall(amountInWei: bigint, minTokensOut: bigint) {
    return {
      commands: ethers.hexlify(Uint8Array.from([CMD.PAY_PORTION, CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN])),
      inputs: [
        coder.encode(["address", "address", "uint256"], [ETH, vaultAddress, BPS]),
        coder.encode(["address", "uint256"], [ADDRESS_THIS, CONTRACT_BALANCE]),
        m.encodeV3SwapExactIn(MSG_SENDER, CONTRACT_BALANCE, minTokensOut, m.encodeV3Path(m.WETH_4663, route.fee, TOKEN), false),
      ],
      value: amountInWei,
    };
  }

  function sellCall(amountIn: bigint, minGross: bigint, minNet: bigint, permit: any) {
    return {
      commands: ethers.hexlify(Uint8Array.from([CMD.PERMIT2_PERMIT, CMD.V3_SWAP_EXACT_IN, CMD.UNWRAP_WETH, CMD.PAY_PORTION, CMD.SWEEP])),
      inputs: [
        coder.encode(["tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)", "bytes"], [permit.permitSingle, permit.signature]),
        m.encodeV3SwapExactIn(ADDRESS_THIS, amountIn, minGross, m.encodeV3Path(TOKEN, route.fee, m.WETH_4663), true),
        coder.encode(["address", "uint256"], [ADDRESS_THIS, minGross]),
        coder.encode(["address", "address", "uint256"], [ETH, vaultAddress, BPS]),
        coder.encode(["address", "address", "uint256"], [ETH, MSG_SENDER, minNet]),
      ],
      value: 0n,
    };
  }

  /** The module's sellPermit (not exported), same typed data. */
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

  it("the 100 bps command list is the module's own, with only the PAY_PORTION bps (and the SWEEP minimum) changed", async function () {
    const mod = m.encodeImportBuy({ token: TOKEN, fee: route.fee, amountInWei: 10n ** 16n, minTokensOut: 123n, feeReceiver: vaultAddress });
    const mine = buyCall(10n ** 16n, 123n);
    expect(mine.commands).to.equal(mod.commands);
    expect(mine.inputs.slice(1)).to.deep.equal(mod.inputs.slice(1));
    expect(coder.decode(["address", "address", "uint256"], mod.inputs[0]).map(String)).to.deep.equal([ETH, vaultAddress, "50"]);
    expect(coder.decode(["address", "address", "uint256"], mine.inputs[0]).map(String)).to.deep.equal([ETH, vaultAddress, "100"]);
    const permit = { permitSingle: { details: { token: TOKEN, amount: 5n, expiration: 1n, nonce: 0n }, spender: m.UNIVERSAL_ROUTER_4663, sigDeadline: 1n }, signature: "0x" + "11".repeat(65) };
    const minGross = 10_000_000n;
    const modSell = m.encodeImportSell({ token: TOKEN, fee: route.fee, amountIn: 5n, minGrossEthOut: minGross, permit, feeReceiver: vaultAddress });
    const mineSell = sellCall(5n, minGross, minGross - (minGross * BPS) / 10_000n, permit);
    expect(mineSell.commands).to.equal(modSell.commands);
    expect(mineSell.inputs.slice(0, 3)).to.deep.equal(modSell.inputs.slice(0, 3));
    expect(coder.decode(["address", "address", "uint256"], modSell.inputs[3]).map(String)).to.deep.equal([ETH, vaultAddress, "50"]);
    expect(coder.decode(["address", "address", "uint256"], mineSell.inputs[3]).map(String)).to.deep.equal([ETH, vaultAddress, "100"]);
    expect(modSell.minNetEthOut).to.equal(minGross - (minGross * 50n) / 10_000n);
    expect(coder.decode(["address", "address", "uint256"], mineSell.inputs[4])[2]).to.equal(minGross - (minGross * 100n) / 10_000n);
  });

  it("buy: PAY_PORTION before the swap, one Deposit from the Universal Router of exactly 1% of the ETH in", async function () {
    const value = ethers.parseEther("0.01");
    const fee = (value * BPS) / 10_000n;
    const expected = await quote(m.WETH_4663, TOKEN, value - fee);
    const ur = new ethers.Contract(m.UNIVERSAL_ROUTER_4663, ROUTER_ABI, wallet);
    const tooMuch = buyCall(value, expected + 1n);
    await expectRevertWith(ur.execute.staticCall(tooMuch.commands, tooMuch.inputs, await deadline(), { value }), "V3TooLittleReceived()");
    const call = buyCall(value, expected);
    const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, ethers.provider);
    const t0 = await erc20.balanceOf(wallet.address);
    const b0 = await ethers.provider.getBalance(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const rc = await (await ur.execute(call.commands, call.inputs, await deadline(), { value, ...GAS })).wait();
    expect(rc.status).to.equal(1);
    const got = (await erc20.balanceOf(wallet.address)) - t0;
    expect(got).to.equal(expected);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(m.UNIVERSAL_ROUTER_4663.toLowerCase());
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    expect(b0 - (await ethers.provider.getBalance(wallet.address))).to.equal(value + gasCost(rc));
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    results.buy = `value ${value}, vault Deposit ${fee} from ${deposits[0].from}, tokens ${got} == QuoterV2(${value - fee}), min ${expected} ok / ${expected + 1n} reverts, gas ${rc.gasUsed}`;
  });

  it("sell: PAY_PORTION after UNWRAP_WETH, one Deposit of exactly 1% of the gross; SWEEP minimum checked after the fee", async function () {
    const erc20 = new ethers.Contract(TOKEN, ERC20_ABI, wallet);
    const amountIn = (await erc20.balanceOf(wallet.address)) / 2n;
    await (await erc20.approve(m.PERMIT2, amountIn)).wait();
    const gross = await quote(TOKEN, m.WETH_4663, amountIn);
    const fee = (gross * BPS) / 10_000n;
    const net = gross - fee;
    const ur = new ethers.Contract(m.UNIVERSAL_ROUTER_4663, ROUTER_ABI, wallet);
    const permit = await signPermit(amountIn);
    const tooMuch = sellCall(amountIn, gross, net + 1n, permit);
    await expectRevertWith(ur.execute.staticCall(tooMuch.commands, tooMuch.inputs, await deadline()), "InsufficientETH()");
    const call = sellCall(amountIn, gross, net, permit);
    const b0 = await ethers.provider.getBalance(wallet.address);
    const t0 = await erc20.balanceOf(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const estimate = await ur.execute.estimateGas(call.commands, call.inputs, await deadline()).catch((e: any) => `estimate failed: ${e?.shortMessage || e}`);
    const rc = await (await ur.execute(call.commands, call.inputs, await deadline(), GAS)).wait();
    results.sellGas = `eth_estimateGas ${estimate}, used ${rc.gasUsed}`;
    expect(rc.status).to.equal(1);
    expect(t0 - (await erc20.balanceOf(wallet.address))).to.equal(amountIn);
    const received = (await ethers.provider.getBalance(wallet.address)) - b0 + gasCost(rc);
    expect(received).to.equal(net);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(m.UNIVERSAL_ROUTER_4663.toLowerCase());
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    expect(await ethers.provider.getBalance(m.UNIVERSAL_ROUTER_4663)).to.equal(0n);
    results.sell = `tokens ${amountIn}, gross ${gross} == QuoterV2, vault Deposit ${fee} from ${deposits[0].from}, wallet ${net}, SWEEP min ${net} ok / ${net + 1n} reverts, gas ${rc.gasUsed}`;
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
