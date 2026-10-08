// CO-IMP rev 2 CI6: the EVM import fee payout pass (importCreatorFeesEvm.ts), against a fake chain that
// enforces the vault's caps like RecruiterRewardsVault.payout() and a stateful fake db in the Solana
// worker's test pattern (SQL matched by its opening words).
import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_IMPORT_PAYOUT_SIGNERS,
  importFeeEvmSettings,
  importFeePayoutWallet,
  pickAccruals,
  runImportCreatorFeeEvmPass,
  vaultDailyLeft,
  type ImportFeeChain,
  type ImportFeeEvmSettings,
} from "../importCreatorFeesEvm.js";

const CHAIN = 56;
const VAULT = "0x00000000000000000000000000000000000000aa";
const PRV = "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c";
const OPERATOR = "0x00000000000000000000000000000000000000Ee";
const OWNER = "0x1234567890123456789012345678901234567890";
const OWNER2 = "0x2234567890123456789012345678901234567890";
const TOKEN = "0x00000000000000000000000000000000000000c1";
const TOKEN2 = "0x00000000000000000000000000000000000000c2";
const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = 86_400;

type Accrual = { fee_id: string; chain_id: number; token_address: string; creator_raw: bigint; status: string; transfer_id: number | null; expires_at: Date; occurred_at: Date };
type Transfer = { id: number; chain_id: number; kind: string; from_address: string; to_address: string; token_address: string | null; amount_raw: bigint; status: string; signature: string; last_valid_block_height: number; error: string | null; created_at: Date; updated_at: Date };
type Owner = { token: string; owner: string; verifiedAt: Date };

