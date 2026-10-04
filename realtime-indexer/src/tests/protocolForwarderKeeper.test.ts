import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  EVM_DEPLOYER,
  FORWARDER_CHAIN_PINS,
  SAFE,
  decideFlush,
  forwarderKeeperConfig,
  forwarderKeeperWallet,
  newChainStatus,
  protocolForwarderKeeperHealth,
  resetProtocolForwarderKeeperForTests,
  runForwarderTick,
  startProtocolForwarderKeeper,
  withTimeout,
  type ForwarderKeeperConfig,
  type ForwarderReader,
  type ForwarderSender,
} from "../protocolForwarderKeeper.js";

const FWD = "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D";
const E18 = 10n ** 18n;
const silent = () => {};

function cfg(over: Partial<ForwarderKeeperConfig> = {}): ForwarderKeeperConfig {
  return { ...forwarderKeeperConfig({ PROTOCOL_FORWARDER_KEEPER: "send", PROTOCOL_FORWARDER_ADDRESS_56: FWD } as any), ...over };
}

type Calls = { sims: number; sends: number; estimates: number };

function reader(opts: { wrapped?: bigint; native?: bigint; price?: bigint; sink?: string; admin?: string; wrappedNative?: string; hasCode?: boolean; sim?: { ok: boolean; error?: string }; gas?: bigint; gasPrice?: bigint; receipt?: null | { status: number; blockNumber: number }; throwOn?: string; calls?: Calls } = {}): ForwarderReader {
  const pin = FORWARDER_CHAIN_PINS[56];
  const calls = opts.calls ?? { sims: 0, sends: 0, estimates: 0 };
  const maybeThrow = (name: string) => {
    if (opts.throwOn === name) throw new Error(`rpc ${name} failed`);
  };
  return {
    async forwarderIdentity() {
      maybeThrow("identity");
      return { admin: opts.admin ?? SAFE, nativeSink: opts.sink ?? pin.vault, wrappedNative: opts.wrappedNative ?? pin.wrappedNative, hasCode: opts.hasCode ?? true };
    },
    async balances() {
      maybeThrow("balances");
      return { wrapped: opts.wrapped ?? 0n, native: opts.native ?? 0n };
    },
    async vaultNativeUsdPrice() {
      return opts.price ?? 774n * E18;
    },
    async simulateFlush() {
      calls.sims += 1;
      return opts.sim ?? { ok: true };
    },
    async estimateFlushGas() {
      calls.estimates += 1;
      return opts.gas ?? 80_000n;
    },
    async gasPrice() {
      return opts.gasPrice ?? 1_000_000_000n; // 1 gwei: 80k gas = 0.00008 BNB
    },
    async receiptStatus() {
      return opts.receipt === undefined ? { status: 1, blockNumber: 1 } : opts.receipt;
    },
  };
}

function sender(calls: Calls, fail = false): ForwarderSender {
  return {
    address: "0x00000000000000000000000000000000000000aa",
    async sendFlush() {
      calls.sends += 1;
      if (fail) throw new Error("nonce too low");
      return { hash: `0x${String(calls.sends).padStart(64, "0")}` };
    },
  };
}

test("config: off by default; unset addresses skip the chain; bad mode is off", () => {
  const c = forwarderKeeperConfig({} as any);
  assert.equal(c.mode, "off");
  assert.deepEqual(c.chains, []);
  assert.equal(c.intervalMs, 3_600_000);
  assert.equal(c.minFlushUsdWad, E18);
  assert.equal(c.maxGasCostBps, 500n);
  assert.equal(forwarderKeeperConfig({ PROTOCOL_FORWARDER_KEEPER: "yes" } as any).mode, "off");
  const two = forwarderKeeperConfig({ PROTOCOL_FORWARDER_KEEPER: "dry", PROTOCOL_FORWARDER_ADDRESS_4663: FWD.toLowerCase() } as any);
  assert.equal(two.mode, "dry");
  assert.deepEqual(two.chains, [{ chainId: 4663, forwarder: FWD }]);
  assert.throws(() => forwarderKeeperConfig({ PROTOCOL_FORWARDER_ADDRESS_56: "0x123" } as any), /not an address/);
  assert.equal(forwarderKeeperConfig({ PROTOCOL_FORWARDER_KEEPER_INTERVAL_MS: "10" } as any).intervalMs, 60_000);
  assert.equal(forwarderKeeperConfig({ PROTOCOL_FORWARDER_MIN_FLUSH_USD: "2.5" } as any).minFlushUsdWad, 25n * 10n ** 17n);
});

