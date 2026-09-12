import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { AbiCoder, ContractFactory, JsonRpcProvider, hexlify, keccak256, randomBytes } from "ethers";

import { pool } from "../../server/db.js";
import rewardsHandler from "../rewards.js";
import leagueRouter from "../leagueRouter.js";
import leaguePayouts from "../leaguePayouts.js";
import { verifyEvmRewardClaim } from "./rewardClaimVerification.js";
import { buildExpectedEvmLeagueClaim, verifyEvmLeagueClaimTransaction } from "./evmLeagueClaimVerification.js";

const CHAIN_ID = 97;
const RPC_URL = process.env.BSC_RPC_HTTP_97 || "http://127.0.0.1:8545";
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const coder = AbiCoder.defaultAbiCoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let owner;
let user;
let other;
let rootPoster;
let distributor;
let distributorAddress;
let vault;
let vaultAddress;
let sequence = 0;

function bytes32() { return hexlify(randomBytes(32)); }
function uuid() {
  const h = Buffer.from(randomBytes(16)).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function leafFor(account, amount) {
  return keccak256(keccak256(coder.encode(["address", "uint256"], [account, BigInt(amount)])));
}
function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = Number(code); return this; },
    json(value) { this.payload = value; return value; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value) {
      if (value == null || value === "") this.payload = null;
      else { try { this.payload = JSON.parse(String(value)); } catch { this.payload = value; } }
      return this.payload;
    },
  };
}
async function callHandler(handler, body, headers = {}) {
  const req = { method: "POST", body, headers, protocol: "http", url: "/", originalUrl: "/" };
  const res = mockResponse();
  await handler(req, res);
  return res;
}

async function resetSchema() {
  await pool.query(`drop table if exists public.league_epoch_claims, public.league_epoch_payouts, public.league_epoch_winners, public.reward_audit_logs, public.reward_batch_items, public.reward_batches, public.reward_ledger cascade`);
  await pool.query(`create table public.reward_ledger (
    id uuid primary key, reward_type text not null, source_id text, source_label text,
    wallet_address text not null, user_id text, chain text not null, token_symbol text not null,
    amount numeric(78,0) not null, amount_usd numeric(20,6), status text not null,
    claim_batch_id text, claim_tx_hash text, claim_error text, metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    claimable_at timestamptz, claimed_at timestamptz, expires_at timestamptz
  )`);
  await pool.query(`create table public.reward_batches (
    id uuid primary key, reward_type text not null, chain text not null, token_symbol text not null,
    status text not null, total_amount numeric(78,0) not null default 0,
    recipient_count integer not null default 0, claimable_count integer not null default 0,
    claimed_count integer not null default 0, failed_count integer not null default 0,
    source text, metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    published_at timestamptz, closed_at timestamptz
  )`);
  await pool.query(`create table public.reward_batch_items (
    id uuid primary key, batch_id uuid not null references public.reward_batches(id),
    reward_ledger_id uuid references public.reward_ledger(id), wallet_address text not null,
    amount numeric(78,0) not null, status text not null, metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create table public.reward_audit_logs (
    id uuid primary key default gen_random_uuid(), batch_id uuid, reward_ledger_id uuid,
    actor_type text not null, actor_id text, action text not null, old_value text, new_value text,
    reason text, tx_hash text, metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create table public.league_epoch_winners (
    chain_id integer not null, period text not null, epoch_start timestamptz not null,
    epoch_end timestamptz, expires_at timestamptz, category text not null, rank integer not null,
    recipient_address text not null, amount_raw numeric(78,0) not null,
    payload jsonb default '{}'::jsonb, computed_at timestamptz default now(),
    primary key(chain_id,period,epoch_start,category,rank)
  )`);
  await pool.query(`create table public.league_epoch_payouts (
    chain_id integer not null, period text not null, epoch_start timestamptz not null,
    category text not null, rank integer not null, recipient_address text not null,
    amount_raw numeric(78,0) not null, tx_hash text, paid_at timestamptz,
    primary key(chain_id,period,epoch_start,category,rank)
  )`);
  await pool.query(`create table public.league_epoch_claims (
    chain_id integer not null, period text not null, epoch_start timestamptz not null,
    category text not null, rank integer not null, recipient_address text not null,
    signature text, claimed_at timestamptz default now(),
    primary key(chain_id,period,epoch_start,category,rank)
  )`);
}