function fakeDb(init: { accruals?: Array<Partial<Accrual> & { fee_id: string; creator_raw: bigint }>; owners?: Owner[]; held?: string[]; halves?: bigint; now?: Date }) {
  const clock = { now: init.now || NOW };
  let state = {
    accruals: (init.accruals || []).map((a, i) => ({ chain_id: CHAIN, token_address: TOKEN, status: "waiting", transfer_id: null, expires_at: new Date(clock.now.getTime() + 30 * DAY * 1000), occurred_at: new Date(clock.now.getTime() - (100 - i) * 1000), ...a }) as Accrual),
    transfers: [] as Transfer[],
  };
  let snapshot: typeof state | null = null;
  const clone = (s: typeof state) => ({ accruals: s.accruals.map((a) => ({ ...a })), transfers: s.transfers.map((t) => ({ ...t })) });
  const calls: string[] = [];
  const db = {
    calls,
    clock,
    get state() { return state; },
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      calls.push(s);
      if (s === "begin") { snapshot = clone(state); return { rows: [] }; }
      if (s === "commit") { snapshot = null; return { rows: [] }; }
      if (s === "rollback") { if (snapshot) state = snapshot; snapshot = null; return { rows: [] }; }
      if (s.startsWith("select to_regclass('public.moderation_holds')")) return { rows: [{ ok: true }] };
      if (s.startsWith("select wallet_key from public.moderation_holds")) return { rows: (init.held || []).map((w) => ({ wallet_key: w.toLowerCase() })) };
      if (s.startsWith("select id, signature, last_valid_block_height")) {
        return { rows: state.transfers.filter((t) => t.chain_id === params[0] && t.status === "sending").map((t) => ({ ...t, amount_raw: t.amount_raw.toString() })) };
      }
      if (s.startsWith("update public.import_fee_transfers set signature = $2, error = null")) {
        const t = state.transfers.find((x) => x.id === params[0] && x.status === "sending");
        if (t) { t.signature = params[1]; t.error = null; t.updated_at = clock.now; }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (s.startsWith("update public.import_fee_transfers set error = $2")) {
        const t = state.transfers.find((x) => x.id === params[0]);
        if (t) { t.error = params[1]; t.updated_at = clock.now; }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (s.startsWith("update public.import_fee_transfers set status = 'landed'")) {
        const t = state.transfers.find((x) => x.id === params[0] && x.status === "sending");
        if (t) { t.status = "landed"; t.signature = params[1]; }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (s.startsWith("update public.import_fee_transfers set status = 'failed'")) {
        const t = state.transfers.find((x) => x.id === params[0] && x.status === "sending");
        if (t) { t.status = "failed"; t.error = params[1]; }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (s.startsWith("update public.import_creator_fees set status = 'paid'")) {
        const hit = state.accruals.filter((a) => a.transfer_id === params[0] && a.status === "paying");
        hit.forEach((a) => { a.status = "paid"; });
        return { rows: [], rowCount: hit.length };
      }
      if (s.startsWith("update public.import_creator_fees set status = 'waiting', transfer_id = null")) {
        const hit = state.accruals.filter((a) => a.transfer_id === params[0] && a.status === "paying");
        hit.forEach((a) => { a.status = "waiting"; a.transfer_id = null; });
        return { rows: [], rowCount: hit.length };
      }
      if (s.startsWith("update public.import_creator_fees set status = 'expired'")) {
        const at = new Date(params[1]);
        const hit = state.accruals.filter((a) => a.chain_id === params[0] && a.status === "waiting" && a.expires_at <= at);
        hit.forEach((a) => { a.status = "expired"; });
        return { rows: [], rowCount: hit.length };
      }
      if (s.startsWith("update public.import_creator_fees set status = 'paying'")) {
        const ids = (params[1] as string[]).map(String);
        const hit = state.accruals.filter((a) => ids.includes(a.fee_id) && a.status === "waiting");
        hit.forEach((a) => { a.status = "paying"; a.transfer_id = params[0]; });
        return { rows: [], rowCount: hit.length };
      }
      if (s.startsWith("with owners as")) {
        assert.equal(params[1], VAULT, "payable coins are read for this vault's fee rows");
        const now = new Date(params[2]);
        const holdMs = Number(params[3]) * DAY * 1000;
        const rows: any[] = [];
        for (const o of (init.owners || []).filter((x) => x.verifiedAt.getTime() <= now.getTime() - holdMs).sort((a, b) => a.token.localeCompare(b.token))) {
          state.accruals
            .filter((a) => a.chain_id === params[0] && a.token_address === o.token.toLowerCase() && a.status === "waiting" && a.expires_at > now)
            .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
            .forEach((a) => rows.push({ token_address: a.token_address, project_owner_wallet: o.owner, fee_id: a.fee_id, creator_raw: a.creator_raw.toString() }));
        }
        return { rows };
      }
      if (s.startsWith("select count(*)::int as sweeps")) {
        const since = new Date(params[2]);
        return { rows: [{ sweeps: state.transfers.filter((t) => t.kind === "protocol" && ["sending", "landed"].includes(t.status) && t.created_at >= since).length }] };
      }
      if (s.startsWith("select (select coalesce(sum(fee_raw - creator_raw)")) {
        const expired = state.accruals.filter((a) => a.status === "expired").reduce((n, a) => n + a.creator_raw, 0n);
        const swept = state.transfers.filter((t) => t.kind === "protocol" && ["sending", "landed"].includes(t.status)).reduce((n, t) => n + t.amount_raw, 0n);
        return { rows: [{ halves: String(init.halves ?? 0n), expired: expired.toString(), swept: swept.toString() }] };
      }
      if (s.startsWith("insert into public.import_fee_transfers")) {
        const id = state.transfers.length + 1;
        state.transfers.push({ id, chain_id: params[0], kind: params[1], from_address: params[2], to_address: params[3], token_address: params[4], amount_raw: BigInt(params[5]), status: "sending", signature: params[6], last_valid_block_height: params[7], error: null, created_at: clock.now, updated_at: clock.now });
        return { rows: [{ id }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
    },
  };
  return db;
}

/** A chain whose vault behaves like RecruiterRewardsVault.payout(): per-tx cap, daily cap with the UTC day reset, balance. */
function fakeChain(init: { balance?: bigint; maxPayoutPerTx?: bigint; dailyPayoutCap?: bigint; dailySpent?: bigint; chainTime?: number; operator?: string; paused?: boolean; contracts?: string[] }) {
  const vault = {
    balance: init.balance ?? 10_000n,
    maxPayoutPerTx: init.maxPayoutPerTx ?? 1_000n,
    dailyPayoutCap: init.dailyPayoutCap ?? 5_000n,
    dailySpent: init.dailySpent ?? 0n,
    lastDay: BigInt(Math.floor((init.chainTime ?? NOW.getTime() / 1000) / DAY)),
    chainTime: init.chainTime ?? Math.floor(NOW.getTime() / 1000),
    operator: init.operator ?? OPERATOR,
    paused: init.paused ?? false,
  };
  let latest = 7;
  let pendingExtra = 0;
  let counter = 0;
  const signed = new Map<string, { to: string; amount: bigint; nonce: number; resend: boolean }>();
  const mempool: string[] = [];
  const mined = new Map<string, { status: number; blockNumber: number }>();
  const paid: Array<{ to: string; amount: bigint; hash: string }> = [];
  const atBroadcast: Array<() => void> = [];
  let block = 100;
  const chain: ImportFeeChain & Record<string, any> = {
    vault, signed, mempool, mined, paid, atBroadcast,
    setPendingExtra(n: number) { pendingExtra = n; },
    useNonce() { latest += 1; },
    get latest() { return latest; },
    async readVault() { return { ...vault }; },
    async isPlainWallet(address: string) { return !(init.contracts || []).map((c) => c.toLowerCase()).includes(address.toLowerCase()); },
    async nonce(_a: string, tag: "latest" | "pending") { return tag === "latest" ? latest : latest + pendingExtra + mempool.length; },
    async signPayout({ to, amount, nonce, resend }: { to: string; amount: bigint; nonce: number; resend?: boolean }) {
      counter += 1;
      const hash = `0x${counter.toString(16).padStart(64, "0")}`;
      signed.set(hash, { to, amount, nonce, resend: Boolean(resend) });
      return { hash, raw: `raw:${hash}`, nonce };
    },
    async broadcast(raw: string) {
      for (const check of atBroadcast) check();
      if (chain.failBroadcast) throw new Error("node dropped it");
      mempool.push(raw.slice(4));
    },
    /** Mines the mempool in nonce order like the vault would execute it. */
    mine() {
      mempool.sort((a, b) => signed.get(a)!.nonce - signed.get(b)!.nonce);
      while (mempool.length) {
        const hash = mempool.shift()!;
        const tx = signed.get(hash)!;
        if (tx.nonce !== latest) continue; // stale version of a used nonce
        latest += 1;
        block += 1;
        const day = BigInt(Math.floor(vault.chainTime / DAY));
        if (day !== vault.lastDay) { vault.lastDay = day; vault.dailySpent = 0n; }
        const ok = !vault.paused && tx.amount <= vault.balance && tx.amount <= vault.maxPayoutPerTx && vault.dailySpent + tx.amount <= vault.dailyPayoutCap;
        if (ok) { vault.dailySpent += tx.amount; vault.balance -= tx.amount; paid.push({ to: tx.to.toLowerCase(), amount: tx.amount, hash }); }
        mined.set(hash, { status: ok ? 1 : 0, blockNumber: block });
      }
    },
    async receipt(hash: string) { return mined.get(hash) || null; },
    async known(hash: string) { return mined.has(hash) || mempool.includes(hash); },
    async payoutLogs({ to, amount }: { to: string; amount: bigint; sinceMs: number }) {
      return paid.filter((p) => p.to === to.toLowerCase() && p.amount === amount).map((p) => ({ txHash: p.hash, blockNumber: mined.get(p.hash)!.blockNumber, to: p.to, amount: p.amount }));
    },
    async txSender(hash: string) { const tx = signed.get(hash); return tx ? { from: OPERATOR, nonce: tx.nonce } : null; },
  };
  return chain;
}

const settings: ImportFeeEvmSettings = { ...importFeeEvmSettings(CHAIN, { IMPORT_FEE_VAULT_56: VAULT })!, minPayoutWei: 100n, minSweepWei: 50n, holdDays: 7, payoutsPerPass: 5, resendAfterMs: 60_000 };
const verified = (token = TOKEN, owner = OWNER, daysAgo = 10): Owner => ({ token, owner, verifiedAt: new Date(NOW.getTime() - daysAgo * DAY * 1000) });
const accruals = (raws: bigint[], token = TOKEN) => raws.map((creator_raw, i) => ({ fee_id: `${token.slice(-2)}${i + 1}`, creator_raw, token_address: token }));
const pass = (db: any, chain: any, send = true, extra: Partial<ImportFeeEvmSettings> = {}) => runImportCreatorFeeEvmPass({ db, chain, operator: OPERATOR, send, settings: { ...settings, ...extra }, now: db.clock.now });

test("settings and key: per chain from env; deployers and the existing payout operator never sign", () => {
  assert.equal(importFeeEvmSettings(56, {}), null, "no vault: chain off");
  const s = importFeeEvmSettings(97, { IMPORT_FEE_VAULT_97: VAULT.toUpperCase().replace("0X", "0x") })!;
  assert.equal(s.vault, VAULT);
  assert.equal(s.protocolVault, null, "testnets: the sweep target comes from the env");
  assert.equal(importFeeEvmSettings(56, { IMPORT_FEE_VAULT_56: VAULT })!.protocolVault, PRV.toLowerCase());
  assert.equal(importFeeEvmSettings(4663, { IMPORT_FEE_VAULT_4663: VAULT, PROTOCOL_REVENUE_VAULT_ADDRESS_4663: OWNER })!.protocolVault, OWNER.toLowerCase());
  assert.equal(importFeeEvmSettings(56, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_CREATOR_MIN_PAYOUT_WEI_56: "123" })!.minPayoutWei, 123n);
  assert.equal(importFeePayoutWallet(56, {}), null);
  assert.ok(FORBIDDEN_IMPORT_PAYOUT_SIGNERS.includes("0xdcf07eb07e6d6722c246161e7530dc905f9eaa50"));
  const w = importFeePayoutWallet(56, { IMPORT_FEE_PAYOUT_OPERATOR_PK_56: "0x" + "11".repeat(32) })!;
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
});

test("pure: accruals paid whole oldest first; the vault's daily room resets with the chain's UTC day", () => {
  const w = [{ feeId: "1", creatorRaw: 600n }, { feeId: "2", creatorRaw: 600n }];
  assert.deepEqual(pickAccruals(w, 1000n).amount, 600n);
  const t = Math.floor(NOW.getTime() / 1000);
  assert.equal(vaultDailyLeft({ dailyPayoutCap: 1500n, dailySpent: 1000n, lastDay: BigInt(Math.floor(t / DAY)), chainTime: t }), 500n);
  assert.equal(vaultDailyLeft({ dailyPayoutCap: 1500n, dailySpent: 1000n, lastDay: BigInt(Math.floor(t / DAY)), chainTime: t + DAY }), 1500n);
  assert.equal(vaultDailyLeft({ dailyPayoutCap: 1500n, dailySpent: 2000n, lastDay: BigInt(Math.floor(t / DAY)), chainTime: t }), 0n);
});

test("dry run: lists what it would pay, writes nothing, signs nothing", async () => {
  const db = fakeDb({ accruals: accruals([300n, 400n]), owners: [verified()] });
  const chain = fakeChain({});
  const out = await pass(db, chain, false);
  assert.deepEqual(out.payouts, [{ token: TOKEN, owner: OWNER, amount: "700", hash: null }]);
  assert.equal(chain.signed.size, 0);
  assert.equal(chain.mempool.length, 0);
  assert.ok(db.calls.every((sql) => !/^(insert|update|begin)/i.test(sql)), "read-only");
});

test("held by moderation, our own wallets and contracts are never paid; claim younger than 7 days waits", async () => {
  const safe = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
  const contract = "0x3334567890123456789012345678901234567890";
  const db = fakeDb({
    accruals: [...accruals([500n], TOKEN), ...accruals([500n], TOKEN2), ...accruals([500n], "0x00000000000000000000000000000000000000c3"), ...accruals([500n], "0x00000000000000000000000000000000000000c4")],
    owners: [verified(TOKEN, OWNER), verified(TOKEN2, safe), verified("0x00000000000000000000000000000000000000c3", contract), verified("0x00000000000000000000000000000000000000c4", OWNER2, 3)],
    held: [OWNER],
  });
  const chain = fakeChain({ contracts: [contract] });
  const out = await pass(db, chain);
  assert.equal(out.payouts.length, 0);
  assert.equal(chain.signed.size, 0);
  assert.ok(out.skipped.some((s) => /held by moderation/.test(s)));
  assert.ok(out.skipped.some((s) => /one of our own wallets/.test(s)));
  assert.ok(out.skipped.some((s) => /is a contract/.test(s)));
  assert.ok(db.state.accruals.every((a) => a.status === "waiting"));
});

test("minimum: below it nothing is paid", async () => {
  const db = fakeDb({ accruals: accruals([40n, 50n]), owners: [verified()] });
  const chain = fakeChain({});
  const out = await pass(db, chain);
  assert.equal(out.payouts.length, 0);
  assert.equal(chain.signed.size, 0);
});

test("paying before send: the transfer row and the accruals are stored before the transaction leaves", async () => {
  const db = fakeDb({ accruals: accruals([300n, 400n]), owners: [verified()] });
  const chain = fakeChain({});
  chain.atBroadcast.push(() => {
    const t = db.state.transfers.at(-1)!;
    assert.equal(t.status, "sending");
    assert.equal(t.signature, [...chain.signed.keys()].at(-1));
    assert.equal(t.last_valid_block_height, 7, "the nonce is stored with the row");
    assert.ok(db.state.accruals.every((a) => a.status === "paying" && a.transfer_id === t.id));
  });
  const out = await pass(db, chain);
  assert.equal(out.payouts.length, 1);
  assert.equal(chain.mempool.length, 1);
  chain.mine();
  const next = await pass(db, chain);
  assert.deepEqual(next.resolved, { landed: 1, reset: 0, pending: 0, resent: 0 });
  assert.ok(db.state.accruals.every((a) => a.status === "paid"));
  assert.deepEqual(chain.paid.map((p: any) => p.amount), [700n]);
});

test("chunking: never above maxPayoutPerTx; consecutive nonces in one pass", async () => {
  const db = fakeDb({ accruals: accruals([600n, 600n, 600n]), owners: [verified()] });
  const chain = fakeChain({ maxPayoutPerTx: 1_000n });
  const out = await pass(db, chain);
  assert.deepEqual(out.payouts.map((p) => p.amount), ["600", "600", "600"]);
  assert.deepEqual([...chain.signed.values()].map((s: any) => s.nonce), [7, 8, 9]);
  chain.mine();
  assert.equal(chain.paid.length, 3, "every chunk passes the vault's per-tx cap");
  await pass(db, chain);
  assert.ok(db.state.accruals.every((a) => a.status === "paid"));
});

test("daily cap: what does not fit today waits, and pays on the next UTC day", async () => {
  const db = fakeDb({ accruals: accruals([300n, 300n]), owners: [verified()] });
  const chain = fakeChain({ dailyPayoutCap: 1_500n, dailySpent: 1_100n });
  const out = await pass(db, chain);
  assert.deepEqual(out.payouts.map((p) => p.amount), ["300"], "400 left today: one accrual");
  assert.ok(out.skipped.some((s) => /daily payout cap reached/.test(s)));
  chain.mine();
  const sameDay = await pass(db, chain);
  assert.equal(sameDay.payouts.length, 0);
  assert.equal(db.state.accruals.filter((a) => a.status === "waiting").length, 1);
  // Next UTC day on chain: the vault's dailySpent resets.
  chain.vault.chainTime += DAY;
  db.clock.now = new Date(db.clock.now.getTime() + DAY * 1000);
  const tomorrow = await pass(db, chain);
  assert.deepEqual(tomorrow.payouts.map((p) => p.amount), ["300"]);
  chain.mine();
  await pass(db, chain);
  assert.equal(chain.paid.reduce((n: bigint, p: any) => n + p.amount, 0n), 600n);
  assert.ok(db.state.accruals.every((a) => a.status === "paid"));
});

test("resolve: a dropped send is re-sent at the same nonce after reading the Payout events; paid once", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()] });
  const chain = fakeChain({});
  chain.failBroadcast = true;
  await pass(db, chain);
  chain.failBroadcast = false;
  assert.equal(db.state.transfers[0].status, "sending");
  assert.match(String(db.state.transfers[0].error), /dropped/);
  // Too early to re-send: pending, nothing new.
  const early = await pass(db, chain);
  assert.deepEqual(early.resolved, { landed: 0, reset: 0, pending: 1, resent: 0 });
  assert.equal(chain.signed.size, 1);
  db.clock.now = new Date(db.clock.now.getTime() + 120_000);
  const resent = await pass(db, chain);
  assert.equal(resent.resolved!.resent, 1);
  const versions = [...chain.signed.values()];
  assert.equal(versions.length, 2);
  assert.equal(versions[1].nonce, versions[0].nonce, "same nonce: only one version can land");
  assert.equal(versions[1].resend, true);
  chain.mine();
  const done = await pass(db, chain);
  assert.equal(done.resolved!.landed, 1);
  assert.equal(chain.paid.length, 1);
  assert.equal(db.state.transfers[0].signature, [...chain.signed.keys()][1]);
});

test("resolve: an earlier version that landed under another hash is found by its Payout event, never paid twice", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()] });
  const chain = fakeChain({});
  await pass(db, chain);
  const original = [...chain.signed.keys()][0];
  // The row now carries a later hash (a re-send whose broadcast never got through); the original landed.
  db.state.transfers[0].signature = "0x" + "f".repeat(64);
  chain.mine();
  const out = await pass(db, chain);
  assert.deepEqual(out.resolved, { landed: 1, reset: 0, pending: 0, resent: 0 });
  assert.equal(db.state.transfers[0].signature, original, "the hash that actually paid");
  assert.equal(chain.paid.length, 1);
  assert.equal(chain.signed.size, 1, "nothing re-sent");
  assert.ok(db.state.accruals.every((a) => a.status === "paid"));
});