test("disabled by default: start returns false and a tick in off mode reads nothing", async () => {
  resetProtocolForwarderKeeperForTests();
  let made = 0;
  const ok = await startProtocolForwarderKeeper({ env: { PROTOCOL_FORWARDER_ADDRESS_56: FWD } as any, rpcUrl: () => "http://x", makeReader: () => { made += 1; return reader(); } });
  assert.equal(ok, false);
  assert.equal(made, 0);
  assert.equal(protocolForwarderKeeperHealth().mode, "off");
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const s = await runForwarderTick({ chainId: 56, status: newChainStatus(56, FWD), reader: reader({ throwOn: "identity", calls }), sender: sender(calls), cfg: cfg({ mode: "off" }), log: silent });
  assert.equal(s.lastDecision, "off");
  assert.equal(calls.sends, 0);
});

test("key: send needs PROTOCOL_FORWARDER_KEEPER_PK only (no fallback); refuses the deployer and forbidden addresses", async () => {
  assert.equal(forwarderKeeperWallet("dry", { PROTOCOL_FORWARDER_KEEPER_PK: ethers.Wallet.createRandom().privateKey } as any), null);
  assert.throws(() => forwarderKeeperWallet("send", { DEPLOYER_PK: ethers.Wallet.createRandom().privateKey, HARVEST_OPS_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey, EVM_GRADUATION_KEEPER_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey } as any), /needs PROTOCOL_FORWARDER_KEEPER_PK/);
  // The deployer check compares addresses; a real deployer key is never needed: an extra forbidden entry stands in.
  const w = ethers.Wallet.createRandom();
  assert.throws(() => forwarderKeeperWallet("send", { PROTOCOL_FORWARDER_KEEPER_PK: w.privateKey, EVM_KEEPER_FORBIDDEN_ADDRESSES: w.address } as any), /deployer|forbidden/);
  assert.equal(forwarderKeeperWallet("send", { PROTOCOL_FORWARDER_KEEPER_PK: w.privateKey.slice(2) } as any)!.address, w.address);
  assert.equal(EVM_DEPLOYER, "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714");

  resetProtocolForwarderKeeperForTests();
  const ok = await startProtocolForwarderKeeper({ env: { PROTOCOL_FORWARDER_KEEPER: "send", PROTOCOL_FORWARDER_ADDRESS_56: FWD, DEPLOYER_PK: w.privateKey } as any, rpcUrl: () => "http://x", makeReader: () => reader() });
  assert.equal(ok, false);
  assert.match(String(protocolForwarderKeeperHealth().startError), /PROTOCOL_FORWARDER_KEEPER_PK/);
  resetProtocolForwarderKeeperForTests();
});

test("deployer address check is explicit in the source (not only via the shared forbidden list)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../protocolForwarderKeeper.ts", import.meta.url), "utf8");
  assert.match(src, /wallet\.address\.toLowerCase\(\) === EVM_DEPLOYER\.toLowerCase\(\)/);
  assert.doesNotMatch(src, /env\.(DEPLOYER_PK|PRIVATE_KEY_DEPLOY|HARVEST_OPS_PRIVATE_KEY|EVM_GRADUATION_KEEPER_PRIVATE_KEY)/);
});

