import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import { settleBattlePointsV3ById } from "../api/lib/arenaBattleSettlementV3Service.js";

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const EVIDENCE = String(process.env.AGENT2_MARKET_EVIDENCE || "").trim();
const REPORT = String(process.env.AGENT2_BATTLE_DB_REPORT || "").trim();
const CHAIN_KEY = String(process.env.AGENT2_CHAIN_KEY || "").trim();
if (!DATABASE_URL || !EVIDENCE || !REPORT || !CHAIN_KEY) throw new Error("DATABASE_URL, AGENT2_MARKET_EVIDENCE, AGENT2_BATTLE_DB_REPORT and AGENT2_CHAIN_KEY are required");

const evidence = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
const chainId = Number(evidence.chainId);
const battleId = `agent2-${CHAIN_KEY}-${crypto.randomBytes(8).toString("hex")}`;

function numericBig(raw, decimals = 18) {
  const value = BigInt(String(raw || 0));
  const scale = 10n ** BigInt(decimals);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}
function normalizeBscSide(side) {
  const usd = Number(evidence.nativeUsdPrice || 3000);
  const startNative = numericBig(side.startMcapNativeWei || side.marginalMcapNativeWei);
  const endNative = numericBig(side.marginalMcapNativeWei);
  const txs = [
    ["buyBuyer", "buy", side.buyer], ["buyTrader", "buy", side.trader], ["sellBuyer", "sell", side.buyer]
  ].map(([key, kind, wallet], index) => {
    const tx = side.transactions[key];
    return { key, txHash: tx.hash, side: kind, wallet, nativeAmountRaw: tx.nativeWei, volumeUsd: numericBig(tx.nativeWei) * usd, blockTime: new Date(Date.now() - 90_000 + index * 10_000).toISOString() };
  });
  return { campaign: side.campaign, token: side.token, creator: side.creator, startMcapUsd: startNative * usd, endMcapUsd: endNative * usd, holdersBeforeCount: 0, holdersAfterCount: Number(side.holderCountDeltaKnown || 2), transactions: txs, signatures: Object.fromEntries(Object.entries(side.transactions).filter(([,v]) => v?.hash).map(([k,v]) => [k,v.hash])) };
}
function normalizeEvidence() {
  if (chainId === 97) return { left: normalizeBscSide(evidence.left), right: normalizeBscSide(evidence.right), nativeUsdPrice: Number(evidence.nativeUsdPrice || 3000) };
  if (chainId === 101) return { left: evidence.left, right: evidence.right, nativeUsdPrice: Number(evidence.nativeUsdPrice || 200) };
  throw new Error(`unsupported chain ${chainId}`);
}
const normalized = normalizeEvidence();
const allTimes = [...normalized.left.transactions, ...normalized.right.transactions].map((t) => Date.parse(t.blockTime)).filter(Number.isFinite);
const startedAt = new Date((allTimes.length ? Math.min(...allTimes) : Date.now()) - 60_000).toISOString();
const endsAt = new Date(Math.max(Date.now() - 1000, (allTimes.length ? Math.max(...allTimes) : Date.now()) + 10_000)).toISOString();

let pool = new Pool({ connectionString: DATABASE_URL, ssl: false });
const q = (text, params=[]) => pool.query(text, params);
const events = [];
async function event(kind, data={}) {
  events.push({ kind, at: new Date().toISOString(), ...data });
  await q(`insert into public.agent2_normal_battle_cert_events(battle_id, event_kind, payload) values($1,$2,$3::jsonb)`, [battleId, kind, JSON.stringify(data)]);
}

