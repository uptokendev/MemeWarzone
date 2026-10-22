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

type Accrual = { fee_id: string; chain_id: number; token_address: string; creator_raw: bigint; status: string; transfer_id: number | null; expires_at: Date | null; occurred_at: Date; payee_kind?: string };
type Transfer = { id: number; chain_id: number; kind: string; from_address: string; to_address: string; token_address: string | null; amount_raw: bigint; status: string; signature: string; last_valid_block_height: number; error: string | null; created_at: Date; updated_at: Date; partner_id?: string | null; gen8_raw?: bigint };
/** Gen-8 ledger (migration 20261022_000010) in the fake: per-partner gen8_partner_fees totals of the chain, top-up rows, fee tx hashes. */
type Gen8Init = { earned?: Record<string, bigint>; topups?: Array<{ tx_hash: string; amount_raw: bigint; status?: string; vault?: string }>; feeTxs?: string[] };
type PartnerRow = Record<string, unknown> & { id: string };
type Owner = { token: string; owner: string; verifiedAt: Date };

function fakeDb(init: { accruals?: Array<Partial<Accrual> & { fee_id: string; creator_raw: bigint }>; owners?: Owner[]; campaigns?: Array<{ token: string; creator: string }>; held?: string[]; halves?: bigint; now?: Date; partners?: PartnerRow[] | "missing"; partnerEarned?: Record<string, bigint>; gen8?: Gen8Init }) {
  const clock = { now: init.now || NOW };
  let state = {
    accruals: (init.accruals || []).map((a, i) => ({ chain_id: CHAIN, token_address: TOKEN, status: "waiting", transfer_id: null, expires_at: new Date(clock.now.getTime() + 30 * DAY * 1000), occurred_at: new Date(clock.now.getTime() - (100 - i) * 1000), ...a }) as Accrual),
    transfers: [] as Transfer[],
    topups: (init.gen8?.topups || []).map((t, i) => ({ id: i + 1, vault: VAULT, status: "pending", error: null as string | null, ...t })),
  };
  let snapshot: typeof state | null = null;
  const clone = (s: typeof state) => ({ accruals: s.accruals.map((a) => ({ ...a })), transfers: s.transfers.map((t) => ({ ...t })), topups: s.topups.map((t) => ({ ...t })) });
  const sent = (t: Transfer) => ["sending", "landed"].includes(t.status);
  const g8 = (t: Transfer) => t.gen8_raw ?? 0n;
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
        const hit = state.accruals.filter((a) => a.chain_id === params[0] && a.status === "waiting" && a.expires_at != null && a.expires_at <= at);
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
            .filter((a) => a.chain_id === params[0] && a.token_address === o.token.toLowerCase() && a.status === "waiting" && (a.payee_kind ?? "import_owner") === "import_owner" && a.expires_at != null && a.expires_at > now)
            .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
            .forEach((a) => rows.push({ token_address: a.token_address, project_owner_wallet: o.owner, fee_id: a.fee_id, creator_raw: a.creator_raw.toString() }));
        }
        // Graduated MemeWarzone coins: paid to the campaign creator, no hold, no expiry.
        for (const m of (init.campaigns || []).slice().sort((a, b) => a.token.localeCompare(b.token))) {
          state.accruals
            .filter((a) => a.chain_id === params[0] && a.token_address === m.token.toLowerCase() && a.status === "waiting" && a.payee_kind === "campaign_creator")
            .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime())
            .forEach((a) => rows.push({ token_address: a.token_address, project_owner_wallet: m.creator.toLowerCase(), fee_id: a.fee_id, creator_raw: a.creator_raw.toString() }));
        }
        rows.sort((x, y) => x.token_address.localeCompare(y.token_address));
        return { rows };
      }
      if (s.startsWith("select * from public.import_fee_partners")) {
        if (init.partners === "missing") throw Object.assign(new Error('relation "public.import_fee_partners" does not exist'), { code: "42P01" });
        return { rows: (init.partners || []).filter((p) => p.chain_id == null || p.chain_id === params[0]) };
      }
      if (s.startsWith("select to_regclass('public.gen8_partner_fees') is not null and to_regclass('public.gen8_partner_topups')")) {
        return { rows: [{ ready: Boolean(init.gen8) }] };
      }
      if (s.startsWith("select id, tx_hash, amount_raw::text as amount_raw, status from public.gen8_partner_topups")) {
        return { rows: state.topups.filter((t) => t.vault === params[1] && ["pending", "verified"].includes(t.status)).map((t) => ({ ...t, amount_raw: t.amount_raw.toString() })) };
      }
      if (s.startsWith("select 1 from public.finance_import_swap_fees where chain_id = $1 and lower(tx_hash)")) {
        return { rows: (init.gen8?.feeTxs || []).map((h) => h.toLowerCase()).includes(String(params[1]).toLowerCase()) ? [{ "?column?": 1 }] : [] };
      }
      if (s.startsWith("update public.gen8_partner_topups set status = 'verified'") || s.startsWith("update public.gen8_partner_topups set status = 'rejected'")) {
        const t = state.topups.find((x) => x.id === params[0] && x.status === "pending");
        if (t) { t.status = s.includes("'verified'") ? "verified" : "rejected"; t.error = s.includes("'rejected'") ? params[1] : null; }
        return { rows: [], rowCount: t ? 1 : 0 };
      }
      if (s.startsWith("select (select coalesce(sum(c.creator_raw), 0) from public.import_creator_fees c join public.finance_import_swap_fees f on f.id = c.fee_id where c.chain_id = $1 and f.fee_receiver = $2 and c.status in ('waiting', 'paying'))")) {
        assert.equal(params[1], VAULT);
        const creatorOwed = state.accruals.filter((a) => ["waiting", "paying"].includes(a.status)).reduce((n, a) => n + a.creator_raw, 0n);
        let importPartnerOwed = 0n;
        for (const [id, earned] of Object.entries(init.partnerEarned || {})) {
          const paid = state.transfers.filter((t) => t.kind === "partner" && t.partner_id === id && t.from_address === VAULT && sent(t)).reduce((n, t) => n + t.amount_raw - g8(t), 0n);
          importPartnerOwed += earned > paid ? earned - paid : 0n;
        }
        const expired = state.accruals.filter((a) => a.status === "expired").reduce((n, a) => n + a.creator_raw, 0n);
        const swept = state.transfers.filter((t) => t.kind === "protocol" && sent(t)).reduce((n, t) => n + t.amount_raw, 0n);
        const partnerSent = state.transfers.filter((t) => t.kind === "partner" && sent(t));
        return { rows: [{
          creator_owed: creatorOwed.toString(), import_partner_owed: importPartnerOwed.toString(), halves: String(init.halves ?? 0n), expired: expired.toString(), swept: swept.toString(),
          gen8_paid_vault: partnerSent.filter((t) => t.from_address === VAULT).reduce((n, t) => n + g8(t), 0n).toString(),
          gen8_earned: Object.values(init.gen8?.earned || {}).reduce((n, v) => n + v, 0n).toString(),
          gen8_paid_chain: partnerSent.reduce((n, t) => n + g8(t), 0n).toString(),
        }] };
      }
      if (s.startsWith("select (select coalesce(sum(partner_raw), 0) from public.finance_import_swap_fees where chain_id = $1 and fee_receiver = $2 and partner_id = $3)::text as import_earned")) {
        const id = params[2];
        const mine = state.transfers.filter((t) => t.kind === "partner" && t.partner_id === id && sent(t));
        return { rows: [{
          import_earned: String(init.partnerEarned?.[id] ?? 0n),
          import_paid: mine.filter((t) => t.from_address === params[1]).reduce((n, t) => n + t.amount_raw - g8(t), 0n).toString(),
          gen8_earned: String(init.gen8?.earned?.[id] ?? 0n),
          gen8_paid: mine.reduce((n, t) => n + g8(t), 0n).toString(),
        }] };
      }
      if (s.startsWith("select (select coalesce(sum(partner_raw), 0)")) {
        assert.equal(params[1], VAULT, "a partner's due is read from the default vault's fee rows");
        const earned = init.partnerEarned?.[params[2]] ?? 0n;
        const paid = state.transfers.filter((t) => t.kind === "partner" && t.partner_id === params[2] && t.from_address === params[1] && ["sending", "landed"].includes(t.status)).reduce((n, t) => n + t.amount_raw, 0n);
        return { rows: [{ earned: earned.toString(), paid: paid.toString() }] };
      }
      if (s.startsWith("select count(*)::int as sweeps")) {
        const since = new Date(params[2]);
        return { rows: [{ sweeps: state.transfers.filter((t) => t.kind === "protocol" && ["sending", "landed"].includes(t.status) && t.created_at >= since).length }] };
      }
      if (s.startsWith("select (select coalesce(sum(fee_raw - creator_raw - partner_raw), 0)")) {
        assert.match(s, /\(creator_raw > 0 or partner_raw > 0\)/);
        const expired = state.accruals.filter((a) => a.status === "expired").reduce((n, a) => n + a.creator_raw, 0n);
        const swept = state.transfers.filter((t) => t.kind === "protocol" && ["sending", "landed"].includes(t.status)).reduce((n, t) => n + t.amount_raw, 0n);
        return { rows: [{ halves: String(init.halves ?? 0n), expired: expired.toString(), swept: swept.toString() }] };
      }
      if (s.startsWith("insert into public.import_fee_transfers")) {
        const id = state.transfers.length + 1;
        if (/partner_id\)/.test(s) !== (params.length === 9)) throw new Error("partner_id column and parameter must come together");
        if (/gen8_raw\)/.test(s) !== (params.length === 10)) throw new Error("gen8_raw column and parameter must come together");
        if (params.length === 10 && !init.gen8) throw new Error("gen8_raw written without the gen-8 migration");
        state.transfers.push({ id, chain_id: params[0], kind: params[1], from_address: params[2], to_address: params[3], token_address: params[4], amount_raw: BigInt(params[5]), status: "sending", signature: params[6], last_valid_block_height: params[7], error: null, created_at: clock.now, updated_at: clock.now, partner_id: params[8] ?? null, gen8_raw: params[9] != null ? BigInt(params[9]) : 0n });
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

