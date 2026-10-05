// Moderation lists for the Command Center: every airdrop winner, every league
// winner and every recruiter on the mainnets (Solana 101, BNB 56, Robinhood
// 4663), with read-only moderation flags. Founder request 2026-10-05: "For
// proper moderation we also need some sort of sheet or list for all the
// airdrop winners, the league winners and the recruiters."
//
// Read-only. Every query is a SELECT; nothing here signs, pays, voids or holds.
// The database is injected (db.query), so the tests run on a fake.
//
// Money: native amounts come from the ledger rows in atomic units and are
// shown as decimals. USD is valued at the time that matters where that is
// cheap: the draw price stored on the airdrop batch, else the Binance 1h
// close of the hour the prize was decided or earned (financePrices.js), else
// spot. Each row says which (usdBasis).

import { internalWalletIndex } from "./moderationInternalWallets.js";

export const MODERATION_CHAINS = Object.freeze([
  Object.freeze({ chainId: 101, asset: "SOL", decimals: 9, label: "Solana", key: "solana" }),
  Object.freeze({ chainId: 56, asset: "BNB", decimals: 18, label: "BNB", key: "bnb" }),
  Object.freeze({ chainId: 4663, asset: "ETH", decimals: 18, label: "Robinhood", key: "robinhood" }),
]);
const CHAIN_BY_ID = new Map(MODERATION_CHAINS.map((c) => [c.chainId, c]));
const CHAIN_BY_KEY = new Map(MODERATION_CHAINS.map((c) => [c.key, c]));
const MAINNET_IDS = MODERATION_CHAINS.map((c) => c.chainId);

export const MODERATION_TABS = Object.freeze(["airdrops", "leagues", "recruiters"]);

export const EXPIRY_WARNING_DAYS = 7;

// Test and internal recruiters (founder, 2026-10-05): our own squads and test
// accounts. Each also signed up with an owner wallet (shared/ownerWallets.mjs),
// which marks it on its own; the ids keep them marked if a wallet changes.
// More without a deploy: MODERATION_TEST_RECRUITER_IDS (comma separated ids).
export const TEST_RECRUITER_IDS = Object.freeze(["1", "16", "29", "107", "108", "114", "115", "124"]);

export function testRecruiterIds(env = process.env) {
  const extra = String(env?.MODERATION_TEST_RECRUITER_IDS || "").split(",").map((v) => v.trim()).filter((v) => /^\d+$/.test(v));
  return new Set([...TEST_RECRUITER_IDS, ...extra]);
}

// Why a row counts as test or internal data. The page hides these rows unless
// "Show test and internal" is on.
export const TEST_DATA_REASONS = Object.freeze({
  test_coin: "Prize from a hidden test coin",
  internal_wallet: "Owner or internal wallet",
  test_recruiter: "Test or internal recruiter",
  voided: "Voided row",
});
export const REPEAT_WIN_THRESHOLD = 3;

export const MODERATION_FLAGS = Object.freeze({
  internal: { label: "Internal wallet", explain: "The wallet is one of ours (founder, deployer, operator, multisig or protocol vault)." },
  self_referral: { label: "Self-referral", explain: "A recruiter's own or payout wallet is also one of its linked wallets or earners, or the row was voided as self-referral." },
  repeat_winner: { label: "Repeat winner", explain: `The same wallet won ${REPEAT_WIN_THRESHOLD} or more prizes, or several categories in one period.` },
  shared_payout: { label: "Shared payout address", explain: "One payout address receives money for more than one winner or recruiter." },
  cluster: { label: "Cluster / risk", explain: "The wallet is in a wallet cluster or has a medium, high or restricted risk profile." },
  test_coin: { label: "Hidden test coin", explain: "The prize or earning comes from a coin hidden from public listings (test coin)." },
  voided: { label: "Voided / failed", explain: "The row or part of the money was voided or failed." },
  expiring: { label: "Expires soon", explain: `Unclaimed and the claim window closes within ${EXPIRY_WARNING_DAYS} days.` },
});

const EXPLORERS = Object.freeze({
  101: { tx: "https://solscan.io/tx/", account: "https://solscan.io/account/" },
  56: { tx: "https://bscscan.com/tx/", account: "https://bscscan.com/address/" },
  4663: { tx: "https://explorer.chain.robinhood.com/tx/", account: "https://explorer.chain.robinhood.com/address/" },
});

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// --------------------------------------------------------------------------
// Small helpers

export function explorerTxUrl(chainId, hash) {
  const text = String(hash || "").trim();
  const base = EXPLORERS[Number(chainId)]?.tx;
  if (!base || !text) return null;
  if (Number(chainId) === 101) return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text) ? `${base}${text}` : null;
  return /^0x[0-9a-fA-F]{64}$/.test(text) ? `${base}${text}` : null;
}

/** Explorer link for a wallet. A Solana key whose case was lost (lower-cased in storage) gets no link. */
export function explorerAddressUrl(chainId, address) {
  const text = String(address || "").trim();
  const base = EXPLORERS[Number(chainId)]?.account;
  if (!base || !text) return null;
  if (Number(chainId) === 101) return SOLANA_ADDRESS.test(text) && text !== text.toLowerCase() ? `${base}${text}` : null;
  return EVM_ADDRESS.test(text) ? `${base}${text}` : null;
}

function toIso(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function unixSecondsIso(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{9,11}$/.test(text)) return null;
  return new Date(Number(text) * 1000).toISOString();
}