test("resolve: a nonce used by another transaction (no Payout) fails the transfer and frees the accruals", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()] });
  const chain = fakeChain({});
  chain.failBroadcast = true;
  await pass(db, chain);
  chain.failBroadcast = false;
  chain.useNonce(); // something else took nonce 7
  const out = await pass(db, chain);
  assert.equal(out.resolved!.reset, 1);
  assert.equal(db.state.transfers[0].status, "failed");
  // Same pass: the accrual is waiting again and goes out at the next nonce.
  assert.equal(out.payouts.length, 1);
  assert.equal([...chain.signed.values()].at(-1)!.nonce, 8);
});

test("a reverted payout puts the accruals back; an operator transaction outside the ledger blocks new ones", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()] });
  const chain = fakeChain({});
  await pass(db, chain);
  chain.vault.paused = true; // reverts at execution
  chain.mine();
  chain.vault.paused = false;
  const out = await pass(db, chain);
  assert.equal(out.resolved!.reset, 1);
  assert.equal(out.payouts.length, 1, "the freed accrual is paid again");
  chain.mine();
  await pass(db, chain);
  assert.equal(chain.paid.length, 1);

  const other = fakeChain({});
  other.setPendingExtra(1);
  const blocked = await pass(fakeDb({ accruals: accruals([500n]), owners: [verified()] }), other);
  assert.equal(blocked.payouts.length, 0);
  assert.ok(blocked.skipped.some((s) => /outside the ledger/.test(s)));
  const wrongKey = await pass(fakeDb({ accruals: accruals([500n]), owners: [verified()] }), fakeChain({ operator: OWNER2 }));
  assert.ok(wrongKey.skipped.some((s) => /vault operator is/.test(s)));
});

