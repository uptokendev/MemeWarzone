import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  keccak256,
  randomBytes,
  hexlify,
} from "ethers";

import { pool } from "../../server/db.js";
import { buildWalletActionMessage } from "./walletActionAuth.js";
import {
  bnbNormalBattleEntitlementIdentity,
  recoverBnbNormalBattleClaim,
} from "./bnbBattleClaimRecovery.js";
import { verifyEvmRewardClaim } from "./rewardClaimVerification.js";
import {
  rewardClaimIntent,
  rewardClaimRecord,
} from "../dev-fix/reward-claim-intent.js";

const CHAIN_ID = 97;
const RPC_URL = process.env.BSC_RPC_HTTP_97 || "http://127.0.0.1:8545";
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const coder = AbiCoder.defaultAbiCoder();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

let owner;
let user;
let other;
let distributor;
let distributorAddress;
let sequence = 0;

function bytes32() {
  return hexlify(randomBytes(32));
}

function uuid() {
  const h = Buffer.from(randomBytes(16)).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function leafFor(account, amount) {
  const inner = keccak256(coder.encode(["address", "uint256"], [account, BigInt(amount)]));
  return keccak256(inner);
}

async function resetSchema() {
  await pool.query(`drop table if exists public.reward_audit_logs, public.reward_batch_items, public.reward_batches, public.reward_ledger, public.auth_nonces cascade`);
  await pool.query(`create table public.auth_nonces (
    chain_id integer not null, address text not null, nonce text not null,
    used_at timestamptz, expires_at timestamptz not null,
    primary key(chain_id,address,nonce)
  )`);
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
}

async function createBatchAndEntitlement({ amount = 1000000000000000n, status = "claim_pending", sourceId, rowAmount = null, rowBatchId = null, recordedTx = null } = {}) {
  sequence += 1;
  const wallet = (await user.getAddress()).toLowerCase();
  const contractBatchId = bytes32();
  const root = leafFor(await user.getAddress(), amount);
  const latest = await provider.getBlock("latest");
  await (await distributor.connect(owner).authorizeBatch(contractBatchId, amount, 0, BigInt(latest.timestamp + 3600))).wait();
  await (await distributor.connect(owner).createBatch(contractBatchId, root, BigInt(latest.timestamp + 7200), { value: amount })).wait();

  const ledgerId = uuid();
  const dbBatchId = uuid();
  const metadata = {
    contractBatchId: rowBatchId || contractBatchId,
    merkleBatchId: rowBatchId || contractBatchId,
    merkleRoot: root,
    merkleProof: [],
    claimAmount: String(rowAmount ?? amount),
    distributorAddress,
    rewardDistributorAddress: distributorAddress,
    battleVersion: "normal-v1",
    epoch: `cert-${sequence}`,
  };
  await pool.query(
    `insert into public.reward_batches
      (id,reward_type,chain,token_symbol,status,total_amount,recipient_count,claimable_count,source,metadata)
     values ($1,'battle','97','BNB','claim_open',$2,1,1,$3,$4::jsonb)`,
    [dbBatchId, String(rowAmount ?? amount), sourceId || `battle-${sequence}`, JSON.stringify({ contractBatchId, merkleRoot: root })],
  );
  await pool.query(
    `insert into public.reward_ledger
      (id,reward_type,source_id,source_label,wallet_address,chain,token_symbol,amount,status,claim_tx_hash,metadata,claimable_at)
     values ($1,'battle',$2,'Normal Battle prize',$3,'97','BNB',$4,$5,$6,$7::jsonb,now())`,
    [ledgerId, sourceId || `battle-${sequence}`, wallet, String(rowAmount ?? amount), status, recordedTx, JSON.stringify(metadata)],
  );
  await pool.query(
    `insert into public.reward_batch_items (id,batch_id,reward_ledger_id,wallet_address,amount,status,metadata)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [uuid(), dbBatchId, ledgerId, wallet, String(rowAmount ?? amount), status, JSON.stringify(metadata)],
  );
  const row = (await pool.query(`select * from public.reward_ledger where id=$1::uuid`, [ledgerId])).rows[0];
  return { ledgerId, dbBatchId, contractBatchId, root, amount, wallet, row };
}

async function signAuth(signer, walletAddress, action, chainId = CHAIN_ID) {
  const nonce = `agent5-${Date.now()}-${Math.random()}`;
  await pool.query(
    `insert into public.auth_nonces(chain_id,address,nonce,expires_at) values ($1,$2,$3,now()+interval '10 minutes')`,
    [chainId, walletAddress.toLowerCase(), nonce],
  );
  const message = buildWalletActionMessage({ action, walletAddress, chainId, nonce });
  return {
    action,
    walletAddress,
    address: walletAddress,
    chainId,
    nonce,
    message,
    signature: await signer.signMessage(message),
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return value; },
    setHeader(name, value) { this.headers[name] = value; },
    end(value) {
      try { this.payload = value ? JSON.parse(String(value)) : null; } catch { this.payload = value; }
    },
  };
}

async function callHandler(handler, body) {
  const req = { method: "POST", body, headers: {} };
  const res = mockResponse();
  await handler(req, res);
  return res;
}

async function claimOnChain(batch) {
  const tx = await distributor.connect(user).claim(batch.contractBatchId, batch.amount, []);
  const receipt = await tx.wait();
  return { tx, receipt };
}

before(async () => {
  await resetSchema();
  owner = await provider.getSigner(0);
  user = await provider.getSigner(1);
  other = await provider.getSigner(2);
  const artifactPath = path.join(repoRoot, ".agent5-artifacts/contracts/RewardDistributor.sol/RewardDistributor.json");
  const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
  distributor = await factory.deploy(await owner.getAddress());
  await distributor.waitForDeployment();
  distributorAddress = await distributor.getAddress();
});

after(async () => {
  await pool.end();
  await provider.destroy();
});

test("1 normal claim -> record", async () => {
  const batch = await createBatchAndEntitlement();
  const { tx } = await claimOnChain(batch);
  const auth = await signAuth(user, batch.wallet, "claim_record");
  const res = await callHandler(rewardClaimRecord, {
    walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId],
    txHash: tx.hash, status: "claimed", auth,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
});

test("2 chain success -> process death -> restart/retry reconciles from chain", async () => {
  const batch = await createBatchAndEntitlement();
  const { tx } = await claimOnChain(batch);
  const beforeRow = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(beforeRow.status, "claim_pending");
  assert.equal(beforeRow.claim_tx_hash, null);

  const auth = await signAuth(user, batch.wallet, "claim_intent");
  const res = await callHandler(rewardClaimIntent, {
    walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.claimIntent.requiresWalletTransaction, false);
  assert.equal(res.payload.claimIntent.calls.length, 0);
  assert.equal(res.payload.recovered, true);
  const row = (await pool.query(`select status,claim_tx_hash,metadata from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
  assert.equal(row.metadata.claimRecovery.entitlement.battleSourceId, batch.row.source_id);
});

test("3 + 10 retry after recovered success is idempotent and cannot request second payout", async () => {
  const batch = await createBatchAndEntitlement();
  const { tx } = await claimOnChain(batch);
  let auth = await signAuth(user, batch.wallet, "claim_intent");
  let res = await callHandler(rewardClaimIntent, { walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));

  const claimedBefore = await distributor.hasClaimed(batch.contractBatchId, await user.getAddress());
  const totalBefore = (await distributor.batches(batch.contractBatchId)).totalClaimed;
  auth = await signAuth(user, batch.wallet, "claim_intent");
  res = await callHandler(rewardClaimIntent, { walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.claimIntent.requiresWalletTransaction, false);
  assert.equal(res.payload.claimIntent.calls.length, 0);
  assert.equal(res.payload.idempotent, true);
  assert.equal(await distributor.hasClaimed(batch.contractBatchId, await user.getAddress()), claimedBefore);
  assert.equal((await distributor.batches(batch.contractBatchId)).totalClaimed, totalBefore);
  const row = (await pool.query(`select claim_tx_hash from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
});

test("4 two simultaneous recovery attempts converge on one final state", async () => {
  const batch = await createBatchAndEntitlement();
  const { tx } = await claimOnChain(batch);
  const [authA, authB] = await Promise.all([
    signAuth(user, batch.wallet, "claim_intent"),
    signAuth(user, batch.wallet, "claim_intent"),
  ]);
  const [a, b] = await Promise.all([
    callHandler(rewardClaimIntent, { walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth: authA }),
    callHandler(rewardClaimIntent, { walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth: authB }),
  ]);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(b.statusCode, 200, JSON.stringify(b.payload));
  assert.equal(a.payload.claimIntent.calls.length + b.payload.claimIntent.calls.length, 0);
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claimed");
  assert.equal(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
  const audits = await pool.query(`select count(*)::int n from public.reward_audit_logs where reward_ledger_id=$1::uuid and action='battle_claim_reconciled_onchain'`, [batch.ledgerId]);
  assert.equal(audits.rows[0].n, 1);
});

test("5 wrong transaction/event is rejected", async () => {
  const batch = await createBatchAndEntitlement();
  const wrongTx = await user.sendTransaction({ to: distributorAddress, value: 1n });
  await wrongTx.wait();
  await assert.rejects(
    () => verifyEvmRewardClaim({
      chainId: CHAIN_ID, txHash: wrongTx.hash, walletAddress: batch.wallet,
      distributorAddress, batchId: batch.contractBatchId, amount: batch.amount,
    }),
    (error) => error?.code === "CLAIM_CALL_MISMATCH" || error?.code === "CLAIM_EVENT_MISSING",
  );
});

test("6 wrong recipient is rejected", async () => {
  const batch = await createBatchAndEntitlement();
  assert.throws(
    () => bnbNormalBattleEntitlementIdentity(batch.row, { requestedChainId: CHAIN_ID, requestedWallet: awaitAddress(other) }),
    (error) => error?.code === "CLAIM_WALLET_MISMATCH",
  );
});

async function awaitAddress(signer) { return signer.getAddress(); }

test("7 wrong chain is rejected", async () => {
  const batch = await createBatchAndEntitlement();
  assert.throws(
    () => bnbNormalBattleEntitlementIdentity(batch.row, { requestedChainId: 56, requestedWallet: batch.wallet }),
    (error) => error?.code === "REWARD_CHAIN_MISMATCH",
  );
});

test("8 wrong amount and batch are rejected by authoritative evidence", async () => {
  const batch = await createBatchAndEntitlement();
  const { tx } = await claimOnChain(batch);
  await assert.rejects(
    () => recoverBnbNormalBattleClaim({
      row: { ...batch.row, amount: String(batch.amount + 1n) },
      requestedChainId: CHAIN_ID, requestedWallet: batch.wallet,
    }),
    (error) => error?.code === "CLAIM_AMOUNT_MISMATCH",
  );
  await assert.rejects(
    () => verifyEvmRewardClaim({
      chainId: CHAIN_ID, txHash: tx.hash, walletAddress: batch.wallet,
      distributorAddress, batchId: bytes32(), amount: batch.amount,
    }),
    (error) => error?.code === "CLAIM_BATCH_MISMATCH",
  );
});

test("9 existing recorded transaction cannot be overwritten", async () => {
  const fakeTx = bytes32();
  const batch = await createBatchAndEntitlement({ recordedTx: fakeTx });
  const { tx } = await claimOnChain(batch);
  const auth = await signAuth(user, batch.wallet, "claim_intent");
  const res = await callHandler(rewardClaimIntent, {
    walletAddress: batch.wallet, chainId: CHAIN_ID, rewardLedgerIds: [batch.ledgerId], auth,
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.payload));
  assert.equal(res.payload.code, "CLAIM_ALREADY_RECORDED");
  const row = (await pool.query(`select status,claim_tx_hash from public.reward_ledger where id=$1::uuid`, [batch.ledgerId])).rows[0];
  assert.equal(row.status, "claim_pending");
  assert.equal(row.claim_tx_hash.toLowerCase(), fakeTx.toLowerCase());
  assert.notEqual(row.claim_tx_hash.toLowerCase(), tx.hash.toLowerCase());
});