function rawBig(value) {
  const text = value == null ? "0" : String(value).split(".")[0].trim();
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

/** Atomic units -> decimal string, trailing zeros trimmed. */
export function atomicToDecimal(raw, decimals) {
  const value = typeof raw === "bigint" ? raw : rawBig(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function roundUsd(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function chainOf(chainId) {
  return CHAIN_BY_ID.get(Number(chainId)) || null;
}

function campaignKey(chainId, address) {
  const text = String(address || "").trim();
  if (!text) return "";
  return Number(chainId) === 101 ? `101:${text}` : `${Number(chainId)}:${text.toLowerCase()}`;
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

async function read(db, notes, label, sql, params = []) {
  try {
    const result = await db.query(sql, params);
    return result?.rows || [];
  } catch (error) {
    if (schemaMissing(error)) {
      notes.push(`${label} could not be read on this database (${error.code}); its rows are left out.`);
      return [];
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Prices

function hourOf(iso) {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? Math.floor(ms / 3_600_000) * 3_600_000 : null;
}

/**
 * Thin wrapper around financePrices' service: warm the hourly history once
 * per asset (one Binance range read instead of one per row), then value rows.
 */
export function createModerationPricer(priceService) {
  const wanted = new Map();
  return {
    want(asset, iso) {
      const hour = hourOf(iso);
      if (!asset || hour == null) return;
      if (!wanted.has(asset)) wanted.set(asset, new Set());
      wanted.get(asset).add(hour);
    },
    async warm() {
      if (!priceService?.hourly) return;
      for (const [asset, hours] of wanted) {
        try { await priceService.hourly(asset, [...hours]); } catch { /* valued at spot below */ }
      }
    },
    /** @returns {{amountUsd:number|null, usdBasis:string|null}} */
    async value(asset, buckets, decimals) {
      if (!priceService?.valueEvents) return { amountUsd: null, usdBasis: null };
      const list = (buckets || []).filter((b) => rawBig(b.raw) > 0n);
      if (list.length === 0) return { amountUsd: 0, usdBasis: null };
      try {
        const result = await priceService.valueEvents(asset, list.map((b) => ({ hour: b.at, raw: String(b.raw) })), decimals);
        return { amountUsd: result?.amountUsd == null ? null : roundUsd(result.amountUsd), usdBasis: result?.priceBasis || null };
      } catch {
        return { amountUsd: null, usdBasis: null };
      }
    },
  };
}

// --------------------------------------------------------------------------
// Status

const VOID_STATUSES = new Set(["failed", "voided", "cancelled", "canceled", "void"]);
const CLAIMED_STATUSES = new Set(["claimed", "paid"]);

function deadlineState(deadlineIso, nowIso) {
  if (!deadlineIso) return { expired: false, expiring: false };
  const left = Date.parse(deadlineIso) - Date.parse(nowIso);
  return { expired: left < 0, expiring: left >= 0 && left <= EXPIRY_WARNING_DAYS * 86_400_000 };
}

export function airdropStatus({ status, laneStatus, claimTx, deadline, now }) {
  const s = lower(status);
  const lane = lower(laneStatus);
  if (CLAIMED_STATUSES.has(s) || lane === "claimed" || claimTx) return "claimed";
  if (VOID_STATUSES.has(s) || VOID_STATUSES.has(lane)) return "voided";
  if (s === "expired" || s === "rolled_over" || lane === "expired") return "expired";
  if (deadlineState(deadline, now).expired) return "expired";
  if (s === "claimable" || lane === "claimable") return "claimable";
  return "pending";
}

export function leagueStatus({ claimedAt, paidAt, payTx, expiresAt, sweptAt, rootAt, now }) {
  if (claimedAt || paidAt || payTx) return "claimed";
  if (sweptAt) return "expired";
  if (expiresAt && Date.parse(toIso(expiresAt)) < Date.parse(now)) return "expired";
  return rootAt ? "claimable" : "pending";
}

// --------------------------------------------------------------------------
// Load

async function loadSources(db, notes) {
  const chainText = MAINNET_IDS.map(String);
  const [
    airdrops, leagues, recruiters, accounts, payoutWallets, links, ledger, claims, laneClaims,
    clusterMembers, riskProfiles,
  ] = await Promise.all([
    read(db, notes, "Airdrop winners (reward_ledger)", `
      select l.id::text as id, l.reward_type, l.source_id, l.wallet_address, l.chain::text as chain, l.token_symbol,
             l.amount::text as amount_raw, l.status, l.claim_tx_hash, l.claim_error,
             l.created_at, l.claimable_at, l.claimed_at, l.expires_at,
             (l.metadata - 'merkleProof' - 'solanaRewardLane' - 'claimVerification' - 'eligibleCampaigns') as metadata,
             l.metadata->'eligibleCampaigns' as eligible_campaigns,
             l.metadata->'claimVerification'->>'txHash' as verified_tx,
             bi.status as item_status,
             b.id::text as batch_id, b.status as batch_status, b.published_at as batch_published_at, b.created_at as batch_created_at,
             b.metadata->>'nativeUsdAtDraw' as native_usd_at_draw,
             b.metadata->>'candidateCount' as candidate_count, b.metadata->>'winnerCount' as winner_count,
             b.metadata->>'claimDeadline' as batch_claim_deadline,
             lc.status as lane_status, lc.tx_hash as lane_tx, lc.error as lane_error, lb.claim_deadline as lane_deadline
        from public.reward_ledger l
        left join public.reward_batch_items bi on bi.reward_ledger_id = l.id
        left join public.reward_batches b on b.id::text = coalesce(bi.batch_id::text, l.metadata->>'batchId')
        left join public.solana_reward_lane_claims lc on lc.source_type = 'reward_ledger' and lc.source_ref = l.id::text
        left join public.solana_reward_lane_batches lb on lb.id = lc.batch_id
       where l.chain::text = any($1::text[])
       order by l.created_at desc`, [chainText]),
    read(db, notes, "League winners (league_epoch_winners)", `
      select w.chain_id, w.period, w.epoch_start, w.epoch_end, w.category, w.rank, w.recipient_address,
             w.amount_raw::text as amount_raw, w.payload, w.computed_at, w.expires_at, w.swept_at,
             c.claimed_at, p.tx_hash as pay_tx, p.paid_at,
             r.published_at as root_at, coalesce(r.tx_hash, r.metadata->>'txHash') as root_tx,
             m.status as run_status, m.reason as run_reason
        from public.league_epoch_winners w
        left join public.league_epoch_claims c
          on c.chain_id = w.chain_id and c.period = w.period and c.epoch_start = w.epoch_start and c.category = w.category and c.rank = w.rank
        left join public.league_epoch_payouts p
          on p.chain_id = w.chain_id and p.period = w.period and p.epoch_start = w.epoch_start and p.category = w.category and p.rank = w.rank
        left join public.league_epoch_roots r
          on r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start
        left join public.arena_mwl_payout_runs m
          on m.chain_id = w.chain_id and m.period = w.period and m.epoch_start = w.epoch_start
       where w.chain_id = any($1::int[])
       order by w.epoch_start desc, w.chain_id, w.period, w.category, w.rank`, [MAINNET_IDS]),
    read(db, notes, "Recruiters", `
      select id::text as id, wallet_address, code, display_name, is_og, status, closed_at, created_at, updated_at,
             metadata->'signup'->>'email' as email,
             metadata->'signup'->>'xHandle' as x_handle,
             metadata->'signup'->>'telegram' as telegram,
             metadata->'signup'->>'solanaWalletAddress' as solana_wallet,
             metadata->'signup'->>'chain' as signup_chain
        from public.recruiters
       order by id`),
    read(db, notes, "Recruiter accounts", `
      select recruiter_id::text as account_id, signup_wallet, code, display_name, status, created_at
        from public.recruiter_accounts`),
    read(db, notes, "Recruiter payout wallets", `
      select recruiter_id::text as account_id, chain, wallet_address, verified_at from public.recruiter_payout_wallets`),
    read(db, notes, "Recruiter links", `
      select wallet_address, recruiter_id::text as recruiter_id, link_source, linked_at, detached_at, detach_reason, is_active
        from public.wallet_recruiter_links`),
    read(db, notes, "Recruiter reward ledger", `
      select id::text as id, recruiter_id::text as account_id, chain, chain_id, token, amount_raw::text as amount_raw, status,
             claim_id::text as claim_id, created_at, updated_at,
             metadata->>'campaign' as campaign, metadata->>'voidedReason' as voided_reason,
             metadata->>'earningWallet' as earning_wallet, metadata->>'linksRecruiterId' as links_recruiter_id
        from public.recruiter_reward_ledger`),
    read(db, notes, "Recruiter reward claims", `
      select id::text as id, recruiter_id::text as account_id, chain, amount_raw::text as amount_raw, payout_wallet, status, tx_hash, error, created_at, updated_at
        from public.recruiter_reward_claims`),
    read(db, notes, "Solana recruiter lane claims", `
      select lc.source_ref, lc.wallet_address, lc.amount_lamports::text as amount_raw, lc.status, lc.tx_hash, lc.error,
             lb.chain_id, lb.status as batch_status, lb.claim_deadline, lb.metadata->>'voidedReason' as voided_reason
        from public.solana_reward_lane_claims lc
        join public.solana_reward_lane_batches lb on lb.id = lc.batch_id
       where lc.lane = 'recruiter' and lb.chain_id = any($1::int[])`, [MAINNET_IDS]),
    read(db, notes, "Wallet clusters", `
      select m.wallet_address, m.cluster_id, m.relationship, c.risk_level, c.restricted, c.primary_signals
        from public.cluster_members m left join public.wallet_clusters c on c.cluster_id = m.cluster_id`),
    read(db, notes, "Wallet risk profiles", `
      select wallet_address, risk_level, restricted, cluster_id, reason from public.wallet_risk_profiles
       where restricted or lower(coalesce(risk_level, '')) in ('medium', 'high', 'critical')`),
  ]);
  return { airdrops, leagues, recruiters, accounts, payoutWallets, links, ledger, claims, laneClaims, clusterMembers, riskProfiles };
}

async function loadProfiles(db, notes, addresses) {
  const keys = [...new Set(addresses.map(lower).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const [userRows, walletRows] = await Promise.all([
    read(db, notes, "User profiles", `
      select chain_id, address, display_name from public.user_profiles
       where display_name is not null and btrim(display_name) <> '' and lower(address) = any($1::text[])`, [keys]),
    read(db, notes, "Wallet profiles", `
      select wallet_address, display_name from public.wallet_profiles
       where display_name is not null and btrim(display_name) <> '' and lower(wallet_address) = any($1::text[])`, [keys]),
  ]);
  const out = new Map();
  for (const row of walletRows) out.set(lower(row.wallet_address), row.display_name);
  for (const row of userRows) {
    const key = lower(row.address);
    out.set(`${Number(row.chain_id)}:${key}`, row.display_name);
    if (!out.has(key)) out.set(key, row.display_name);
  }
  return out;
}

async function loadCampaigns(db, notes, addresses) {
  const keys = [...new Set(addresses.map(lower).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const rows = await read(db, notes, "Campaigns", `
    select chain_id, campaign_address, token_address, name, symbol,
           lower(coalesce(meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on') as hidden
      from public.campaigns
     where chain_id = any($1::int[]) and (lower(campaign_address) = any($2::text[]) or lower(token_address) = any($2::text[]))`, [MAINNET_IDS, keys]);
  const out = new Map();
  for (const row of rows) {
    const value = { name: row.name || null, symbol: row.symbol || null, hidden: Boolean(row.hidden), campaignAddress: row.campaign_address || null };
    if (row.campaign_address) out.set(campaignKey(row.chain_id, row.campaign_address), value);
    if (row.token_address) out.set(campaignKey(row.chain_id, row.token_address), value);
  }
  return out;
}

// --------------------------------------------------------------------------
// Build rows

const PROGRAM_LABELS = Object.freeze({
  airdrop_trader: "Trader draw",
  airdrop_creator: "Creator draw",
  airdrop_holders: "Holder payout",
  dbc_holders: "Holder payout (DBC)",
  squad_pool: "Squad pool",
});

const PERIOD_LABELS = Object.freeze({ weekly: "Weekly", monthly: "Monthly", mwl_monthly: "MWL monthly", quarterly: "Quarterly" });

const CATEGORY_LABELS = Object.freeze({
  top_earner: "Top earner",
  crowd_favorite: "Crowd favorite",
  biggest_hit: "Biggest hit",
  fastest_finish: "Fastest finish",
  perfect_run: "Perfect run",
  recruiter_league: "Recruiter league",
  mwl: "Major War League",
  championship: "Quarterly championship",
});

function airdropReason(meta, chain) {
  const parts = [];
  if (Array.isArray(meta.reasonCodes) && meta.reasonCodes.length) parts.push(meta.reasonCodes.join(", "));
  if (meta.tradeCount != null) parts.push(`${meta.tradeCount} trades`);
  if (meta.activeDays != null) parts.push(`${meta.activeDays} active days`);
  if (meta.uniqueBuyers != null) parts.push(`${meta.uniqueBuyers} unique buyers`);
  if (meta.totalVolumeRaw && chain) parts.push(`volume ${atomicToDecimal(meta.totalVolumeRaw, chain.decimals)} ${chain.asset}`);
  if (meta.rawScore != null) parts.push(`squad score ${meta.rawScore}`);
  if (meta.recruiterCode) parts.push(`squad ${meta.recruiterCode}`);
  return parts.join("; ") || null;
}

function airdropPeriod(meta, createdAt) {
  const start = toIso(meta.epochStart);
  if (start) return start.slice(0, 10);
  const id = String(meta.epochId ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return id;
  return (toIso(createdAt) || "").slice(0, 10) || null;
}

function buildAirdropRows(rows, ctx) {
  return rows.map((row) => {
    const chain = chainOf(row.chain);
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const program = row.reward_type === "airdrop" ? String(meta.program || "airdrop") : row.reward_type === "squad" ? "squad_pool" : String(row.reward_type || "other");
    const deadline = unixSecondsIso(meta.claimDeadline) || unixSecondsIso(row.batch_claim_deadline) || unixSecondsIso(row.lane_deadline) || toIso(row.expires_at);
    const claimTx = row.claim_tx_hash || row.verified_tx || row.lane_tx || null;
    const status = airdropStatus({ status: row.status, laneStatus: row.lane_status, claimTx, deadline, now: ctx.now });
    const wallet = String(row.wallet_address || "").trim();
    const campaigns = Array.isArray(row.eligible_campaigns) ? row.eligible_campaigns.map((c) => c?.campaignAddress).filter(Boolean) : [];
    const coinInfo = campaigns.map((address) => ctx.campaigns.get(campaignKey(row.chain, address))).filter(Boolean);
    const testCoin = campaigns.length > 0 && coinInfo.length === campaigns.length && coinInfo.every((c) => c.hidden);
    const drawPrice = num(row.native_usd_at_draw ?? meta.nativeUsdAtDraw);
    const at = toIso(row.batch_published_at) || toIso(row.created_at);
    return {
      id: `airdrop:${row.id}`,
      chainId: chain?.chainId ?? null,
      chain: chain?.label ?? String(row.chain),
      asset: chain?.asset ?? row.token_symbol ?? null,
      decimals: chain?.decimals ?? null,
      period: airdropPeriod(meta, row.created_at),
      program,
      programLabel: PROGRAM_LABELS[program] || program,
      wallet,
      walletUrl: explorerAddressUrl(chain?.chainId, wallet),
      profileName: ctx.profileName(chain?.chainId, wallet),
      rank: num(meta.winnerRank),
      score: num(meta.activityScore ?? meta.finalWeight ?? meta.rawScore),
      weight: num(meta.finalWeight),
      reason: airdropReason(meta, chain),
      coins: coinInfo.map((c) => c.name || c.symbol).filter(Boolean),
      testCoin,
      amountRaw: String(row.amount_raw ?? "0"),
      amount: chain ? atomicToDecimal(row.amount_raw, chain.decimals) : String(row.amount_raw ?? "0"),
      amountUsd: null,
      usdBasis: null,
      _price: { drawPrice, at },
      status,
      ledgerStatus: row.status || null,
      batchId: row.batch_id || null,
      batchStatus: row.batch_status || null,
      candidateCount: num(row.candidate_count),
      winnerCount: num(row.winner_count),
      txHash: claimTx,
      txUrl: explorerTxUrl(chain?.chainId, claimTx),
      error: row.claim_error || row.lane_error || null,
      createdAt: toIso(row.created_at),
      claimedAt: toIso(row.claimed_at),
      deadline,
      flags: [],
      flagNotes: {},
    };
  });
}

function leagueReason(category, payload, chain) {
  const p = payload || {};
  switch (category) {
    case "top_earner": {
      if (p.pnl_raw == null || !chain) return null;
      const text = String(p.pnl_raw);
      const negative = text.startsWith("-");
      return `PnL ${negative ? "-" : ""}${atomicToDecimal(negative ? text.slice(1) : text, chain.decimals)} ${chain.asset}`;
    }
    case "crowd_favorite": return `${p.votes_count ?? "?"} votes, ${p.unique_voters ?? "?"} unique voters`;
    case "biggest_hit": return p.bnb_amount_raw && chain ? `buy of ${atomicToDecimal(p.bnb_amount_raw, chain.decimals)} ${chain.asset}` : p.score ? `score ${p.score}` : null;
    case "fastest_finish":
    case "perfect_run": return p.duration_seconds != null ? `finished in ${p.duration_seconds} s` : null;
    case "recruiter_league": return [
      p.referredVolumeUsd != null ? `referred volume $${Number(p.referredVolumeUsd).toFixed(2)}` : null,
      p.linkedWalletCount != null ? `${p.linkedWalletCount} linked wallets` : null,
      p.recruiterCode ? `recruiter ${p.recruiterCode}` : null,
    ].filter(Boolean).join(", ") || null;
    case "mwl":
    case "championship": return `${p.points ?? "?"} points, final rank ${p.finalRank ?? "?"}`;
    default: return p.score != null ? `score ${p.score}` : null;
  }
}

function buildLeagueRows(rows, ctx) {
  return rows.map((row) => {
    const chain = chainOf(row.chain_id);
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const recipient = String(row.recipient_address || "").trim();
    const wallet = String(payload.wallet || recipient).trim();
    const coinAddress = payload.campaign_address || payload.tokenAddress || null;
    const coin = coinAddress ? ctx.campaigns.get(campaignKey(row.chain_id, coinAddress)) : null;
    const status = leagueStatus({ claimedAt: row.claimed_at, paidAt: row.paid_at, payTx: row.pay_tx, expiresAt: row.expires_at, sweptAt: row.swept_at, rootAt: row.root_at, now: ctx.now });
    const epochStart = toIso(row.epoch_start);
    const decidedAt = toIso(row.computed_at) || toIso(row.epoch_end);
    const payloadPrice = chain ? num(payload.prices?.[`${chain.asset.toLowerCase()}Usd`]) : null;
    return {
      id: `league:${row.chain_id}:${row.period}:${epochStart}:${row.category}:${row.rank}`,
      chainId: chain?.chainId ?? null,
      chain: chain?.label ?? String(row.chain_id),
      asset: chain?.asset ?? null,
      decimals: chain?.decimals ?? null,
      period: row.period,
      periodLabel: PERIOD_LABELS[row.period] || row.period,
      epochStart,
      epochEnd: toIso(row.epoch_end),
      epochKey: `${row.period}:${(epochStart || "").slice(0, 10)}`,
      category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category] || row.category,
      rank: num(row.rank),
      wallet,
      walletUrl: explorerAddressUrl(chain?.chainId, wallet),
      recipient,
      recipientUrl: explorerAddressUrl(chain?.chainId, recipient),
      profileName: ctx.profileName(chain?.chainId, wallet),
      coinAddress,
      coinUrl: explorerAddressUrl(chain?.chainId, coinAddress),
      coinName: coin?.name || payload.name || payload.tokenName || null,
      coinSymbol: coin?.symbol || payload.symbol || null,
      testCoin: Boolean(coin?.hidden),
      score: payload.score != null ? String(payload.score) : payload.points != null ? String(payload.points) : null,
      reason: leagueReason(row.category, payload, chain),
      amountRaw: String(row.amount_raw ?? "0"),
      amount: chain ? atomicToDecimal(row.amount_raw, chain.decimals) : String(row.amount_raw ?? "0"),
      amountUsd: null,
      usdBasis: null,
      _price: { drawPrice: payloadPrice, at: decidedAt },
      status,
      rootPosted: Boolean(row.root_at),
      rootAt: toIso(row.root_at),
      rootTxUrl: explorerTxUrl(chain?.chainId, row.root_tx),
      runStatus: row.run_status || null,
      runReason: row.run_reason || null,
      txHash: row.pay_tx || null,
      txUrl: explorerTxUrl(chain?.chainId, row.pay_tx),
      _recruiterId: payload.recruiterId != null ? String(payload.recruiterId) : null,
      claimedAt: toIso(row.claimed_at) || toIso(row.paid_at),
      deadline: toIso(row.expires_at),
      flags: [],
      flagNotes: {},
    };
  });
}

function emptyMoney() {
  return { earned: 0n, claimable: 0n, pending: 0n, claimed: 0n, failedVoided: 0n, buckets: { earned: [], claimable: [], pending: [], claimed: [], failedVoided: [] } };
}

function addMoney(money, kind, raw, at) {
  const value = rawBig(raw);
  money[kind] += value;
  money.buckets[kind].push({ raw: value, at });
}

function ledgerKind(status) {
  const s = lower(status);
  if (s === "claimed") return "claimed";
  if (VOID_STATUSES.has(s)) return "failedVoided";
  if (s === "claimable" || s === "retriable") return "claimable";
  return "pending";
}

function buildRecruiterRows(src, ctx) {
  const accountsByCode = new Map();
  for (const account of src.accounts) accountsByCode.set(lower(account.code), account);
  const payoutByAccount = new Map();
  for (const pw of src.payoutWallets) {
    if (!payoutByAccount.has(pw.account_id)) payoutByAccount.set(pw.account_id, []);
    payoutByAccount.get(pw.account_id).push(pw);
  }
  const linksByRecruiter = new Map();
  for (const link of src.links) {
    if (!linksByRecruiter.has(link.recruiter_id)) linksByRecruiter.set(link.recruiter_id, []);
    linksByRecruiter.get(link.recruiter_id).push(link);
  }
  const ledgerByAccount = new Map();
  let unscopedLedger = 0;
  for (const row of src.ledger) {
    if (row.chain_id == null) { unscopedLedger += 1; continue; }
    if (!CHAIN_BY_ID.has(Number(row.chain_id))) continue;
    if (!ledgerByAccount.has(row.account_id)) ledgerByAccount.set(row.account_id, []);
    ledgerByAccount.get(row.account_id).push(row);
  }
  if (unscopedLedger > 0) ctx.notes.push(`${unscopedLedger} recruiter ledger rows have no chain id (QA or legacy rows) and are left out of the totals.`);
  const claimsByAccount = new Map();
  for (const claim of src.claims) {
    if (!claimsByAccount.has(claim.account_id)) claimsByAccount.set(claim.account_id, []);
    claimsByAccount.get(claim.account_id).push(claim);
  }
  const laneByClaim = new Map(src.laneClaims.map((lane) => [lane.source_ref, lane]));

  const identities = [];
  const matchedAccounts = new Set();
  for (const recruiter of src.recruiters) {
    const account = accountsByCode.get(lower(recruiter.code)) || null;
    if (account) matchedAccounts.add(account.account_id);
    identities.push({ recruiter, account });
  }
  for (const account of src.accounts) {
    if (!matchedAccounts.has(account.account_id)) identities.push({ recruiter: null, account });
  }

  return identities.map(({ recruiter, account }) => {
    const accountId = account?.account_id || null;
    const recruiterId = recruiter?.id || null;
    const mainWalletStored = recruiter?.wallet_address || account?.signup_wallet || "";
    const mainWallet = ctx.restoreCase(recruiter?.solana_wallet || mainWalletStored);
    const mainChainId = EVM_ADDRESS.test(mainWallet) ? 56 : 101;
    const payoutWallets = (payoutByAccount.get(accountId) || []).map((pw) => {
      const chain = CHAIN_BY_KEY.get(lower(pw.chain));
      return { chainId: chain?.chainId ?? null, chain: chain?.label ?? pw.chain, address: pw.wallet_address, url: explorerAddressUrl(chain?.chainId, pw.wallet_address), verifiedAt: toIso(pw.verified_at) };
    });
    const linkRows = (recruiterId ? linksByRecruiter.get(recruiterId) : null) || [];
    const linkedWallets = linkRows.map((link) => {
      const active = Boolean(link.is_active) && !link.detached_at;
      const address = String(link.wallet_address || "").trim();
      const chainId = EVM_ADDRESS.test(address) ? 56 : 101;
      return {
        wallet: address,
        url: explorerAddressUrl(chainId, address),
        profileName: ctx.profileName(null, address),
        active,
        linkSource: link.link_source || null,
        linkedAt: toIso(link.linked_at),
        detachedAt: toIso(link.detached_at),
        detachReason: link.detach_reason || null,
        internal: ctx.internal.has(lower(address)) ? ctx.internal.get(lower(address)).label : null,
      };
    }).sort((a, b) => String(b.linkedAt || "").localeCompare(String(a.linkedAt || "")));

    const byChain = {};
    const voidReasons = new Set();
    let testCoinRows = 0;
    const earningWallets = new Set();
    let lastActivity = null;
    const touch = (iso) => { if (iso && (!lastActivity || iso > lastActivity)) lastActivity = iso; };
    for (const row of ledgerByAccount.get(accountId) || []) {
      const chain = chainOf(row.chain_id);
      const money = (byChain[chain.chainId] ||= emptyMoney());
      const at = toIso(row.created_at);
      const kind = ledgerKind(row.status);
      addMoney(money, kind, row.amount_raw, at);
      if (kind !== "failedVoided") addMoney(money, "earned", row.amount_raw, at);
      if (row.voided_reason) voidReasons.add(row.voided_reason);
      if (row.earning_wallet) earningWallets.add(row.earning_wallet);
      if (row.campaign) {
        const coin = ctx.campaigns.get(campaignKey(row.chain_id, row.campaign));
        if (coin?.hidden) testCoinRows += 1;
      }
      touch(at);
    }
    let laneFailed = 0;
    let laneExpiring = null;
    const claimRows = claimsByAccount.get(accountId) || [];
    for (const claim of claimRows) {
      touch(toIso(claim.updated_at) || toIso(claim.created_at));
      if (claim.error && /void/i.test(claim.error)) voidReasons.add(claim.error);
      const lane = laneByClaim.get(claim.id);
      if (!lane) continue;
      if (VOID_STATUSES.has(lower(lane.status)) || VOID_STATUSES.has(lower(lane.batch_status))) laneFailed += 1;
      if (lane.voided_reason) voidReasons.add(lane.voided_reason);
      if (lower(lane.status) === "claimable") {
        const deadline = unixSecondsIso(lane.claim_deadline);
        if (deadline && deadlineState(deadline, ctx.now).expiring && (!laneExpiring || deadline < laneExpiring)) laneExpiring = deadline;
      }
    }
    for (const link of linkedWallets) touch(link.linkedAt);

    const chains = {};
    for (const [chainId, money] of Object.entries(byChain)) {
      const chain = chainOf(chainId);
      chains[chainId] = {
        chainId: chain.chainId,
        chain: chain.label,
        asset: chain.asset,
        earned: atomicToDecimal(money.earned, chain.decimals),
        claimable: atomicToDecimal(money.claimable, chain.decimals),
        pending: atomicToDecimal(money.pending, chain.decimals),
        claimed: atomicToDecimal(money.claimed, chain.decimals),
        failedVoided: atomicToDecimal(money.failedVoided, chain.decimals),
        raw: { earned: String(money.earned), claimable: String(money.claimable), pending: String(money.pending), claimed: String(money.claimed), failedVoided: String(money.failedVoided) },
        usd: { earned: null, claimable: null, pending: null, claimed: null, failedVoided: null },
        usdBasis: null,
        _buckets: money.buckets,
      };
    }

    return {
      id: recruiterId ? `recruiter:${recruiterId}` : `recruiter-account:${accountId}`,
      recruiterId,
      accountId,
      code: recruiter?.code || account?.code || null,
      name: recruiter?.display_name || account?.display_name || null,
      handle: [recruiter?.x_handle, recruiter?.telegram].filter((h) => h && String(h).trim()).join(" / ") || null,
      email: recruiter?.email || null,
      wallet: mainWallet || null,
      walletUrl: explorerAddressUrl(mainChainId, mainWallet),
      walletChainId: mainWallet ? mainChainId : null,
      profileName: ctx.profileName(null, mainWallet),
      payoutWallets,
      signupAt: toIso(recruiter?.created_at) || toIso(account?.created_at),
      status: recruiter?.status || account?.status || null,
      isOg: Boolean(recruiter?.is_og),
      source: recruiter ? (account ? "recruiters + recruiter_accounts" : "recruiters") : "recruiter_accounts only",
      linkedTotal: linkedWallets.length,
      linkedActive: linkedWallets.filter((w) => w.active).length,
      linkedDetached: linkedWallets.filter((w) => !w.active).length,
      linkedWallets,
      chains,
      earnedUsd: null,
      claimableUsd: null,
      pendingUsd: null,
      claimedUsd: null,
      failedVoidedUsd: null,
      claimCount: claimRows.length,
      laneFailed,
      voidReasons: [...voidReasons],
      lastActivityAt: lastActivity,
      deadline: laneExpiring,
      _earningWallets: [...earningWallets],
      _testCoinRows: testCoinRows,
      flags: [],
      flagNotes: {},
    };
  });
}

// --------------------------------------------------------------------------
// Flags

function addFlag(row, flag, note) {
  if (!row.flags.includes(flag)) row.flags.push(flag);
  if (note) row.flagNotes[flag] = row.flagNotes[flag] ? `${row.flagNotes[flag]}; ${note}` : note;
}

function riskIndex(src) {
  const out = new Map();
  for (const m of src.clusterMembers) {
    const level = lower(m.risk_level);
    out.set(lower(m.wallet_address), `cluster ${m.cluster_id}${level ? ` (${level} risk${m.restricted ? ", restricted" : ""})` : ""}`);
  }
  for (const r of src.riskProfiles) {
    const key = lower(r.wallet_address);
    if (!out.has(key)) out.set(key, `${lower(r.risk_level) || "flagged"} risk${r.restricted ? ", restricted" : ""}${r.reason ? `: ${r.reason}` : ""}`);
  }
  return out;
}

export function applyFlags({ airdrops, leagues, recruiters }, { internal, risk, now }) {
  const winners = [...airdrops, ...leagues];

  for (const row of winners) {
    const key = lower(row.wallet);
    if (internal.has(key)) addFlag(row, "internal", internal.get(key).label);
    if (row.recipient && lower(row.recipient) !== key && internal.has(lower(row.recipient))) addFlag(row, "internal", `payout to ${internal.get(lower(row.recipient)).label}`);
    if (risk.has(key)) addFlag(row, "cluster", risk.get(key));
    if (row.testCoin) addFlag(row, "test_coin", row.coinName || row.coins?.join(", ") || null);
    if (row.status === "voided") addFlag(row, "voided", row.error || null);
    if (row.status === "claimable" || row.status === "pending") {
      const state = deadlineState(row.deadline, now);
      if (state.expiring) addFlag(row, "expiring", `closes ${row.deadline.slice(0, 10)}`);
    }
  }

  // Repeat winners: across airdrops and leagues on all mainnets.
  const wins = new Map();
  for (const row of winners) {
    const key = lower(row.wallet);
    if (!key) continue;
    if (!wins.has(key)) wins.set(key, []);
    wins.get(key).push(row);
  }
  for (const list of wins.values()) {
    const perEpoch = new Map();
    for (const row of list) {
      if (!row.epochKey) continue;
      const k = `${row.chainId}:${row.epochKey}`;
      perEpoch.set(k, (perEpoch.get(k) || new Set()).add(row.category));
    }
    const multiCategory = [...perEpoch.entries()].filter(([, cats]) => cats.size >= 2);
    if (list.length >= REPEAT_WIN_THRESHOLD || multiCategory.length > 0) {
      const note = [
        `${list.length} prizes`,
        multiCategory.length ? `${multiCategory.length} period(s) with several categories` : null,
      ].filter(Boolean).join(", ");
      for (const row of list) addFlag(row, "repeat_winner", note);
    }
  }

  // Shared payout addresses: one recipient paid for more than one winning wallet.
  const byRecipient = new Map();
  for (const row of leagues) {
    const r = lower(row.recipient);
    if (!r) continue;
    if (!byRecipient.has(r)) byRecipient.set(r, new Set());
    byRecipient.get(r).add(lower(row.wallet));
  }
  for (const row of leagues) {
    const set = byRecipient.get(lower(row.recipient));
    if (set && set.size >= 2) addFlag(row, "shared_payout", `${row.recipient} is paid for ${set.size} winning wallets`);
  }

  // Recruiters.
  const ownersByWallet = new Map();
  const ownWalletsOf = (row) => {
    const list = [row.wallet, ...row.payoutWallets.map((p) => p.address)].map(lower).filter(Boolean);
    return [...new Set(list)];
  };
  for (const row of recruiters) {
    for (const w of ownWalletsOf(row)) {
      if (!ownersByWallet.has(w)) ownersByWallet.set(w, new Set());
      ownersByWallet.get(w).add(row.id);
    }
  }
  const byEmail = new Map();
  for (const row of recruiters) {
    const email = lower(row.email);
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(row);
  }
  for (const row of recruiters) {
    const own = new Set(ownWalletsOf(row));
    for (const w of own) {
      if (internal.has(w)) addFlag(row, "internal", `own or payout wallet is the ${internal.get(w).label}`);
      if (risk.has(w)) addFlag(row, "cluster", risk.get(w));
      const owners = ownersByWallet.get(w);
      if (owners && owners.size >= 2) addFlag(row, "shared_payout", `wallet shared with ${owners.size - 1} other recruiter record(s)`);
    }
    const internalLinked = row.linkedWallets.filter((l) => l.internal);
    if (internalLinked.length) addFlag(row, "internal", `${internalLinked.length} linked wallet(s) are internal`);
    const riskyLinked = row.linkedWallets.filter((l) => risk.has(lower(l.wallet)));
    if (riskyLinked.length) addFlag(row, "cluster", `${riskyLinked.length} linked wallet(s) in a cluster or risk list`);
    const selfLinked = row.linkedWallets.filter((l) => own.has(lower(l.wallet)));
    if (selfLinked.length) addFlag(row, "self_referral", "own or payout wallet is also a linked wallet");
    if (row._earningWallets.some((w) => own.has(lower(w)))) addFlag(row, "self_referral", "earned from its own wallet");
    if (row.voidReasons.some((reason) => /self[\s-]?referral/i.test(reason))) addFlag(row, "self_referral", "voided as self-referral");
    const sameEmail = (byEmail.get(lower(row.email)) || []).filter((other) => other.id !== row.id);
    for (const other of sameEmail) {
      const otherOwn = new Set(ownWalletsOf(other));
      if (row.linkedWallets.some((l) => otherOwn.has(lower(l.wallet)))) addFlag(row, "self_referral", `links a wallet of ${other.code || other.id}, which has the same sign-up email`);
    }
    if (row._testCoinRows > 0) addFlag(row, "test_coin", `${row._testCoinRows} earning row(s) from hidden test coins`);
    const voided = Object.values(row.chains).some((c) => rawBig(c.raw.failedVoided) > 0n) || row.laneFailed > 0;
    if (voided) addFlag(row, "voided", row.voidReasons.join("; ") || null);
    if (row.deadline) addFlag(row, "expiring", `recruiter lane claim closes ${row.deadline.slice(0, 10)}`);
  }
}

/**
 * Marks test and internal rows (testData, testReasons). Winners: a prize on a
 * hidden test coin, an owner/internal winning or payout wallet, a test
 * recruiter's recruiter-league prize, or a voided row. Recruiters: an
 * owner-wallet signup or payout wallet, or a listed test recruiter id. A
 * recruiter that only links an internal wallet is not marked: that is a
 * moderation finding, not test data.
 */
export function markTestData({ airdrops, leagues, recruiters }, { internal, testRecruiters }) {
  const mark = (row, reasons) => {
    row.testReasons = [...new Set(reasons)];
    row.testData = row.testReasons.length > 0;
  };
  for (const row of [...airdrops, ...leagues]) {
    const reasons = [];
    if (row.testCoin) reasons.push("test_coin");
    if (internal.has(lower(row.wallet)) || (row.recipient && internal.has(lower(row.recipient)))) reasons.push("internal_wallet");
    if (row._recruiterId && testRecruiters.has(row._recruiterId)) reasons.push("test_recruiter");
    if (row.status === "voided") reasons.push("voided");
    mark(row, reasons);
  }
  for (const row of recruiters) {
    const reasons = [];
    const own = [row.wallet, ...row.payoutWallets.map((p) => p.address)].map(lower).filter(Boolean);
    if (own.some((w) => internal.has(w))) reasons.push("internal_wallet");
    if (row.recruiterId && testRecruiters.has(String(row.recruiterId))) reasons.push("test_recruiter");
    mark(row, reasons);
  }
}

// --------------------------------------------------------------------------
// USD

async function priceRows(dataset, pricer) {
  for (const row of [...dataset.airdrops, ...dataset.leagues]) {
    if (row._price.drawPrice == null && row.asset) pricer.want(row.asset, row._price.at);
  }
  for (const row of dataset.recruiters) {
    for (const c of Object.values(row.chains)) for (const list of Object.values(c._buckets)) for (const b of list) pricer.want(c.asset, b.at);
  }
  await pricer.warm();
  for (const row of [...dataset.airdrops, ...dataset.leagues]) {
    if (row._price.drawPrice != null && row.decimals != null) {
      row.amountUsd = roundUsd(Number(row.amount) * row._price.drawPrice);
      row.usdBasis = row.id.startsWith("airdrop:") ? "at_draw" : "at_decision";
    } else if (row.asset && row.decimals != null) {
      const v = await pricer.value(row.asset, [{ raw: row.amountRaw, at: row._price.at }], row.decimals);
      row.amountUsd = v.amountUsd;
      row.usdBasis = v.usdBasis;
    }
    delete row._price;
  }
  for (const row of dataset.recruiters) {
    const sums = { earned: 0, claimable: 0, pending: 0, claimed: 0, failedVoided: 0 };
    const known = { earned: true, claimable: true, pending: true, claimed: true, failedVoided: true };
    for (const c of Object.values(row.chains)) {
      const chain = chainOf(c.chainId);
      const bases = new Set();
      for (const kind of Object.keys(sums)) {
        const v = await pricer.value(chain.asset, c._buckets[kind], chain.decimals);
        c.usd[kind] = v.amountUsd;
        if (v.usdBasis) bases.add(v.usdBasis);
        if (v.amountUsd == null) known[kind] = false; else sums[kind] += v.amountUsd;
      }
      c.usdBasis = bases.size === 1 ? [...bases][0] : bases.size > 1 ? "mixed" : null;
      delete c._buckets;
    }
    row.earnedUsd = known.earned ? roundUsd(sums.earned) : null;
    row.claimableUsd = known.claimable ? roundUsd(sums.claimable) : null;
    row.pendingUsd = known.pending ? roundUsd(sums.pending) : null;
    row.claimedUsd = known.claimed ? roundUsd(sums.claimed) : null;
    row.failedVoidedUsd = known.failedVoided ? roundUsd(sums.failedVoided) : null;
  }
}

// --------------------------------------------------------------------------
// Dataset

/**
 * Builds all three lists in one pass (the flags look across them).
 * @param {{db:{query:Function}, priceService?:object, now?:string, env?:object}} options
 */
export async function buildModerationDataset({ db, priceService, now = new Date().toISOString(), env = process.env }) {
  const notes = [];
  const src = await loadSources(db, notes);
  const internal = internalWalletIndex(env);

  // Wallets in their real case, so a lower-cased Solana key can be restored.
  const caseMap = new Map();
  const remember = (address) => {
    const text = String(address || "").trim();
    if (text && text !== text.toLowerCase() && !caseMap.has(text.toLowerCase())) caseMap.set(text.toLowerCase(), text);
  };
  for (const row of internal.values()) remember(row.address);
  for (const row of src.airdrops) remember(row.wallet_address);
  for (const row of src.leagues) { remember(row.recipient_address); remember(row.payload?.wallet); }
  for (const row of src.recruiters) remember(row.solana_wallet);
  for (const row of src.accounts) remember(row.signup_wallet);
  for (const row of src.payoutWallets) remember(row.wallet_address);
  for (const row of src.links) remember(row.wallet_address);
  for (const row of src.ledger) remember(row.earning_wallet);
  const restoreCase = (address) => {
    const text = String(address || "").trim();
    if (!text || EVM_ADDRESS.test(text)) return text;
    return caseMap.get(text.toLowerCase()) || text;
  };

  const walletList = [
    ...src.airdrops.map((r) => r.wallet_address),
    ...src.leagues.flatMap((r) => [r.recipient_address, r.payload?.wallet]),
    ...src.recruiters.map((r) => r.solana_wallet || r.wallet_address),
    ...src.accounts.map((r) => r.signup_wallet),
    ...src.links.map((r) => r.wallet_address),
  ];
  const campaignList = [
    ...src.leagues.map((r) => r.payload?.campaign_address || r.payload?.tokenAddress),
    ...src.airdrops.flatMap((r) => (Array.isArray(r.eligible_campaigns) ? r.eligible_campaigns.map((c) => c?.campaignAddress) : [])),
    ...src.ledger.map((r) => r.campaign),
  ];
  const [profiles, campaigns] = await Promise.all([loadProfiles(db, notes, walletList), loadCampaigns(db, notes, campaignList)]);
  const profileName = (chainId, address) => {
    const key = lower(address);
    if (!key) return null;
    return (chainId != null && profiles.get(`${Number(chainId)}:${key}`)) || profiles.get(key) || null;
  };

  const ctx = { now, notes, campaigns, profileName, restoreCase, internal };
  const dataset = {
    airdrops: buildAirdropRows(src.airdrops, ctx),
    leagues: buildLeagueRows(src.leagues, ctx),
    recruiters: buildRecruiterRows(src, ctx),
  };
  applyFlags(dataset, { internal, risk: riskIndex(src), now });
  markTestData(dataset, { internal, testRecruiters: testRecruiterIds(env) });
  await priceRows(dataset, createModerationPricer(priceService));
  for (const row of dataset.recruiters) { delete row._earningWallets; delete row._testCoinRows; }
  for (const row of dataset.leagues) delete row._recruiterId;

  return {
    generatedAt: now,
    ...dataset,
    notes,
    internalWallets: [...internal.values()].map(({ address, chain, label }) => ({ address, chain, label })),
  };
}

// --------------------------------------------------------------------------
// Query: filter, sort, page, totals

const SEARCH_FIELDS = Object.freeze({
  airdrops: ["wallet", "profileName", "program", "programLabel", "reason", "txHash", "batchId"],
  leagues: ["wallet", "recipient", "profileName", "coinName", "coinSymbol", "coinAddress", "category", "txHash"],
  recruiters: ["wallet", "name", "code", "handle", "email", "profileName", "recruiterId", "accountId"],
});

const SORT_KEYS = Object.freeze({
  airdrops: ["period", "chain", "program", "rank", "wallet", "profileName", "score", "amount", "amountUsd", "status", "batchStatus", "deadline", "createdAt", "claimedAt", "flags"],
  leagues: ["epochStart", "chain", "period", "category", "rank", "wallet", "profileName", "coinName", "amount", "amountUsd", "status", "rootPosted", "deadline", "claimedAt", "flags"],
  recruiters: ["recruiterId", "name", "code", "wallet", "signupAt", "status", "linkedTotal", "linkedActive", "linkedDetached", "earnedUsd", "claimableUsd", "claimedUsd", "failedVoidedUsd", "lastActivityAt", "flags"],
});

const DEFAULT_SORT = Object.freeze({ airdrops: ["period", "desc"], leagues: ["epochStart", "desc"], recruiters: ["earnedUsd", "desc"] });

export function parseModerationQuery(tab, query = {}) {
  const chainRaw = String(query.chainId ?? query.chain ?? "all").trim().toLowerCase();
  const chainId = chainRaw === "" || chainRaw === "all" ? null : Number(chainRaw);
  if (chainId != null && !CHAIN_BY_ID.has(chainId)) return { error: "chainId must be all, 101 (Solana), 56 (BNB) or 4663 (Robinhood). Testnets are not listed." };
  const flag = String(query.flag ?? "").trim();
  if (flag && flag !== "any" && flag !== "none" && !MODERATION_FLAGS[flag]) return { error: `Unknown flag: ${flag}` };
  const [defaultKey, defaultDir] = DEFAULT_SORT[tab];
  const sortRaw = String(query.sort ?? "").trim();
  const sort = SORT_KEYS[tab].includes(sortRaw) ? sortRaw : defaultKey;
  const dir = String(query.dir ?? "").toLowerCase() === "asc" ? "asc" : String(query.dir ?? "").toLowerCase() === "desc" ? "desc" : sortRaw ? "asc" : defaultDir;
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(query.limit ?? "100"), 10) || 100));
  // Test and internal rows are hidden unless asked for (off by default).
  const includeTest = ["1", "true", "yes", "on"].includes(String(query.includeTest ?? "").trim().toLowerCase());
  const offset = Math.max(0, Number.parseInt(String(query.offset ?? "0"), 10) || 0);
  return {
    chainId,
    period: String(query.period ?? "").trim() || null,
    status: String(query.status ?? "").trim().toLowerCase() || null,
    category: String(query.category ?? query.program ?? "").trim() || null,
    flag: flag || null,
    q: String(query.q ?? "").trim().toLowerCase().slice(0, 120) || null,
    sort,
    dir,
    limit,
    offset,
    includeTest,
  };
}

/** Recruiter row limited to one chain: money and USD of that chain only. */
function scopeRecruiter(row, chainId) {
  if (chainId == null) return row;
  const c = row.chains[chainId];
  return {
    ...row,
    chains: c ? { [chainId]: c } : {},
    earnedUsd: c ? c.usd.earned : 0,
    claimableUsd: c ? c.usd.claimable : 0,
    pendingUsd: c ? c.usd.pending : 0,
    claimedUsd: c ? c.usd.claimed : 0,
    failedVoidedUsd: c ? c.usd.failedVoided : 0,
  };
}

function recruiterOnChain(row, chainId) {
  if (row.chains[chainId]) return true;
  if (row.payoutWallets.some((p) => p.chainId === chainId)) return true;
  return row.walletChainId === chainId || (chainId === 4663 && row.walletChainId === 56);
}

function recruiterStatusBucket(row) {
  const kinds = [];
  for (const c of Object.values(row.chains)) {
    if (rawBig(c.raw.claimable) > 0n) kinds.push("claimable");
    if (rawBig(c.raw.pending) > 0n) kinds.push("pending");
    if (rawBig(c.raw.claimed) > 0n) kinds.push("claimed");
    if (rawBig(c.raw.failedVoided) > 0n) kinds.push("voided");
  }
  return kinds;
}

export function filterModerationRows(tab, rows, f) {
  const fields = SEARCH_FIELDS[tab];
  return rows.filter((row) => {
    if (f.chainId != null) {
      if (tab === "recruiters" ? !recruiterOnChain(row, f.chainId) : row.chainId !== f.chainId) return false;
    }
    if (f.period) {
      if (tab === "airdrops" && row.period !== f.period) return false;
      if (tab === "leagues" && row.epochKey !== f.period && row.period !== f.period) return false;
    }
    if (f.category) {
      if (tab === "airdrops" && row.program !== f.category) return false;
      if (tab === "leagues" && row.category !== f.category) return false;
    }
    if (f.status) {
      if (tab === "recruiters") {
        if (f.status !== lower(row.status) && !recruiterStatusBucket(row).includes(f.status)) return false;
      } else if (row.status !== f.status) return false;
    }
    if (f.flag === "any" && row.flags.length === 0) return false;
    if (f.flag === "none" && row.flags.length > 0) return false;
    if (f.flag && f.flag !== "any" && f.flag !== "none" && !row.flags.includes(f.flag)) return false;
    if (f.q) {
      const hay = fields.map((k) => lower(row[k])).join(" ");
      const linked = tab === "recruiters" ? row.linkedWallets.map((l) => lower(l.wallet)).join(" ") + " " + row.payoutWallets.map((p) => lower(p.address)).join(" ") : "";
      if (!hay.includes(f.q) && !linked.includes(f.q)) return false;
    }
    return true;
  }).map((row) => (tab === "recruiters" ? scopeRecruiter(row, f.chainId) : row));
}

function sortValue(row, key) {
  if (key === "flags") return row.flags.length;
  if (key === "amount") return Number(row.amount);
  if (key === "rootPosted") return row.rootPosted ? 1 : 0;
  if (key === "recruiterId") return row.recruiterId == null ? null : Number(row.recruiterId);
  return row[key];
}

export function sortModerationRows(rows, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    const na = va == null || va === "";
    const nb = vb == null || vb === "";
    if (na && nb) return String(a.id).localeCompare(String(b.id));
    if (na) return 1;
    if (nb) return -1;
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return cmp === 0 ? String(a.id).localeCompare(String(b.id)) : cmp * sign;
  });
}

/** Totals of the filtered rows: native per chain (never mixed), USD across all. */
export function moderationTotals(tab, rows) {
  const perChain = new Map();
  const get = (chainId) => {
    const chain = chainOf(chainId);
    if (!perChain.has(chain.chainId)) perChain.set(chain.chainId, { chainId: chain.chainId, chain: chain.label, asset: chain.asset, decimals: chain.decimals, raw: {}, count: 0 });
    return perChain.get(chain.chainId);
  };
  const usd = {};
  let unpriced = 0;
  const addUsd = (kind, value) => { if (value == null) unpriced += 1; else usd[kind] = roundUsd((usd[kind] || 0) + value); };
  if (tab === "recruiters") {
    for (const row of rows) {
      for (const c of Object.values(row.chains)) {
        const t = get(c.chainId);
        t.count += 1;
        for (const kind of ["earned", "claimable", "pending", "claimed", "failedVoided"]) {
          t.raw[kind] = (rawBig(t.raw[kind]) + rawBig(c.raw[kind])).toString();
          addUsd(kind, c.usd[kind]);
        }
      }
    }
  } else {
    for (const row of rows) {
      if (row.chainId == null) continue;
      const t = get(row.chainId);
      t.count += 1;
      t.raw.amount = (rawBig(t.raw.amount) + rawBig(row.amountRaw)).toString();
      const kind = row.status === "claimed" ? "claimed" : row.status === "claimable" ? "claimable" : row.status === "pending" ? "pending" : row.status === "expired" ? "expired" : "voided";
      t.raw[kind] = (rawBig(t.raw[kind]) + rawBig(row.amountRaw)).toString();
      addUsd("amount", row.amountUsd);
      if (row.amountUsd != null) usd[kind] = roundUsd((usd[kind] || 0) + row.amountUsd);
    }
  }
  const chains = [...perChain.values()].map((t) => ({
    chainId: t.chainId, chain: t.chain, asset: t.asset, rows: t.count,
    amounts: Object.fromEntries(Object.entries(t.raw).map(([k, v]) => [k, atomicToDecimal(v, t.decimals)])),
  }));
  return { rows: rows.length, chains, usd, unpricedRows: unpriced };
}

export function moderationFacets(tab, rows) {
  const count = (list) => {
    const map = new Map();
    for (const v of list) if (v != null && v !== "") map.set(v, (map.get(v) || 0) + 1);
    return [...map.entries()].map(([value, n]) => ({ value: String(value), count: n }));
  };
  const flags = count(rows.flatMap((r) => r.flags)).map((f) => ({ ...f, label: MODERATION_FLAGS[f.value]?.label || f.value }));
  if (tab === "airdrops") {
    return {
      chains: count(rows.map((r) => r.chainId)),
      periods: count(rows.map((r) => r.period)).sort((a, b) => b.value.localeCompare(a.value)),
      categories: count(rows.map((r) => r.program)).map((c) => ({ ...c, label: PROGRAM_LABELS[c.value] || c.value })),
      statuses: count(rows.map((r) => r.status)),
      flags,
    };
  }
  if (tab === "leagues") {
    return {
      chains: count(rows.map((r) => r.chainId)),
      periods: count(rows.map((r) => r.epochKey)).sort((a, b) => b.value.slice(-10).localeCompare(a.value.slice(-10)) || a.value.localeCompare(b.value))
        .map((p) => ({ ...p, label: `${PERIOD_LABELS[p.value.split(":")[0]] || p.value.split(":")[0]} ${p.value.split(":")[1]}` })),
      categories: count(rows.map((r) => r.category)).map((c) => ({ ...c, label: CATEGORY_LABELS[c.value] || c.value })),
      statuses: count(rows.map((r) => r.status)),
      flags,
    };
  }
  return {
    chains: count(rows.flatMap((r) => [...new Set([...Object.keys(r.chains), ...r.payoutWallets.map((p) => p.chainId).filter(Boolean)].map(String))])),
    periods: [],
    categories: [],
    statuses: count(rows.flatMap((r) => [lower(r.status), ...recruiterStatusBucket(r)])),
    flags,
  };
}

/**
 * Full read for one tab: filtered, sorted, totals and facets; `page` slices.
 * Without `f.includeTest` the test and internal rows leave first (rows,
 * totals, facets, flag counts and the CSV all follow), and `testHidden` says
 * how many rows matching the other filters that hid.
 */
export function queryModerationTab(dataset, tab, f, { page = true } = {}) {
  const everything = dataset[tab] || [];
  const all = f.includeTest ? everything : everything.filter((row) => !row.testData);
  const testHidden = f.includeTest ? 0 : filterModerationRows(tab, everything.filter((row) => row.testData), f).length;
  const filtered = filterModerationRows(tab, all, f);
  const sorted = sortModerationRows(filtered, f.sort, f.dir);
  const rows = page ? sorted.slice(f.offset, f.offset + f.limit) : sorted;
  return {
    total: sorted.length,
    offset: page ? f.offset : 0,
    limit: page ? f.limit : sorted.length,
    nextOffset: page && f.offset + f.limit < sorted.length ? f.offset + f.limit : null,
    rows,
    totals: moderationTotals(tab, sorted),
    facets: moderationFacets(tab, all),
    flagCounts: Object.fromEntries(Object.keys(MODERATION_FLAGS).map((k) => [k, filtered.filter((r) => r.flags.includes(k)).length])),
    includeTest: Boolean(f.includeTest),
    testHidden,
  };
}

// --------------------------------------------------------------------------
// CSV

function csvCell(value) {
  if (value == null) return "";
  let text = Array.isArray(value) ? value.join(" | ") : String(value);
  // Spreadsheet formula injection: a cell starting with = + @ or a dash that is
  // not a number is prefixed with a quote so it is shown, not evaluated.
  if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(\.\d+)?$/.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const testText = (row) => (row.testReasons || []).map((r) => TEST_DATA_REASONS[r] || r).join(" | ");

const flagText = (row) => row.flags.map((f) => (row.flagNotes[f] ? `${MODERATION_FLAGS[f]?.label || f}: ${row.flagNotes[f]}` : MODERATION_FLAGS[f]?.label || f)).join(" | ");

export const CSV_COLUMNS = Object.freeze({
  airdrops: [
    ["Epoch", (r) => r.period], ["Chain", (r) => r.chain], ["Program", (r) => r.programLabel], ["Rank", (r) => r.rank],
    ["Wallet", (r) => r.wallet], ["Profile", (r) => r.profileName], ["Score", (r) => r.score], ["Reason", (r) => r.reason],
    ["Amount", (r) => r.amount], ["Asset", (r) => r.asset], ["USD", (r) => r.amountUsd], ["USD basis", (r) => r.usdBasis],
    ["Status", (r) => r.status], ["Batch status", (r) => r.batchStatus], ["Claim deadline", (r) => r.deadline],
    ["Claimed at", (r) => r.claimedAt], ["Claim tx", (r) => r.txUrl || r.txHash], ["Flags", flagText], ["Test or internal", testText],
  ],
  leagues: [
    ["Period", (r) => r.periodLabel], ["Epoch start", (r) => r.epochStart], ["Chain", (r) => r.chain], ["Category", (r) => r.categoryLabel],
    ["Place", (r) => r.rank], ["Wallet", (r) => r.wallet], ["Payout address", (r) => r.recipient], ["Profile", (r) => r.profileName],
    ["Coin", (r) => r.coinName || r.coinSymbol], ["Coin address", (r) => r.coinAddress], ["Test coin", (r) => (r.testCoin ? "yes" : "no")],
    ["Score", (r) => r.score], ["Reason", (r) => r.reason], ["Amount", (r) => r.amount], ["Asset", (r) => r.asset],
    ["USD", (r) => r.amountUsd], ["USD basis", (r) => r.usdBasis], ["Root posted", (r) => (r.rootPosted ? "yes" : "no")],
    ["Status", (r) => r.status], ["Expires", (r) => r.deadline], ["Claimed at", (r) => r.claimedAt], ["Payout tx", (r) => r.txUrl || r.txHash], ["Flags", flagText], ["Test or internal", testText],
  ],
  recruiters: [
    ["Recruiter id", (r) => r.recruiterId], ["Account id", (r) => r.accountId], ["Code", (r) => r.code], ["Name", (r) => r.name],
    ["Handle", (r) => r.handle], ["Email", (r) => r.email], ["Wallet", (r) => r.wallet],
    ["Payout wallets", (r) => r.payoutWallets.map((p) => `${p.chain}: ${p.address}`)], ["Signed up", (r) => r.signupAt], ["Status", (r) => r.status],
    ["Linked wallets", (r) => r.linkedTotal], ["Active links", (r) => r.linkedActive], ["Detached links", (r) => r.linkedDetached],
    ["Earned USD", (r) => r.earnedUsd], ["Claimable USD", (r) => r.claimableUsd], ["Claimed USD", (r) => r.claimedUsd], ["Failed or voided USD", (r) => r.failedVoidedUsd],
    ["Native per chain", (r) => Object.values(r.chains).map((c) => `${c.chain}: earned ${c.earned} ${c.asset}, claimable ${c.claimable}, claimed ${c.claimed}, failed/voided ${c.failedVoided}`)],
    ["Last activity", (r) => r.lastActivityAt], ["Flags", flagText], ["Test or internal", testText],
  ],
});

export function moderationCsv(tab, rows, { includeEmail = true } = {}) {
  const columns = CSV_COLUMNS[tab].filter(([header]) => includeEmail || header !== "Email");
  const lines = [columns.map(([header]) => csvCell(header)).join(",")];
  for (const row of rows) lines.push(columns.map(([, pick]) => csvCell(pick(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
