#!/usr/bin/env node
/**
 * Fund the throwaway wallets in ~/mwz-browser/wallets.json from the test deployers, or sweep them back.
 *   node funds.mjs fund | sweep | balances
 * EVM: only chains 46630 / 97 (chain id read from the RPC before any send). Solana: only devnet (genesis).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const HOME = os.homedir();
const MAIN = process.env.MWZ_MAIN_REPO || "/mnt/e/network/Zakelijk/MemeWarzone";
const WORK = process.env.MWZ_BROWSER_WORK || path.join(HOME, "mwz-browser");
const env = Object.fromEntries(
  fs.readFileSync(path.join(MAIN, ".env"), "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);
const heliusKey = (fs.readFileSync(path.join(MAIN, "frontend/.env.local"), "utf8").match(/SOLANA_RPC_URL=.*api-key=([^&"\s]+)/) || [])[1];
const SOL_RPC = process.env.MWZ_DEVNET_RPC || (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.devnet.solana.com");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const wallets = JSON.parse(fs.readFileSync(path.join(WORK, "wallets.json"), "utf8"));
const ledgerFile = path.join(WORK, "funds-ledger.json");
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : { txs: [] };
const save = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));

const CHAINS = {
  46630: { rpc: "https://rpc.testnet.chain.robinhood.com", wallets: { creator: "0.02", buyer: "0.02", graduator: "0.004", creator2: "0.003" } },
  97: { rpc: env.BSC_TESTNET_RPC, wallets: { creator97: "0.012", buyer97: "0.008" } },
};
const SOL_FUND = { creator: 0.4, trader: 0.3 };

async function evmProvider(id) {
  const p = new ethers.JsonRpcProvider(CHAINS[id].rpc, undefined, { staticNetwork: true });
  const reported = Number(await p.send("eth_chainId", []));
  if (reported !== Number(id)) throw new Error(`RPC for ${id} reports ${reported}: refused`);
  return p;
}
async function solConn() {
  const c = new Connection(SOL_RPC, "confirmed");
  if ((await c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("not devnet: refused");
  return c;
}
const solDeployer = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(HOME, ".config/memewarzone/solana-devnet/deployer.json"), "utf8"))));

async function balances() {
  for (const id of Object.keys(CHAINS)) {
    const p = await evmProvider(id);
    const dep = new ethers.Wallet(env.PRIVATE_KEY_DEPLOY);
    console.log(id, "deployer", ethers.formatEther(await p.getBalance(dep.address)));
    for (const [n, w] of Object.entries(wallets.evm)) console.log(id, n, w.address, ethers.formatEther(await p.getBalance(w.address)));
  }
  const c = await solConn();
  console.log("devnet deployer", (await c.getBalance(solDeployer().publicKey)) / LAMPORTS_PER_SOL);
  for (const [n, w] of Object.entries(wallets.sol)) console.log("devnet", n, w.address, (await c.getBalance(new PublicKey(w.address))) / LAMPORTS_PER_SOL);
}

async function fund() {
  for (const [id, cfg] of Object.entries(CHAINS)) {
    const p = await evmProvider(id);
    const dep = new ethers.Wallet(env.PRIVATE_KEY_DEPLOY, p);
    for (const [name, amt] of Object.entries(cfg.wallets)) {
      const to = wallets.evm[name].address;
      if ((await p.getBalance(to)) >= ethers.parseEther(amt) / 2n) continue;
      const tx = await dep.sendTransaction({ to, value: ethers.parseEther(amt), chainId: BigInt(id) });
      await tx.wait(1);
      ledger.txs.push({ kind: "fund", chainId: Number(id), to, amount: amt, hash: tx.hash });
      save();
      console.log(`funded ${name} ${amt} on ${id}: ${tx.hash}`);
    }
  }
  const c = await solConn();
  const dep = solDeployer();
  for (const [name, sol] of Object.entries(SOL_FUND)) {
    const to = new PublicKey(wallets.sol[name].address);
    if ((await c.getBalance(to)) >= (sol * LAMPORTS_PER_SOL) / 2) continue;
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: dep.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [dep]);
    ledger.txs.push({ kind: "fund", chain: "devnet", to: to.toBase58(), amount: sol, sig });
    save();
    console.log(`funded ${name} ${sol} SOL: ${sig}`);
  }
}

async function sweep() {
  for (const id of Object.keys(CHAINS)) {
    const p = await evmProvider(id);
    const back = new ethers.Wallet(env.PRIVATE_KEY_DEPLOY).address;
    for (const [name, w] of Object.entries(wallets.evm)) {
      const wal = new ethers.Wallet(w.pk, p);
      const bal = await p.getBalance(wal.address);
      const fee = await p.getFeeData();
      const gasPrice = (fee.gasPrice ?? 0n) * 2n;
      // Robinhood (Arbitrum Nitro) charges L1 data on top of 21000, so estimate instead of assuming it.
      const est = await p.estimateGas({ from: wal.address, to: back, value: 1n }).catch(() => 21000n);
      const gasLimit = (est * 3n) / 2n;
      const cost = gasLimit * gasPrice;
      if (bal <= cost * 2n) continue;
      const tx = await wal.sendTransaction({ to: back, value: bal - cost, gasLimit, gasPrice, chainId: BigInt(id) });
      await tx.wait(1);
      ledger.txs.push({ kind: "sweep", chainId: Number(id), from: wal.address, amount: ethers.formatEther(bal - cost), hash: tx.hash });
      save();
      console.log(`swept ${name} ${ethers.formatEther(bal - cost)} on ${id}: ${tx.hash}`);
    }
  }
  const c = await solConn();
  const dep = solDeployer();
  for (const [name, w] of Object.entries(wallets.sol)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(w.secret));
    const bal = await c.getBalance(kp.publicKey);
    if (bal <= 10_000) continue;
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dep.publicKey, lamports: bal - 5000 })), [kp]);
    ledger.txs.push({ kind: "sweep", chain: "devnet", from: kp.publicKey.toBase58(), lamports: bal - 5000, sig });
    save();
    console.log(`swept ${name} ${(bal - 5000) / LAMPORTS_PER_SOL} SOL: ${sig}`);
  }
}

const cmd = process.argv[2] || "balances";
if (cmd === "fund") await fund();
else if (cmd === "sweep") await sweep();
await balances();