// ---------------------------------------------------------------- swap-widget partners (2026-10-09)
// Every fee (partner swap or not) lands in the ONE default vault; a fee row carries partner_id / partner_raw.
// The partner's share goes from that vault to its payout_wallet, with the creators' rules.

const PARTNER_WALLET = "0x4434567890123456789012345678901234567890";
const cryptic = (extra: Record<string, unknown> = {}): PartnerRow => ({ id: "crypticpump", chain_id: CHAIN, payout_wallet: PARTNER_WALLET, active: true, name: "CrypticPump", ...extra });

test("partners: settings minimum from env; the protocol due query subtracts partner_raw", async () => {
  assert.equal(importFeeEvmSettings(56, { IMPORT_FEE_VAULT_56: VAULT })!.minPartnerPayoutWei, 8_000_000_000_000_000n, "default = the creator minimum");
  assert.equal(importFeeEvmSettings(56, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_PARTNER_MIN_PAYOUT_WEI_56: "77" })!.minPartnerPayoutWei, 77n);
  const db = fakeDb({ halves: 600n });
  const out = await pass(db, fakeChain({}), false);
  assert.deepEqual(out.sweep, { amount: "600", hash: null });
  assert.ok(db.calls.some((sql) => sql.includes("sum(fee_raw - creator_raw - partner_raw)") && sql.includes("fee_receiver = $2")), "only this vault's rows, minus the partner part");
});