test("fail closed: wrong sink, wrong admin, wrong wrapped token or no code refuses the chain and never sends", async () => {
  for (const [opts, re] of [
    [{ sink: "0x0000000000000000000000000000000000000001" }, /nativeSink/],
    [{ admin: "0x0000000000000000000000000000000000000002" }, /admin/],
    [{ wrappedNative: "0x0000000000000000000000000000000000000003" }, /wrappedNative/],
    [{ hasCode: false }, /no code/],
  ] as const) {
    const calls = { sims: 0, sends: 0, estimates: 0 };
    const status = newChainStatus(56, FWD);
    const r = reader({ ...opts, wrapped: 10n * E18, calls });
    await runForwarderTick({ chainId: 56, status, reader: r, sender: sender(calls), cfg: cfg(), log: silent });
    assert.match(String(status.refused), re);
    // Stays refused on later ticks, even if the chain now looks right.
    await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: 10n * E18, calls }), sender: sender(calls), cfg: cfg(), log: silent });
    assert.equal(status.lastDecision, "refused");
    assert.equal(calls.sends, 0);
    assert.equal(calls.sims, 0);
  }
});

test("decideFlush: empty, below $ minimum, wei minimum when the vault price is 0, gas fraction", () => {
  const base = { minFlushUsdWad: E18, minFlushWei: 2_000_000_000_000_000n, maxGasCostBps: 500n, gasCostWei: null as bigint | null };
  assert.equal(decideFlush({ ...base, wrapped: 0n, native: 0n, priceWad: 774n * E18 }).kind, "skip");
  const small = decideFlush({ ...base, wrapped: 1_000_000_000_000n, native: 0n, priceWad: 774n * E18 }); // $0.000774
  assert.deepEqual([small.kind, (small as any).reason], ["skip", "below-min-usd"]);
  assert.equal(decideFlush({ ...base, wrapped: 2_000_000_000_000_000n, native: 0n, priceWad: 774n * E18 }).kind, "flush"); // $1.548
  const noPrice = decideFlush({ ...base, wrapped: 1_000_000_000_000_000n, native: 0n, priceWad: 0n });
  assert.deepEqual([noPrice.kind, (noPrice as any).reason], ["skip", "below-min-wei"]);
  const gas = decideFlush({ ...base, wrapped: 2_000_000_000_000_000n, native: 0n, priceWad: 774n * E18, gasCostWei: 200_000_000_000_000n }); // 10% > 5%
  assert.deepEqual([gas.kind, (gas as any).reason], ["skip", "gas-too-expensive"]);
  assert.equal(decideFlush({ ...base, wrapped: 2_000_000_000_000_000n, native: 0n, priceWad: 774n * E18, gasCostWei: 100_000_000_000_000n }).kind, "flush"); // exactly 5%
});

test("below threshold: no static call, no send", async () => {
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const status = newChainStatus(56, FWD);
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: 1_000_000_000n, calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.equal(status.lastDecision, "below-min-usd");
  assert.equal(status.verified, true);
  assert.deepEqual(status.balances, { wrapped: "1000000000", native: "0" });
  assert.deepEqual(calls, { sims: 0, sends: 0, estimates: 0 });
});

test("dry mode: simulates but never sends, even with a sender present", async () => {
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const status = newChainStatus(56, FWD);
  for (let i = 0; i < 3; i++) await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, calls }), sender: sender(calls), cfg: cfg({ mode: "dry" }), log: silent });
  assert.equal(status.lastDecision, "would-flush (dry)");
  assert.equal(calls.sims, 3);
  assert.equal(calls.sends, 0);
  assert.equal(status.lastFlush, null);
});