async function resetLeagueRows() {
  await pool.query(`delete from public.league_epoch_claims`);
  await pool.query(`delete from public.league_epoch_payouts`);
  await pool.query(`delete from public.league_epoch_winners`);
}

async function createGenericEntitlement({ rewardType = "airdrop", amount = 1000000000000000n, recordedTx = null, reuseMetadata = null } = {}) {
  sequence += 1;
  const wallet = (await user.getAddress()).toLowerCase();
  let metadata = reuseMetadata;
  let batchId;
  if (!metadata) {
    batchId = bytes32();
    const root = leafFor(await user.getAddress(), amount);
    const latest = await provider.getBlock("latest");
    await (await distributor.connect(owner).authorizeBatch(batchId, amount, 0, BigInt(latest.timestamp + 3600))).wait();
    await (await distributor.connect(owner).createBatch(batchId, root, BigInt(latest.timestamp + 7200), { value: amount })).wait();
    metadata = { contractBatchId: batchId, merkleBatchId: batchId, merkleRoot: root, merkleProof: [], distributorAddress, rewardDistributorAddress: distributorAddress };
  } else batchId = metadata.contractBatchId;

  const ledgerId = uuid();
  const dbBatchId = uuid();
  await pool.query(
    `insert into public.reward_batches(id,reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,source,metadata)
     values ($1,$2,'97','BNB','claim_open',$3,1,1,$4,$5::jsonb)`,
    [dbBatchId, rewardType, String(amount), `agent5-${rewardType}-${sequence}`, JSON.stringify(metadata)],
  );
  await pool.query(
    `insert into public.reward_ledger(id,reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,claim_tx_hash,metadata,claimable_at)
     values ($1,$2,$3,$4,$5,'97','BNB',$6,'claim_pending',$7,$8::jsonb,now())`,
    [ledgerId, rewardType, `src-${sequence}`, `${rewardType} claim`, wallet, String(amount), recordedTx, JSON.stringify(metadata)],
  );
  await pool.query(
    `insert into public.reward_batch_items(id,batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
     values ($1,$2,$3,$4,$5,'claim_pending',$6::jsonb)`,
    [uuid(), dbBatchId, ledgerId, wallet, String(amount), JSON.stringify(metadata)],
  );
  return { ledgerId, batchId, amount, wallet, metadata };
}
async function claimGeneric(batch) {
  const tx = await distributor.connect(user).claim(batch.batchId, batch.amount, []);
  await tx.wait();
  return tx;
}
async function reconcileGeneric(batch) {
  return callHandler(rewardsHandler, { action: "reconcile-evm-claims", chainId: CHAIN_ID, walletAddress: batch.wallet, rewardLedgerIds: [batch.ledgerId] });
}

async function createLeagueClaim({ category = "top_earner", rank = 1, amount = 2000000000000000n } = {}) {
  sequence += 1;
  const recipient = await user.getAddress();
  const epochStart = new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)).toISOString();
  const expected = buildExpectedEvmLeagueClaim({ chainId: CHAIN_ID, period: "weekly", epochStart, category, rank, recipient, amountRaw: String(amount) });
  const latest = await provider.getBlock("latest");
  await (await vault.connect(owner).authorizeEpoch(expected.epochId, amount, BigInt(latest.timestamp - 1), BigInt(latest.timestamp + 7200))).wait();
  await (await vault.connect(rootPoster).setEpochRoot(expected.epochId, expected.leaf, amount)).wait();
  const tx = await vault.connect(user).claim(expected.epochId, expected.categoryHash, expected.rank, recipient, amount, []);
  await tx.wait();
  await pool.query(
    `insert into public.league_epoch_winners(chain_id,period,epoch_start,epoch_end,expires_at,category,rank,recipient_address,amount_raw)
     values ($1,'weekly',$2::timestamptz,now()-interval '1 hour',now()+interval '1 day',$3,$4,$5,$6)`,
    [CHAIN_ID, epochStart, category, rank, recipient.toLowerCase(), String(amount)],
  );
  return { epochStart, category, rank, amount, recipient, expected, tx };
}