test("partners: paid from the default vault to the payout wallet, kind 'partner' + partner_id, stored before send, once", async () => {
  const db = fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 450n } });
  const chain = fakeChain({});
  chain.atBroadcast.push(() => {
    const t = db.state.transfers.at(-1)!;
    assert.equal(t.status, "sending");
    assert.equal(t.kind, "partner");
    assert.equal(t.partner_id, "crypticpump");
    assert.equal(t.from_address, VAULT, "the default vault pays");
    assert.equal(t.to_address, PARTNER_WALLET.toLowerCase());
    assert.equal(t.signature, [...chain.signed.keys()].at(-1));
  });
  const out = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.deepEqual(out.partnerPayouts.map((p) => [p.partner, p.to.toLowerCase(), p.amount]), [["crypticpump", PARTNER_WALLET.toLowerCase(), "450"]]);
  assert.equal(out.sweep, null, "no sweep in a pass that paid a partner");
  chain.mine();
  const next = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.deepEqual(next.resolved, { landed: 1, reset: 0, pending: 0, resent: 0 });
  assert.equal(next.partnerPayouts.length, 0, "due is 0 once the transfer is sending / landed");
  assert.deepEqual(chain.paid.map((p: any) => [p.to, p.amount]), [[PARTNER_WALLET.toLowerCase(), 450n]]);
});