test("send mode: static call first, one flush per tick, one in flight per chain, receipt recorded", async () => {
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const status = newChainStatus(56, FWD);
  const t0 = new Date("2026-10-05T00:00:00Z");
  // Tick 1: sends.
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, calls }), sender: sender(calls), cfg: cfg(), now: () => t0, log: silent });
  assert.equal(calls.sims, 1);
  assert.equal(calls.sends, 1);
  assert.equal(status.inFlight, status.lastFlush!.txHash);
  assert.equal(status.lastFlush!.status, "pending");
  assert.equal(status.lastFlush!.valueWei, E18.toString());
  // Tick 2: not mined yet -> waits, no second send.
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, receipt: null, calls }), sender: sender(calls), cfg: cfg(), now: () => new Date(t0.getTime() + 60_000), log: silent });
  assert.equal(status.lastDecision, "in-flight");
  assert.equal(calls.sends, 1);
  // Tick 3: mined; the forwarder is empty now -> confirmed, nothing more sent.
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: 0n, receipt: { status: 1, blockNumber: 9 }, calls }), sender: sender(calls), cfg: cfg(), now: () => new Date(t0.getTime() + 120_000), log: silent });
  assert.equal(status.lastFlush!.status, "confirmed");
  assert.equal(status.inFlight, null);
  assert.equal(status.lastDecision, "empty");
  assert.equal(calls.sends, 1);
  // Tick 4: new balance -> exactly one more flush.
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: 2n * E18, calls }), sender: sender(calls), cfg: cfg(), now: () => new Date(t0.getTime() + 180_000), log: silent });
  assert.equal(calls.sends, 2);
  assert.equal(status.flushes, 2);
});

test("send mode: a reverting static call never sends; gas too expensive never sends", async () => {
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const status = newChainStatus(56, FWD);
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, sim: { ok: false, error: "SinkRejected()" }, calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.equal(status.lastDecision, "simulation-reverted");
  assert.match(status.lastError!.message, /SinkRejected/);
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: 2_000_000_000_000_000n, gasPrice: 10_000_000_000_000n, calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.equal(status.lastDecision, "gas-too-expensive");
  assert.equal(calls.sends, 0);
});

test("error isolation: RPC and send failures land in status, never throw, and the next tick recovers", async () => {
  const calls = { sims: 0, sends: 0, estimates: 0 };
  const status = newChainStatus(56, FWD);
  await runForwarderTick({ chainId: 56, status, reader: reader({ throwOn: "identity", calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.equal(status.lastDecision, "error");
  assert.match(status.lastError!.message, /rpc identity failed/);
  assert.equal(status.refused, null); // an RPC error is not a refusal
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, throwOn: "balances", calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.match(status.lastError!.message, /rpc balances failed/);
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, calls }), sender: sender(calls, true), cfg: cfg(), log: silent });
  assert.match(status.lastError!.message, /nonce too low/);
  assert.equal(status.inFlight, null);
  await runForwarderTick({ chainId: 56, status, reader: reader({ wrapped: E18, calls }), sender: sender(calls), cfg: cfg(), log: silent });
  assert.equal(status.lastDecision, "flush-sent");
  assert.equal(status.lastError, null);
  // A hung call is bounded.
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "hung"), /timed out after 20 ms/);
});

test("start in dry mode: one status per configured chain in /health, BigInt-free JSON", async () => {
  resetProtocolForwarderKeeperForTests();
  const ok = await startProtocolForwarderKeeper({ env: { PROTOCOL_FORWARDER_KEEPER: "dry", PROTOCOL_FORWARDER_ADDRESS_56: FWD } as any, rpcUrl: (id) => (id === 56 ? "http://x" : ""), makeReader: () => reader() });
  assert.equal(ok, true);
  const h = protocolForwarderKeeperHealth();
  assert.equal(h.mode, "dry");
  assert.equal(h.keeper, null);
  assert.deepEqual(Object.keys(h.chains), ["56"]);
  assert.doesNotThrow(() => JSON.stringify(h));
  resetProtocolForwarderKeeperForTests();
});