before(async () => {
  await resetSchema();
  owner = await provider.getSigner(0);
  user = await provider.getSigner(1);
  other = await provider.getSigner(2);
  rootPoster = await provider.getSigner(3);

  const rewardArtifact = JSON.parse(await fs.readFile(path.join(repoRoot, ".agent5-artifacts/contracts/RewardDistributor.sol/RewardDistributor.json"), "utf8"));
  distributor = await new ContractFactory(rewardArtifact.abi, rewardArtifact.bytecode, owner).deploy(await owner.getAddress());
  await distributor.waitForDeployment();
  distributorAddress = await distributor.getAddress();
  process.env.REWARD_DISTRIBUTOR_ADDRESS_97 = distributorAddress;

  const vaultArtifact = JSON.parse(await fs.readFile(path.join(repoRoot, ".agent5-artifacts/contracts/TreasuryVaultV2.sol/TreasuryVaultV2.json"), "utf8"));
  vault = await new ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, owner).deploy(await owner.getAddress(), await other.getAddress(), await rootPoster.getAddress());
  await vault.waitForDeployment();
  vaultAddress = await vault.getAddress();
  process.env.TREASURY_VAULT_V2_ADDRESS_97 = vaultAddress;
  process.env.LEAGUE_ADMIN_TOKEN = "agent5-test";
  await (await owner.sendTransaction({ to: vaultAddress, value: 100000000000000000n })).wait();
  await (await vault.connect(owner).setClaimCaps(10000000000000000n, 100000000000000000n)).wait();
  await (await vault.connect(owner).setClaimsPaused(false)).wait();
});

after(async () => {
  await pool.end();
  await provider.destroy();
});

test("generic EVM airdrop chain-success/API-crash recovery is idempotent", async () => {
  const batch = await createGenericEntitlement({ rewardType: "airdrop" });
  const tx = await claimGeneric(batch);
  const first = await reconcileGeneric(batch);
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.reconciledCount, 1, JSON.stringify(first.payload));
  assert.equal(first.payload.items[0].txHash.toLowerCase(), tx.hash.toLowerCase());
  const retry = await reconcileGeneric(batch);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.reconciledCount, 0);
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
});

test("generic EVM recruiter chain-success/API-crash recovery is idempotent", async () => {
  const batch = await createGenericEntitlement({ rewardType: "recruiter" });
  const tx = await claimGeneric(batch);
  const first = await reconcileGeneric(batch);
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.reconciledCount, 1, JSON.stringify(first.payload));
  assert.equal(first.payload.items[0].txHash.toLowerCase(), tx.hash.toLowerCase());
  const retry = await reconcileGeneric(batch);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.reconciledCount, 0);
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
});

test("generic EVM squad true concurrency produces one durable completion", async () => {
  const batch = await createGenericEntitlement({ rewardType: "squad" });
  const tx = await claimGeneric(batch);
  const [a, b] = await Promise.all([reconcileGeneric(batch), reconcileGeneric(batch)]);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(b.statusCode, 200, JSON.stringify(b.payload));
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
  const audits = await pool.query(`select count(*)::int as n from public.reward_audit_logs where reward_ledger_id=$1 and action='claim_reconciled_onchain'`, [batch.ledgerId]);
  assert.equal(audits.rows[0].n, 1);
});