test("partners: a reverted payout is 'failed' and the due is paid again; a dropped send is re-sent at its nonce", async () => {
  const db = fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 300n } });
  const chain = fakeChain({});
  await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  chain.vault.paused = true;
  chain.mine();
  chain.vault.paused = false;
  const retry = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(retry.resolved!.reset, 1);
  assert.equal(db.state.transfers[0].status, "failed");
  assert.equal(retry.partnerPayouts.length, 1, "paid again in the same pass");
  chain.failBroadcast = true;
  chain.mempool.length = 0; // the node lost it
  chain.failBroadcast = false;
  db.clock.now = new Date(db.clock.now.getTime() + 120_000);
  const resent = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(resent.resolved!.resent, 1);
  const versions = [...chain.signed.values()];
  assert.equal(versions.at(-1)!.nonce, versions.at(-2)!.nonce);
  chain.mine();
  await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(chain.paid.length, 1);
  assert.equal(chain.paid[0].amount, 300n);
});

test("partners: never to our own wallets, held wallets, contracts or a non-EVM wallet; below the minimum waits", async () => {
  const safe = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
  const contract = "0x3334567890123456789012345678901234567890";
  const db = fakeDb({
    partners: [cryptic({ id: "own", payout_wallet: safe }), cryptic({ id: "held", payout_wallet: OWNER }), cryptic({ id: "contract", payout_wallet: contract }), cryptic({ id: "solana", payout_wallet: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H" }), cryptic({ id: "small" })],
    partnerEarned: { own: 500n, held: 500n, contract: 500n, solana: 500n, small: 99n },
    held: [OWNER],
  });
  const chain = fakeChain({ contracts: [contract] });
  const out = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(out.partnerPayouts.length, 0);
  assert.equal(chain.signed.size, 0);
  for (const why of ["one of our own wallets", "held by moderation", "is a contract", "is not an EVM wallet"]) assert.ok(out.skipped.some((s) => s.includes(why)), why);
  assert.ok(!out.skipped.some((s) => s.startsWith("partner small")), "below the minimum: silently waits");
});

test("partners: within the vault's per-payout cap, daily room and balance; the rest next pass / day", async () => {
  const db = fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 2_500n } });
  const chain = fakeChain({ maxPayoutPerTx: 1_000n, dailyPayoutCap: 1_600n });
  const first = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.deepEqual(first.partnerPayouts.map((p) => p.amount), ["1000"], "one payout per partner per pass, capped per tx");
  chain.mine();
  const second = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.deepEqual(second.partnerPayouts.map((p) => p.amount), ["600"], "the daily room left");
  chain.mine();
  const third = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(third.partnerPayouts.length, 0);
  assert.ok(third.skipped.some((s) => /daily payout cap reached/.test(s)));
  chain.vault.chainTime += DAY;
  db.clock.now = new Date(db.clock.now.getTime() + DAY * 1000);
  const tomorrow = await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.deepEqual(tomorrow.partnerPayouts.map((p) => p.amount), ["900"]);
  chain.mine();
  await pass(db, chain, true, { minPartnerPayoutWei: 100n });
  assert.equal(chain.paid.reduce((n: bigint, p: any) => n + p.amount, 0n), 2_500n, "exactly what was earned");
  const poor = await pass(fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 500n } }), fakeChain({ balance: 50n }), true, { minPartnerPayoutWei: 100n });
  assert.equal(poor.partnerPayouts.length, 0);
  assert.ok(poor.skipped.some((s) => /vault balance or per-payout cap below the minimum/.test(s)));
});

test("partners: creators first and payoutsPerPass counts both; dry run writes nothing; inactive still paid what it earned; no table -> none", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()], partners: [cryptic(), cryptic({ id: "old", payout_wallet: OWNER2, active: false })], partnerEarned: { crypticpump: 200n, old: 300n } });
  const chain = fakeChain({});
  const dry = await pass(db, chain, false, { minPartnerPayoutWei: 100n });
  assert.equal(dry.payouts.length, 1);
  assert.deepEqual(dry.partnerPayouts.map((p) => [p.partner, p.amount, p.hash]), [["crypticpump", "200", null], ["old", "300", null]]);
  assert.ok(db.calls.every((sql) => !/^(insert|update|begin)/i.test(sql)), "read-only");
  assert.equal(chain.signed.size, 0);
  const capped = await pass(db, chain, true, { minPartnerPayoutWei: 100n, payoutsPerPass: 2 });
  assert.equal(capped.payouts.length, 1);
  assert.deepEqual(capped.partnerPayouts.map((p) => p.partner), ["crypticpump"]);
  assert.deepEqual([...chain.signed.values()].map((s: any) => [s.to.toLowerCase(), s.nonce]), [[OWNER.toLowerCase(), 7], [PARTNER_WALLET.toLowerCase(), 8]]);
  const noTable = await pass(fakeDb({ accruals: accruals([500n]), owners: [verified()], partners: "missing" }), fakeChain({}));
  assert.equal(noTable.payouts.length, 1);
  assert.equal(noTable.partnerPayouts.length, 0);
});