test("expiry + protocol sweep: past 90 days -> expired; our halves + expired to ProtocolRevenueVault, once per UTC day, within the caps", async () => {
  const past = new Date(NOW.getTime() - 1000);
  const db = fakeDb({ accruals: [{ fee_id: "x1", creator_raw: 400n, expires_at: past }, { fee_id: "x2", creator_raw: 300n, expires_at: past }], halves: 900n });
  const chain = fakeChain({ maxPayoutPerTx: 1_000n });
  const out = await pass(db, chain);
  assert.equal(out.expired, 2);
  assert.ok(db.state.accruals.every((a) => a.status === "expired"));
  assert.equal(out.sweep?.amount, "1000", "due 900 + 700 = 1600, capped at maxPayoutPerTx");
  const tx = [...chain.signed.values()][0];
  assert.equal(tx.to.toLowerCase(), PRV.toLowerCase());
  assert.equal(db.state.transfers[0].kind, "protocol");
  chain.mine();
  const again = await pass(db, chain);
  assert.equal(again.resolved!.landed, 1);
  assert.equal(again.sweep, null, "one sweep per UTC day");
  chain.vault.chainTime += DAY;
  db.clock.now = new Date(db.clock.now.getTime() + DAY * 1000);
  const tomorrow = await pass(db, chain);
  assert.equal(tomorrow.sweep?.amount, "600", "the rest of the due");
  // Dry run of a sweep: listed, nothing signed.
  const dry = await pass(fakeDb({ halves: 500n }), fakeChain({}), false);
  assert.deepEqual(dry.sweep, { amount: "500", hash: null });
});

test("no sweep while a creator was paid in the pass; testnet without a ProtocolRevenueVault only pays creators", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()], halves: 900n });
  const chain = fakeChain({});
  const out = await pass(db, chain);
  assert.equal(out.payouts.length, 1);
  assert.equal(out.sweep, null);
  const t = await pass(fakeDb({ halves: 900n }), fakeChain({}), true, { protocolVault: null, chainId: 97 });
  assert.equal(t.sweep, null);
  assert.ok(t.skipped.some((s) => /PROTOCOL_REVENUE_VAULT_ADDRESS_97/.test(s)));
});
