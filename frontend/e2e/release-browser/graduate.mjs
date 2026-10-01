#!/usr/bin/env node
/** E4: call graduate() on a pending generation-5 campaign from a third wallet (the local keeper runs dry). */
import { ethers } from "ethers";
import { RPC, wallets } from "./browser.mjs";
const [campaign, chainArg = "46630", who = "graduator"] = process.argv.slice(2);
const chainId = Number(chainArg);
if (chainId !== 46630 && chainId !== 97) throw new Error("test chains only");
const p = new ethers.JsonRpcProvider(RPC[chainId], undefined, { staticNetwork: true });
if (Number(await p.send("eth_chainId", [])) !== chainId) throw new Error("rpc chain mismatch");
const w = new ethers.Wallet(wallets.evm[who].pk, p);
const c = new ethers.Contract(campaign, ["function graduate()", "function graduationPending() view returns (bool)", "function launched() view returns (bool)", "event Graduated(address pool,uint256 raise,uint256 protocolShare,uint256 creatorShare,uint256 poolNative,uint256 memeUsed,uint256 memeBurned,uint256 curvePrice,uint256 startPrice,bool repaired)"], w);
console.log("pending", await c.graduationPending(), "launched", await c.launched());
const tx = await c.graduate({ gasLimit: 12_000_000n });
const r = await tx.wait(1);
const ev = r.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Graduated");
console.log(JSON.stringify({ tx: tx.hash, status: r.status, from: w.address, graduated: ev ? Object.fromEntries(Object.entries(ev.args.toObject()).map(([k, v]) => [k, String(v)])) : null }, null, 1));