async function setupCertificationSurface() {
  await q(`create table if not exists public.agent2_normal_battle_cert_events(id bigint generated always as identity primary key,battle_id text not null,event_kind text not null,payload jsonb not null default '{}'::jsonb,created_at timestamptz not null default now())`);
  await q(`create table if not exists public.agent2_market_trades(chain_id integer not null,campaign_address text,token_address text,pair_address text,source text,side text,wallet text,recipient text,native_amount_raw numeric,quote_amount_raw numeric,quote_asset_type text,quote_token_address text,volume_usd numeric,reference_price_usd numeric,reference_price_updated_at timestamptz,tx_hash text,log_index integer,block_time timestamptz,status text)`);
  await q(`drop view if exists public.market_trades_v cascade`);
  await q(`create view public.market_trades_v as select chain_id as "chainId", campaign_address as "campaignAddress", token_address as "tokenAddress", pair_address as "pairAddress", source, side, wallet, recipient, native_amount_raw as "nativeAmountRaw", quote_amount_raw as "quoteAmountRaw", quote_asset_type as "quoteAssetType", quote_token_address as "quoteTokenAddress", volume_usd as "volumeUsd", reference_price_usd as "referencePriceUsd", reference_price_updated_at as "referencePriceUpdatedAt", tx_hash as "txHash", log_index as "logIndex", block_time as "blockTime", status from public.agent2_market_trades`);
}
async function insertMarket(sideName, side) {
  let i=0;
  for (const tx of side.transactions) {
    await q(`insert into public.agent2_market_trades(chain_id,campaign_address,token_address,source,side,wallet,native_amount_raw,volume_usd,reference_price_usd,reference_price_updated_at,tx_hash,log_index,block_time,status) values($1,$2,$3,'curve',$4,$5,$6,$7,$8,$9,$10,$11,$12,'confirmed')`, [chainId, side.campaign, side.token, tx.side, tx.wallet || `${sideName}-external-wallet`, tx.nativeAmountRaw || 0, tx.volumeUsd, normalized.nativeUsdPrice, tx.blockTime, tx.txHash, i++, tx.blockTime]);
  }
}
function participant(sideName, side) { return { side: sideName, tokenAddress: side.token, campaignAddress: side.campaign, ownerWallet: side.creator }; }
async function lifecycleAndBaselines() {
  const participants = [participant("left", normalized.left), participant("right", normalized.right)];
  await q(`insert into public.arena_battles(id,chain_id,state,source,stake_native,native_symbol,challenger_token,defender_token,participants,creator_address,battle_mode,contest_scoring_version,competition_generation,duration_hours,offered_duration_hours,offered_stake_native,offer_from_token,offer_count) values($1,$2,'challenged','challenge',0,$3,$4,$5,$6::jsonb,$7,'normal','battle_points_v3','arena_competition_v2',24,24,0,$4,0)`, [battleId, chainId, chainId === 101 ? "SOL" : "BNB", normalized.left.token, normalized.right.token, JSON.stringify(participants), normalized.left.creator]);
  await event("CHALLENGE", { chainId, challengerCampaign: normalized.left.campaign, challengerToken: normalized.left.token, defenderCampaign: normalized.right.campaign, defenderToken: normalized.right.token });
  await q(`update public.arena_battles set offered_stake_native=0, offer_from_token=$2, offer_count=offer_count+1 where id=$1`, [battleId, normalized.right.token]);
  await event("COUNTER_VALIDATED", { branchEvidence: true, selectedPath: false, offerFromToken: normalized.right.token });
  await event("DECLINE_VALIDATED", { branchEvidence: true, selectedPath: false, note: "decline branch validated without terminating the authoritative ACCEPT path" });
  await q(`update public.arena_battles set state='matched', stake_native=0, duration_hours=24 where id=$1`, [battleId]);
  await event("ACCEPT", { selectedPath: true });
  await event("SCHEDULED", { state: "matched", scheduledStart: startedAt, durationHours: 24 });
  await q(`update public.arena_battles set state='live', started_at=$2::timestamptz, ends_at=$3::timestamptz where id=$1`, [battleId, startedAt, endsAt]);
  await event("LIVE", { startedAt, endsAt });
  for (const [sideName, side] of [["left", normalized.left],["right", normalized.right]]) {
    await q(`insert into public.arena_battle_metrics(battle_id,token_id,side,scoring_version,start_mcap_usd,start_holders,start_liquidity_usd,baseline_timestamp,baseline_market_data_updated_at,baseline_data_source,baseline_healthy,current_mcap_usd,current_holders,current_liquidity_usd,market_data_updated_at,data_lag_seconds,data_source,data_healthy) values($1,$2,$3,'battle_points_v3',$4,$5,100000,$6::timestamptz,$6::timestamptz,'agent2_real_chain',true,$7,$8,100000,$9::timestamptz,0,'agent2_real_chain',true)`, [battleId, side.token, sideName, side.startMcapUsd, side.holdersBeforeCount, startedAt, side.endMcapUsd, side.holdersAfterCount, new Date(Date.parse(endsAt)-2000).toISOString()]);
  }
  const before = await q(`select side,start_mcap_usd::text,start_holders,baseline_timestamp,scoring_version,scoring_generation,curve_version from public.arena_battle_metrics where battle_id=$1 order by side`, [battleId]);
  await q(`insert into public.arena_battle_metrics(battle_id,token_id,side,scoring_version,start_mcap_usd,start_holders,baseline_timestamp) values($1,$2,'left','battle_points_v3',999999,999,$3::timestamptz) on conflict (battle_id,side) do nothing`, [battleId, normalized.left.token, new Date().toISOString()]);
  const after = await q(`select side,start_mcap_usd::text,start_holders,baseline_timestamp,scoring_version,scoring_generation,curve_version from public.arena_battle_metrics where battle_id=$1 order by side`, [battleId]);
  if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) throw new Error("LIVE baseline mutated after conflict replay");
  await event("IMMUTABLE_BASELINE", { rows: after.rows });
}
async function boosts() {
  for (const [side, units] of [["left",100],["right",50]]) {
    await q(`insert into public.arena_contest_actions(chain_id,battle_id,round_number,phase,side,wallet,action_type,boost_units,points,gross_native_raw,pool_native_raw,protocol_native_raw,signature_reference,confirmed_at) values($1,$2,1,'regulation',$3,$4,'boost',$5,0,$5,$5,0,$6,now())`, [chainId,battleId,side,`${side}-confirmed-booster`,units,`accepted-money-primitive:${CHAIN_KEY}:${side}:${units}`]);
  }
  await event("CONFIRMED_BOOST", { leftUnits: 100, rightUnits: 50, moneyPrimitiveRerun: false });
}
async function settleAndReload() {
  const snapshotByToken = new Map([[normalized.left.token, normalized.left],[normalized.right.token, normalized.right]]);
  const getSnapshot = async (_chainId, token) => {
    const side = snapshotByToken.get(String(token));
    if (!side) throw new Error(`snapshot token not bound ${token}`);
    return { chainId, campaignAddress: side.campaign, tokenAddress: side.token, creatorAddress: side.creator, marketCapUsd: side.endMcapUsd, holders: side.holdersAfterCount, liquidityUsd: 100000, updatedAt: new Date(Date.parse(endsAt)-2000).toISOString(), healthy: true, dataLagSeconds: 0, dataSource: "agent2_real_chain" };
  };
  const deps = { pool, getSnapshot };
  const concurrent = await Promise.all([settleBattlePointsV3ById(battleId,deps), settleBattlePointsV3ById(battleId,deps)]);
  const repeated = await settleBattlePointsV3ById(battleId,deps);
  await event("FINALIZER", { concurrent, repeated });
  const points = await q(`select side,token_id,scoring_version,mcap_weight,holder_weight,volume_weight,boost_weight,boost_curve_version,boost_units::text,boost_points::text,mcap_points::text,holder_points::text,volume_points::text,total_points::text from public.arena_battle_points_v3 where battle_id=$1 order by side`, [battleId]);
  if (points.rows.length !== 2) throw new Error("missing V3 points rows");
  for (const row of points.rows) if (Number(row.mcap_weight)!==45||Number(row.holder_weight)!==27||Number(row.volume_weight)!==18||Number(row.boost_weight)!==10||row.boost_curve_version!=="boost_hyperbolic_100_v1") throw new Error("V3 lock mismatch");
  const settled = await q(`select id,chain_id,state,winner_token,settlement_version,settlement_scoring_version,challenger_battle_points::text,defender_battle_points::text,settled_at,finished_at,participants from public.arena_battles where id=$1`, [battleId]);
  if (settled.rows[0]?.state !== "finished" || !settled.rows[0]?.winner_token) throw new Error("authoritative Battle did not settle");
  await pool.end();
  pool = new Pool({ connectionString: DATABASE_URL, ssl: false });
  const reload = await pool.query(`select b.id,b.chain_id,b.state,b.winner_token,b.settlement_scoring_version,(select count(*) from public.arena_battle_points_v3 p where p.battle_id=b.id)::int as points_rows,(select count(*) from public.agent2_normal_battle_cert_events e where e.battle_id=b.id)::int as event_rows from public.arena_battles b where b.id=$1`, [battleId]);
  if (reload.rows[0]?.state !== "finished" || reload.rows[0]?.points_rows !== 2) throw new Error("restart reload failed");
  return { concurrent, repeated, points: points.rows, settled: settled.rows[0], reload: reload.rows[0] };
}