test("generic EVM verifier rejects wrong tx, recipient, chain and amount", async () => {
  const batch = await createGenericEntitlement({ rewardType: "airdrop" });
  const tx = await claimGeneric(batch);
  const otherAddress = await other.getAddress();
  const wrongTx = await user.sendTransaction({ to: distributorAddress, value: 1n });
  await wrongTx.wait();
  await assert.rejects(
    () => verifyEvmRewardClaim({ chainId: CHAIN_ID, txHash: wrongTx.hash, walletAddress: batch.wallet, distributorAddress, batchId: batch.batchId, amount: batch.amount }),
    (error) => ["CLAIM_CALL_MISMATCH", "CLAIM_EVENT_MISSING"].includes(error?.code),
  );
  await assert.rejects(
    () => verifyEvmRewardClaim({ chainId: CHAIN_ID, txHash: tx.hash, walletAddress: otherAddress, distributorAddress, batchId: batch.batchId, amount: batch.amount }),
    (error) => error?.code === "CLAIM_WALLET_MISMATCH",
  );
  await assert.rejects(
    () => verifyEvmRewardClaim({ chainId: CHAIN_ID, txHash: tx.hash, walletAddress: batch.wallet, distributorAddress, batchId: batch.batchId, amount: batch.amount + 1n }),
    (error) => error?.code === "CLAIM_AMOUNT_MISMATCH",
  );
  await assert.rejects(
    () => verifyEvmRewardClaim({ chainId: 56, txHash: tx.hash, walletAddress: batch.wallet, distributorAddress, batchId: batch.batchId, amount: batch.amount }),
    (error) => ["CLAIM_TX_NOT_FOUND", "CLAIM_RPC_UNAVAILABLE", "CLAIM_RPC_CHAIN_MISMATCH", "CLAIM_CHAIN_MISMATCH"].includes(error?.code),
  );
});