test("graduated MemeWarzone coin: paid to the campaign creator at once (no claim, no hold), never expires; imports unchanged", async () => {
  const far = new Date(NOW.getTime() + 400 * DAY * 1000);
  const db = fakeDb({
    accruals: [
      { fee_id: "g1", creator_raw: 300n, token_address: TOKEN2.toLowerCase(), payee_kind: "campaign_creator", expires_at: null },
      { fee_id: "g2", creator_raw: 400n, token_address: TOKEN2.toLowerCase(), payee_kind: "campaign_creator", expires_at: null },
      { fee_id: "i1", creator_raw: 500n },
    ],
    owners: [],
    campaigns: [{ token: TOKEN2, creator: OWNER2 }],
  });
  const out = await pass(db, fakeChain({}), false);
  assert.deepEqual(out.payouts, [{ token: TOKEN2.toLowerCase(), owner: OWNER2, amount: "700", hash: null }], "graduated rows pay the creator; the unclaimed import row waits");
  db.clock.now = far;
  await pass(db, fakeChain({}), true);
  const byId = Object.fromEntries(db.state.accruals.map((a: any) => [a.fee_id, a.status]));
  assert.notEqual(byId.g1, "expired");
  assert.notEqual(byId.g2, "expired");
  assert.equal(byId.i1, "expired", "the unclaimed import row still expires after 90 days");
});

// ---------------------------------------------------------------- gen-8 graduated widget swaps (2026-10-22)
// The partner's 0.25% of graduated gen-8 widget swaps (gen8_partner_fees) rides on the same partner payout, but only
// out of MemeWarzone's free share of the vault: min(balance - creator accruals - import partner dues, our recorded share
// + verified top-ups - what gen-8 already took). The sweep reserves every gen-8 due.

import { gen8FreeRoom, gen8Outstanding, gen8OwnShare, gen8SweepLimit, splitPartnerPayout, type Gen8VaultLedger } from "../importCreatorFeesEvm.js";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const g8settings = { minPartnerPayoutWei: 100n, gen8Send: true };
const ledger = (l: Partial<Gen8VaultLedger>): Gen8VaultLedger => ({ creatorOwed: 0n, importPartnerOwed: 0n, protocolHalves: 0n, expiredCreator: 0n, swept: 0n, topUps: 0n, gen8PaidFromVault: 0n, gen8Earned: 0n, gen8PaidOnChain: 0n, ...l });
const sentTransfers = (db: any, kind = "partner") => db.state.transfers.filter((t: any) => t.kind === kind && ["sending", "landed"].includes(t.status));

