/**
 * Rehearses the Robinhood import swap (Universal Router + 0.5% fee) on an anvil fork of Robinhood
 * mainnet with a local test wallet: a real buy and a real sell through src/lib/robinhoodImportSwap.mjs,
 * checked against the balances that moved. Never sends to mainnet.
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547 &
 *   FORK_RPC=http://127.0.0.1:8547 node scripts/rehearse-robinhood-import-swap.mjs [token]
 */
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import {
  IMPORT_SWAP_FEE_RECEIVER_4663,
  executeImportSwap4663,
  importSwapFee,
  quoteImportSwap4663,
} from "../src/lib/robinhoodImportSwap.mjs";

const rpc = process.env.FORK_RPC || "http://127.0.0.1:8547";
const token = process.argv[2] || "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C"; // stand-in with a WETH V3 pool
const provider = new JsonRpcProvider(rpc);
const net = await provider.getNetwork();
if (Number(net.chainId) !== 4663) throw new Error(`expected a fork of chain 4663, got ${net.chainId}`);
const head = await provider.getBlockNumber();
const live = await new JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com").getBlockNumber();
if (!(await provider.send("anvil_nodeInfo", []).catch(() => null))) throw new Error("FORK_RPC is not an anvil node; refusing");
console.log(`fork of 4663 at block ${head} (live ${live})`);

// A throwaway wallet, funded on the fork only.
const wallet = Wallet.createRandom().connect(provider);
await provider.send("anvil_setBalance", [wallet.address, "0x" + parseEther("1").toString(16)]);
const erc20 = new Contract(token, ["function balanceOf(address) view returns (uint256)"], provider);
// The vault forwards ETH on receive(), so its balance never moves: read the fee off the trace.
async function feePaid(hash) {
  const trace = await provider.send("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
  let total = 0n;
  const walk = (call) => {
    if (String(call.to || "").toLowerCase() === IMPORT_SWAP_FEE_RECEIVER_4663.toLowerCase() && call.value) total += BigInt(call.value);
    for (const child of call.calls || []) walk(child);
  };
  walk(trace);
  return total;
}
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// BUY 0.01 ETH
const buyIn = parseEther("0.01");
const qb = await quoteImportSwap4663({ provider, token, side: "buy", amountIn: buyIn });
const t0 = await erc20.balanceOf(wallet.address);
const e0 = await provider.getBalance(wallet.address);
const rb = await executeImportSwap4663({ signer: wallet, quote: qb, token });
const t1 = await erc20.balanceOf(wallet.address);
const e1 = await provider.getBalance(wallet.address);
const gasB = rb.gasUsed * rb.gasPrice;
const feeB = await feePaid(rb.hash);
check("buy: vault received exactly 0.5% of the ETH in", feeB === importSwapFee(buyIn), `${formatEther(feeB)} ETH`);
check("buy: wallet paid the amount in plus gas, nothing else", e0 - e1 === buyIn + gasB);
check("buy: tokens received >= quoted minimum", t1 - t0 >= qb.minOut, `${t1 - t0} vs min ${qb.minOut} (quoted ${qb.amountOut})`);
console.log(`buy gas ${rb.gasUsed}`);

// SELL half of what was bought (first sell: ERC20 approve to Permit2 + signed permit)
const sellIn = (t1 - t0) / 2n;
const qs = await quoteImportSwap4663({ provider, token, side: "sell", amountIn: sellIn });
const e2 = await provider.getBalance(wallet.address);
const t2 = await erc20.balanceOf(wallet.address);
const rs = await executeImportSwap4663({ signer: wallet, quote: qs, token });
const e3 = await provider.getBalance(wallet.address);
const t3 = await erc20.balanceOf(wallet.address);
const fee = await feePaid(rs.hash);
// wallet ETH delta excludes gas of the approve + swap; recompute: received = e3 - e2 + gas paid
const blockTxs = [];
for (let b = rb.blockNumber + 1; b <= rs.blockNumber; b += 1) {
  const block = await provider.getBlock(b, true);
  for (const tx of block.prefetchedTransactions) if (tx.from === wallet.address) blockTxs.push(await provider.getTransactionReceipt(tx.hash));
}
const gasS = blockTxs.reduce((sum, r) => sum + r.gasUsed * r.gasPrice, 0n);
const received = e3 - e2 + gasS;
const gross = received + fee;
check("sell: tokens left the wallet, exactly the amount sold", t2 - t3 === sellIn);
check("sell: vault received 0.5% of the gross ETH out", fee === importSwapFee(gross), `${formatEther(fee)} ETH of ${formatEther(gross)}`);
check("sell: wallet received >= quoted minimum after fee", received >= qs.minOut - importSwapFee(qs.minOut), `${formatEther(received)} ETH`);
check("sell: approvals + swap took 2 transactions (approve to Permit2, swap)", blockTxs.length === 2, `${blockTxs.length}`);

console.log(failed ? `REHEARSAL FAILED (${failed})` : "REHEARSAL PASS");
process.exit(failed ? 1 : 0);