test("generic EVM transaction reuse is rejected", async () => {
  const first = await createGenericEntitlement({ rewardType: "airdrop" });
  await claimGeneric(first);
  const firstReconcile = await reconcileGeneric(first);
  assert.equal(firstReconcile.payload.reconciledCount, 1);
  const second = await createGenericEntitlement({ rewardType: "airdrop", reuseMetadata: first.metadata });
  const secondReconcile = await reconcileGeneric(second);
  assert.equal(secondReconcile.statusCode, 200);
  assert.equal(secondReconcile.payload.unresolved[0].code, "CLAIM_TX_REUSED");
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1`, [second.ledgerId])).rows[0];
  assert.equal(row.status, "claim_pending");
  assert.equal(row.claim_tx_hash, null);
});

test("generic EVM recorded transaction is immutable", async () => {
  const fakeTx = bytes32();
  const batch = await createGenericEntitlement({ rewardType: "squad", recordedTx: fakeTx });
  const realTx = await claimGeneric(batch);
  const result = await reconcileGeneric(batch);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.unresolved[0].code, "CLAIM_ALREADY_RECORDED");
  const row = (await pool.query(`select claim_tx_hash from public.reward_ledger where id=$1`, [batch.ledgerId])).rows[0];
  assert.equal(row.claim_tx_hash.toLowerCase(), fakeTx.toLowerCase());
  assert.notEqual(row.claim_tx_hash.toLowerCase(), realTx.hash.toLowerCase());
});

test("EVM League chain-success/API-crash recovery records exact payout and repeat is inert", async () => {
  await resetLeagueRows();
  const claim = await createLeagueClaim();
  const first = await callHandler(leagueRouter, { action: "reconcile-evm-claims", chainId: CHAIN_ID, recipient: claim.recipient });
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.reconciledCount, 1, JSON.stringify(first.payload));
  const row = (await pool.query(
    `select tx_hash,recipient_address,amount_raw::text as amount_raw from public.league_epoch_payouts
      where chain_id=$1 and period='weekly' and epoch_start=$2::timestamptz and category=$3 and rank=$4`,
    [CHAIN_ID, claim.epochStart, claim.category, claim.rank],
  )).rows[0];
  assert.equal(row.tx_hash.toLowerCase(), claim.tx.hash.toLowerCase());
  assert.equal(row.recipient_address.toLowerCase(), claim.recipient.toLowerCase());
  assert.equal(row.amount_raw, String(claim.amount));
  const retry = await callHandler(leagueRouter, { action: "reconcile-evm-claims", chainId: CHAIN_ID, recipient: claim.recipient });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.reconciledCount, 0);
});

test("EVM League concurrent recovery converges on one immutable tx", async () => {
  await resetLeagueRows();
  const claim = await createLeagueClaim({ category: "biggest_hit" });
  const [a, b] = await Promise.all([
    callHandler(leagueRouter, { action: "reconcile-evm-claims", chainId: CHAIN_ID, recipient: claim.recipient }),
    callHandler(leagueRouter, { action: "reconcile-evm-claims", chainId: CHAIN_ID, recipient: claim.recipient }),
  ]);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(b.statusCode, 200, JSON.stringify(b.payload));
  const rows = await pool.query(
    `select tx_hash from public.league_epoch_payouts where chain_id=$1 and period='weekly' and epoch_start=$2::timestamptz and category=$3 and rank=$4`,
    [CHAIN_ID, claim.epochStart, claim.category, claim.rank],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].tx_hash.toLowerCase(), claim.tx.hash.toLowerCase());
});

test("EVM League verifier rejects wrong recipient/amount/epoch/category/rank/tx", async () => {
  await resetLeagueRows();
  const claim = await createLeagueClaim({ category: "fastest_finish" });
  const otherAddress = await other.getAddress();
  const base = { chainId: CHAIN_ID, period: "weekly", epochStart: claim.epochStart, category: claim.category, rank: claim.rank, recipient: claim.recipient, amountRaw: String(claim.amount), txHash: claim.tx.hash };
  const cases = [
    [{ ...base, recipient: otherAddress }, "LEAGUE_RECIPIENT_MISMATCH"],
    [{ ...base, amountRaw: String(claim.amount + 1n) }, "LEAGUE_AMOUNT_MISMATCH"],
    [{ ...base, epochStart: "2026-09-02T00:00:00.000Z" }, "LEAGUE_EPOCH_MISMATCH"],
    [{ ...base, category: "crowd_favorite" }, "LEAGUE_CATEGORY_MISMATCH"],
    [{ ...base, rank: 2 }, "LEAGUE_RANK_MISMATCH"],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(() => verifyEvmLeagueClaimTransaction(input), (error) => error?.code === code);
  }
  const wrongTx = await user.sendTransaction({ to: vaultAddress, value: 1n });
  await wrongTx.wait();
  await assert.rejects(
    () => verifyEvmLeagueClaimTransaction({ ...base, txHash: wrongTx.hash }),
    (error) => ["LEAGUE_CALL_MISMATCH", "LEAGUE_EVENT_MISSING"].includes(error?.code),
  );
});

test("League admin completion cannot overwrite or reuse a recorded tx", async () => {
  await resetLeagueRows();
  const claim = await createLeagueClaim({ category: "crowd_favorite" });
  const recovered = await callHandler(leagueRouter, { action: "reconcile-evm-claims", chainId: CHAIN_ID, recipient: claim.recipient });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.payload.reconciledCount, 1);

  const overwrite = await callHandler(leaguePayouts, {
    chainId: CHAIN_ID, period: "weekly", epochStart: claim.epochStart, txHash: bytes32(),
    payouts: [{ category: claim.category, rank: claim.rank, recipient: claim.recipient, amountRaw: String(claim.amount) }],
  }, { "x-admin-token": "agent5-test" });
  assert.equal(overwrite.statusCode, 409, JSON.stringify(overwrite.payload));
  assert.equal(overwrite.payload.code, "LEAGUE_PAYOUT_ALREADY_RECORDED");

  const second = await createLeagueClaim({ category: "perfect_run" });
  const reuse = await callHandler(leaguePayouts, {
    chainId: CHAIN_ID, period: "weekly", epochStart: second.epochStart, txHash: claim.tx.hash,
    payouts: [{ category: second.category, rank: second.rank, recipient: second.recipient, amountRaw: String(second.amount) }],
  }, { "x-admin-token": "agent5-test" });
  assert.equal(reuse.statusCode, 409, JSON.stringify(reuse.payload));
  assert.equal(reuse.payload.code, "LEAGUE_TX_ALREADY_USED");
});