test("gen-8 pure: free room, own share, outstanding, sweep limit, split (BigInt edge cases)", () => {
  // Plenty in the vault: room = our share.
  assert.equal(gen8FreeRoom(10_000n, ledger({ protocolHalves: 1_000n })), 1_000n);
  // Vault short of its own liabilities: creators owed more than the balance -> 0, whatever our share says.
  assert.equal(gen8FreeRoom(3_000n, ledger({ creatorOwed: 5_000n, protocolHalves: 1_000n })), 0n);
  // Import partner dues are reserved like creator money.
  assert.equal(gen8FreeRoom(1_500n, ledger({ creatorOwed: 600n, importPartnerOwed: 300n, protocolHalves: 1_000n })), 600n);
  // A fee that reached the vault before the finance cron recorded it is not ours to spend: capped by the recorded share.
  assert.equal(gen8FreeRoom(1_000_000n, ledger({ protocolHalves: 50n })), 50n);
  // Gen-8 already took more than our share (a top-up paid it): negative own share -> 0 room, no underflow.
  const over = ledger({ protocolHalves: 100n, gen8PaidFromVault: 400n });
  assert.equal(gen8OwnShare(over), -300n);
  assert.equal(gen8FreeRoom(10_000n, over), 0n);
  assert.equal(gen8FreeRoom(10_000n, ledger({ protocolHalves: 100n, topUps: 400n, gen8PaidFromVault: 400n })), 100n, "a verified top-up adds to our share");
  // Outstanding never negative.
  assert.equal(gen8Outstanding(ledger({ gen8Earned: 100n, gen8PaidOnChain: 150n })), 0n);
  assert.equal(gen8Outstanding(ledger({ gen8Earned: 500n, gen8PaidOnChain: 150n })), 350n);
  // Sweep: our share minus every gen-8 due, within the free money; 0 when the dues exceed it.
  assert.equal(gen8SweepLimit(10_000n, ledger({ protocolHalves: 1_000n, gen8Earned: 300n })), 700n);
  assert.equal(gen8SweepLimit(10_000n, ledger({ protocolHalves: 1_000n, gen8Earned: 300n, gen8PaidOnChain: 300n, gen8PaidFromVault: 300n })), 700n, "paid gen-8 is out of the share once, not twice");
  assert.equal(gen8SweepLimit(10_000n, ledger({ protocolHalves: 100n, gen8Earned: 300n })), 0n);
  assert.equal(gen8SweepLimit(1_200n, ledger({ creatorOwed: 1_000n, protocolHalves: 1_000n, gen8Earned: 100n })), 100n, "never into creator money");
  // Split: import first, gen-8 within the room, all within the cap.
  assert.deepEqual(splitPartnerPayout({ importDue: 300n, gen8Due: 200n, gen8Room: 1_000n, cap: 10_000n }), { amount: 500n, importPart: 300n, gen8Part: 200n });
  assert.deepEqual(splitPartnerPayout({ importDue: 300n, gen8Due: 200n, gen8Room: 50n, cap: 10_000n }), { amount: 350n, importPart: 300n, gen8Part: 50n });
  assert.deepEqual(splitPartnerPayout({ importDue: 300n, gen8Due: 200n, gen8Room: 1_000n, cap: 250n }), { amount: 250n, importPart: 250n, gen8Part: 0n });
  assert.deepEqual(splitPartnerPayout({ importDue: 0n, gen8Due: 200n, gen8Room: 0n, cap: 10_000n }), { amount: 0n, importPart: 0n, gen8Part: 0n });
  assert.deepEqual(splitPartnerPayout({ importDue: -5n, gen8Due: -5n, gen8Room: -5n, cap: -5n }), { amount: 0n, importPart: 0n, gen8Part: 0n }, "no negative amounts");
  assert.equal(importFeeEvmSettings(4663, { IMPORT_FEE_VAULT_4663: VAULT })!.gen8Send, false, "gen-8 payouts send only when GEN8_PARTNER_PAYOUT_SEND=true");
  assert.equal(importFeeEvmSettings(4663, { IMPORT_FEE_VAULT_4663: VAULT, GEN8_PARTNER_PAYOUT_SEND: "true" })!.gen8Send, true);
});

test("gen-8: a due with no import revenue is paid from our share (gen8_raw), stored before send, once; the sweep takes only the rest", async () => {
  const db = fakeDb({ partners: [cryptic()], halves: 1_000n, gen8: { earned: { crypticpump: 400n } } });
  const chain = fakeChain({ balance: 1_000n });
  chain.atBroadcast.push(() => {
    const t = db.state.transfers.at(-1)!;
    assert.equal(t.status, "sending");
    assert.equal(t.kind, "partner");
    assert.equal(t.gen8_raw, 400n, "the gen-8 part is recorded with the row");
  });
  const out = await pass(db, chain, true, g8settings);
  assert.deepEqual(out.partnerPayouts.map((p) => [p.partner, p.amount, p.gen8Amount]), [["crypticpump", "400", "400"]]);
  assert.equal(out.gen8?.roomWei, "1000");
  assert.equal(out.sweep, null);
  chain.atBroadcast.length = 0;
  chain.mine();
  const second = await pass(db, chain, true, g8settings);
  assert.equal(second.resolved!.landed, 1);
  assert.equal(second.partnerPayouts.length, 0, "double run: nothing paid twice");
  assert.equal(second.sweep?.amount, "600", "1000 of our share - 400 gen-8 already paid from it");
  chain.mine();
  await pass(db, chain, true, g8settings);
  assert.deepEqual(chain.paid.map((p: any) => p.amount), [400n, 600n]);
  assert.equal(chain.vault.balance, 0n);
});