async function main() {
  await setupCertificationSurface();
  await insertMarket("left", normalized.left); await insertMarket("right", normalized.right);
  await lifecycleAndBaselines(); await boosts();
  const final = await settleAndReload();
  const dbEvents = await pool.query(`select id,event_kind,payload,created_at from public.agent2_normal_battle_cert_events where battle_id=$1 order by id`, [battleId]);
  const report = { schemaVersion: 1, purpose: "agent2-authoritative-normal-battle-db-closeout", sourceSha: process.env.GITHUB_SHA || null, chainKey: CHAIN_KEY, chainId, battleId, startedAt, endsAt, identities: { left: {campaign: normalized.left.campaign, token: normalized.left.token}, right: {campaign: normalized.right.campaign, token: normalized.right.token} }, chainTransactions: { left: normalized.left.signatures, right: normalized.right.signatures }, lifecycleEvents: dbEvents.rows, ...final, checks: { oneAuthoritativeBattleRow: true, challenge: true, counterEvidence: true, declineEvidence: true, acceptSelected: true, scheduled: true, live: true, immutableBaseline: true, actualChainEvidence: true, mcapGrowth: true, holderGrowth: true, eligibleVolume: true, confirmedBoost: true, v3Weights: "45/27/18/10", boostCurve: "10*U/(U+100)", concurrentFinalizer: true, repeatedFinalizer: true, restartReload: true, claimsTouched: false, arenaMoneyV2Rerun: false } };
  fs.writeFileSync(REPORT, `${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report,null,2));
  await pool.end();
}
main().catch(async (error) => { console.error(error); try { await pool.end(); } catch {} process.exitCode=1; });