test("gen-8: vault short -> pays only the free share, the rest waits (no creator money), a verified Safe top-up pays it", async () => {
  // Creators are owed 2000 (unclaimed import: not payable, still a liability); our share is 100; the vault holds exactly that.
  const db = fakeDb({ accruals: accruals([1_000n, 1_000n]), partners: [cryptic()], halves: 100n, gen8: { earned: { crypticpump: 500n } } });
  const chain = fakeChain({ balance: 2_100n });
  chain.vaultAdmin = async () => SAFE;
  const first = await pass(db, chain, true, g8settings);
  assert.deepEqual(first.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["100", "100"]], "only the free 100");
  assert.ok(first.skipped.some((s) => /gen-8 share 400 waits; the vault's free MemeWarzone share is 100/.test(s)));
  chain.mine();
  const second = await pass(db, chain, true, g8settings);
  assert.equal(second.partnerPayouts.length, 0);
  assert.equal(second.gen8?.roomWei, "0");
  assert.deepEqual(second.gen8?.planned, [{ partner: "crypticpump", dueWei: "400", payableWei: "0" }]);
  assert.equal(second.sweep, null, "nothing of ours left to sweep: the 400 is reserved");
  assert.equal(chain.vault.balance, 2_000n, "the creators' 2000 is untouched");
  // The Safe tops up 400; the founder records the hash. Wrong rows are rejected, never counted.
  const good = "0x" + "a".repeat(64);
  const wrongAmount = "0x" + "b".repeat(64);
  const notSafe = "0x" + "c".repeat(64);
  const feeTx = "0x" + "d".repeat(64);
  const db2 = fakeDb({ accruals: accruals([1_000n, 1_000n]), partners: [cryptic()], halves: 100n, gen8: { earned: { crypticpump: 500n }, feeTxs: [feeTx], topups: [{ tx_hash: good, amount_raw: 400n }, { tx_hash: wrongAmount, amount_raw: 999n }, { tx_hash: notSafe, amount_raw: 400n }, { tx_hash: feeTx, amount_raw: 400n }] } });
  db2.state.transfers.push(...db.state.transfers.map((t: any) => ({ ...t })));
  chain.vault.balance += 400n;
  chain.vaultDeposits = async (hash: string) => ({ status: 1, deposits: [{ from: hash === notSafe ? OWNER : SAFE, amount: 400n }] });
  const dry = await pass(db2, chain, false, g8settings);
  assert.equal(dry.gen8?.topUpsWei, "400", "dry run: checked in memory");
  assert.ok(db2.state.topups.every((t: any) => t.status === "pending"), "dry run writes nothing");
  const third = await pass(db2, chain, true, g8settings);
  assert.deepEqual(db2.state.topups.map((t: any) => t.status), ["verified", "rejected", "rejected", "rejected"]);
  assert.ok(third.skipped.some((s) => /is an import fee row/.test(s)));
  assert.deepEqual(third.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["400", "400"]]);
  chain.mine();
  await pass(db2, chain, true, g8settings);
  assert.equal(chain.paid.reduce((n: bigint, p: any) => n + p.amount, 0n), 500n, "exactly what was earned");
  assert.equal(chain.vault.balance, 2_000n, "creator money never moved");
});

test("gen-8: creator dues above the balance -> no gen-8 payout and no sweep", async () => {
  const db = fakeDb({ accruals: accruals([5_000n]), partners: [cryptic()], halves: 1_000n, gen8: { earned: { crypticpump: 500n } } });
  const out = await pass(db, fakeChain({ balance: 3_000n }), true, g8settings);
  assert.equal(out.partnerPayouts.length, 0);
  assert.equal(out.gen8?.roomWei, "0");
  assert.equal(out.sweep, null);
});

test("gen-8: import and gen-8 parts in one payout; caps take the import part first; parts are counted apart afterwards", async () => {
  const earned: Record<string, bigint> = { crypticpump: 300n };
  const db = fakeDb({ partners: [cryptic()], partnerEarned: earned, halves: 1_000n, gen8: { earned: { crypticpump: 200n } } });
  const chain = fakeChain({ balance: 1_300n, maxPayoutPerTx: 250n });
  const first = await pass(db, chain, true, g8settings);
  assert.deepEqual(first.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["250", "0"]], "import first within the per-payout cap");
  assert.equal(db.state.transfers[0].gen8_raw, 0n);
  chain.mine();
  const second = await pass(db, chain, true, g8settings);
  assert.deepEqual(second.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["250", "200"]], "50 import + 200 gen-8");
  chain.mine();
  // More import fees arrive: only the import part is due; the gen-8 part stays paid.
  earned.crypticpump = 420n;
  const third = await pass(db, chain, true, g8settings);
  assert.deepEqual(third.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["120", "0"]]);
  chain.mine();
  const fourth = await pass(db, chain, true, g8settings);
  assert.equal(fourth.partnerPayouts.length, 0);
  assert.equal(fourth.sweep?.amount, "250", "1000 of ours - 200 gen-8, capped at maxPayoutPerTx 250");
  const partnerSent = sentTransfers(db);
  assert.equal(partnerSent.reduce((n: bigint, t: any) => n + t.amount_raw, 0n), 620n, "420 import + 200 gen-8");
  assert.equal(partnerSent.reduce((n: bigint, t: any) => n + t.gen8_raw, 0n), 200n);
});

test("gen-8: GEN8_PARTNER_PAYOUT_SEND off lists the gen-8 part and pays only the import part; the sweep still reserves it", async () => {
  const db = fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 300n }, halves: 1_000n, gen8: { earned: { crypticpump: 200n } } });
  const chain = fakeChain({ balance: 1_300n });
  const out = await pass(db, chain, true, { ...g8settings, gen8Send: false });
  assert.deepEqual(out.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["300", "0"]]);
  assert.deepEqual(out.gen8?.planned, [{ partner: "crypticpump", dueWei: "200", payableWei: "200" }]);
  chain.mine();
  const next = await pass(db, chain, true, { ...g8settings, gen8Send: false });
  assert.equal(next.sweep?.amount, "800", "1000 - the 200 still owed");
  chain.mine();
  await pass(db, chain, true, { ...g8settings, gen8Send: false });
  assert.equal(chain.vault.balance, 200n, "the partner's 200 stays in the vault");
});

test("gen-8: an inactive partner is still paid what it earned; a contract wallet is never paid and its due stays reserved", async () => {
  const contract = "0x3334567890123456789012345678901234567890";
  const db = fakeDb({ partners: [cryptic({ active: false }), cryptic({ id: "boxed", payout_wallet: contract })], halves: 1_000n, gen8: { earned: { crypticpump: 150n, boxed: 300n } } });
  const chain = fakeChain({ balance: 1_000n, contracts: [contract] });
  const out = await pass(db, chain, true, g8settings);
  assert.deepEqual(out.partnerPayouts.map((p) => [p.partner, p.amount]), [["crypticpump", "150"]]);
  assert.ok(out.skipped.some((s) => /partner boxed: payout wallet .* is a contract/.test(s)));
  chain.mine();
  const next = await pass(db, chain, true, g8settings);
  assert.equal(next.sweep?.amount, "550", "1000 - 150 paid - 300 reserved for the contract-wallet partner");
});

test("gen-8: dry run reads only; without the migration the pass is unchanged (no gen8 block, no gen8_raw written)", async () => {
  const db = fakeDb({ accruals: accruals([500n]), owners: [verified()], partners: [cryptic()], halves: 1_000n, gen8: { earned: { crypticpump: 300n } } });
  const dry = await pass(db, fakeChain({ balance: 2_000n }), false, g8settings);
  assert.equal(dry.payouts.length, 1);
  assert.deepEqual(dry.partnerPayouts.map((p) => [p.amount, p.gen8Amount, p.hash]), [["300", "300", null]]);
  assert.ok(db.calls.every((sql) => !/^(insert|update|begin)/i.test(sql)), "read-only");
  const off = await pass(fakeDb({ partners: [cryptic()], partnerEarned: { crypticpump: 300n }, halves: 1_000n }), fakeChain({}), true, g8settings);
  assert.equal(off.gen8, undefined);
  assert.deepEqual(off.partnerPayouts.map((p) => [p.amount, p.gen8Amount]), [["300", undefined]]);
});
