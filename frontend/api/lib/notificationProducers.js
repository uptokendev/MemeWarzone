import { loadPrefs } from "./notificationPrefs.js";
import { verifiedEmailForWallet } from "./arenaNotify.js";
import { readLiveNativeUsd } from "./arenaNativeUsdFeed.mjs";
import { sendEmailNotification } from "./notify.js";
import { CATEGORY_LABELS, absoluteTarget, notificationWalletKey, notifyWallet, unsubscribeUrl } from "./walletNotify.js";

/**
 * CO-5 producers that watch tables instead of a request: rewards that became claimable and coin
 * events (launch, graduation, large buy), plus the hourly email digest. Run by
 * scripts/run-notification-scan.mjs (every 5 min) and scripts/run-notification-digest.mjs (hourly)
 * as Coolify scheduled tasks on the API service.
 *
 * Every notification carries a dedupe key, so a scan can look back generously and run as often as
 * it likes: an event is written once per wallet. Scans never touch money or claims; they only read.
 */

export const DEFAULT_REWARD_LOOKBACK_DAYS = 14;
export const DEFAULT_COIN_LOOKBACK_HOURS = 6;
export const DEFAULT_TRADE_LOOKBACK_MINUTES = 30;
/** Founder 2026-10-03: $500 per buy; overridable with NOTIFY_LARGE_BUY_USD. */
export const DEFAULT_LARGE_BUY_USD = 500;

const CHAIN_NAMES = { 56: "BNB", 97: "BNB testnet", 101: "Solana", 4663: "Robinhood", 46630: "Robinhood testnet" };

export function shortWallet(value) {
  const w = String(value || "");
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

function ticker(symbol, name) {
  const s = String(symbol || "").replace(/^\$/, "").trim();
  return s ? `$${s}` : String(name || "your coin");
}

/** Same form as the app's tokenDetailsPath: /token/<address>, chain pinned only for BNB testnet. */
export function coinPath(chainId, campaign, token) {
  const raw = String(token || campaign || "").trim();
  if (!raw) return "/";
  const id = raw.startsWith("0x") ? raw.toLowerCase() : raw;
  return `/token/${encodeURIComponent(id)}${Number(chainId) === 97 ? "?chainId=97" : ""}`;
}

function commandPath(wallet, tab) {
  return `/profile/${encodeURIComponent(wallet)}/command/${tab}`;
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

/* ------------------------------- rewards ------------------------------- */

export async function scanRewardNotifications(pool, { lookbackDays = DEFAULT_REWARD_LOOKBACK_DAYS, notify = notifyWallet } = {}) {
  const days = String(Math.max(1, Math.floor(Number(lookbackDays) || DEFAULT_REWARD_LOOKBACK_DAYS)));
  const out = { league: 0, ledger: 0, recruiter: 0, battle: 0 };

  // League, MWL and quarterly prizes: claimable once their root is published, until claimed.
  const league = await pool.query(
    `select w.chain_id, w.period, w.epoch_start, w.category, w.rank, w.recipient_address
       from public.league_epoch_winners w
       join public.league_epoch_roots r
         on r.chain_id = w.chain_id and r.period = w.period and r.epoch_start = w.epoch_start
       left join public.league_epoch_claims c
         on c.chain_id = w.chain_id and c.period = w.period and c.epoch_start = w.epoch_start
        and c.category = w.category and c.rank = w.rank
      where r.published_at >= now() - ($1 || ' days')::interval
        and c.claimed_at is null
        and w.swept_at is null
        and coalesce(w.recipient_address, '') <> ''
      limit 2000`,
    [days],
  );
  for (const row of league.rows) {
    const wallet = notificationWalletKey(row.recipient_address);
    if (!wallet) continue;
    const epoch = new Date(row.epoch_start).toISOString().slice(0, 10);
    const r = await notify(pool, {
      wallet,
      category: "rewards",
      kind: "league_prize",
      targetType: "league",
      targetId: `${row.chain_id}:${row.period}:${epoch}:${row.category}:${row.rank}`,
      dedupeKey: `reward:league:${row.chain_id}:${row.period}:${epoch}:${row.category}:${row.rank}`,
      title: `League prize ready: rank ${row.rank}`,
      body: `You placed ${row.rank} in the ${String(row.period).replace(/_/g, " ")} ${String(row.category).replace(/_/g, " ")} league on ${CHAIN_NAMES[row.chain_id] || `chain ${row.chain_id}`}. Claim it in Command Center.`,
      target: commandPath(wallet, "claims"),
    });
    if (r.inserted) out.league += 1;
  }

  // Airdrop and every other reward_ledger row that turned claimable.
  const ledger = await pool.query(
    `select id, reward_type, wallet_address, chain, token_symbol, amount_usd
       from public.reward_ledger
      where status = 'claimable'
        and coalesce(claimable_at, updated_at, created_at) >= now() - ($1 || ' days')::interval
      limit 5000`,
    [days],
  );
  for (const row of ledger.rows) {
    const wallet = notificationWalletKey(row.wallet_address);
    if (!wallet) continue;
    const kind = String(row.reward_type || "reward");
    const usd = Number(row.amount_usd) > 0 ? ` (${formatUsd(row.amount_usd)})` : "";
    const r = await notify(pool, {
      wallet,
      category: "rewards",
      kind: `${kind}_claimable`,
      targetType: "reward_ledger",
      targetId: String(row.id),
      dedupeKey: `reward:ledger:${row.id}`,
      title: kind === "airdrop" ? "Airdrop ready to claim" : `${kind.charAt(0).toUpperCase()}${kind.slice(1)} reward ready to claim`,
      body: `${row.token_symbol || "Your"} reward on ${row.chain || "your chain"}${usd} is ready. Claim it in Command Center.`,
      target: commandPath(wallet, "claims"),
    });
    if (r.inserted) out.ledger += 1;
  }

  // Recruiter earnings accrue per trade: one notice per recruiter per chain per week, not per slice.
  const recruiter = await pool.query(
    `select ra.recruiter_id, coalesce(nullif(r.wallet_address, ''), ra.signup_wallet) as wallet,
            rl.chain_id, max(rl.token) as token, date_trunc('week', now()) as week
       from public.recruiter_reward_ledger rl
       join public.recruiter_accounts ra on ra.recruiter_id = rl.recruiter_id
       left join public.recruiters r on lower(r.code) = lower(ra.code)
      where rl.status = 'claimable'
        and rl.created_at >= now() - interval '7 days'
      group by ra.recruiter_id, 2, rl.chain_id
      limit 2000`,
  );
  for (const row of recruiter.rows) {
    const wallet = notificationWalletKey(row.wallet);
    if (!wallet) continue;
    const week = new Date(row.week).toISOString().slice(0, 10);
    const r = await notify(pool, {
      wallet,
      category: "rewards",
      kind: "recruiter_claimable",
      targetType: "recruiter",
      targetId: `${row.recruiter_id}:${row.chain_id}`,
      dedupeKey: `reward:recruiter:${row.recruiter_id}:${row.chain_id}:${week}`,
      title: "Recruiter earnings ready to claim",
      body: `Coins you recruited traded on ${CHAIN_NAMES[row.chain_id] || "your chain"}. Your ${row.token || ""} earnings are ready in Command Center.`.replace("  ", " "),
      target: commandPath(wallet, "claims"),
    });
    if (r.inserted) out.recruiter += 1;
  }

  // Battle wins with a stake: the winning coin's owner can claim (same rule as /arena/war-pools/claimable).
  const battles = await pool.query(
    `select id, chain_id, winner_token, participants, stake_native, native_symbol
       from public.arena_battles
      where state = 'finished' and winner_token is not null and coalesce(source, '') <> 'tournament'
        and coalesce(stake_native, 0) > 0
        and coalesce(settled_at, finished_at) >= now() - ($1 || ' days')::interval
      limit 1000`,
    [days],
  );
  for (const row of battles.rows) {
    const parts = Array.isArray(row.participants) ? row.participants : [];
    const winner = String(row.winner_token || "").toLowerCase();
    const won = parts.find((p) => String(p.tokenAddress || p.tokenId || "").toLowerCase() === winner);
    const lost = parts.find((p) => p !== won);
    const wallet = notificationWalletKey(won?.ownerWallet);
    if (!wallet) continue;
    const r = await notify(pool, {
      wallet,
      category: "rewards",
      kind: "battle_won",
      targetType: "battle",
      targetId: String(row.id),
      dedupeKey: `reward:battle:${row.id}`,
      title: `${ticker(won?.symbol, won?.name)} won the battle`,
      body: `${ticker(won?.symbol, won?.name)} beat ${ticker(lost?.symbol, lost?.name)}. Claim the battle rewards in Command Center.`,
      target: commandPath(wallet, "battles"),
    });
    if (r.inserted) out.battle += 1;
  }
  return out;
}

/* ------------------------------ coin events ------------------------------ */

export function tradeUsd(row, nativeUsdByChain) {
  const direct = Number(row.volumeUsd);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = nativeUsdByChain[Number(row.chainId)];
  const raw = Number(row.nativeAmountRaw);
  if (!price || !Number.isFinite(raw) || raw <= 0) return 0;
  const decimals = Number(row.chainId) === 101 || Number(row.chainId) === 102 ? 9 : 18;
  return (raw / 10 ** decimals) * price;
}

export async function scanCoinNotifications(pool, {
  lookbackHours = DEFAULT_COIN_LOOKBACK_HOURS,
  tradeLookbackMinutes = DEFAULT_TRADE_LOOKBACK_MINUTES,
  largeBuyUsd = Number(process.env.NOTIFY_LARGE_BUY_USD || DEFAULT_LARGE_BUY_USD),
  priceOf = async (chainId) => Number((await readLiveNativeUsd(chainId)).nativeUsdMicros) / 1_000_000,
  notify = notifyWallet,
} = {}) {
  const hours = String(Math.max(1, Math.floor(Number(lookbackHours) || DEFAULT_COIN_LOOKBACK_HOURS)));
  const out = { launched: 0, graduated: 0, largeBuy: 0 };

  const launched = await pool.query(
    `select chain_id, campaign_address, token_address, creator_address, name, symbol
       from public.campaigns
      where coalesce(created_at_chain, created_at) >= now() - ($1 || ' hours')::interval
        and coalesce(creator_address, '') <> ''
      limit 1000`,
    [hours],
  );
  for (const c of launched.rows) {
    const wallet = notificationWalletKey(c.creator_address);
    if (!wallet) continue;
    const r = await notify(pool, {
      wallet,
      category: "coin",
      kind: "launch",
      targetType: "campaign",
      targetId: `${c.chain_id}:${c.campaign_address}`,
      dedupeKey: `coin:launch:${c.chain_id}:${c.campaign_address}`,
      title: `${ticker(c.symbol, c.name)} is live`,
      body: `Your coin launched on ${CHAIN_NAMES[c.chain_id] || `chain ${c.chain_id}`}. Trading is open.`,
      target: coinPath(c.chain_id, c.campaign_address, c.token_address),
    });
    if (r.inserted) out.launched += 1;
  }

  const graduated = await pool.query(
    `select chain_id, campaign_address, token_address, creator_address, name, symbol
       from public.campaigns
      where graduated_at_chain >= now() - ($1 || ' hours')::interval
        and coalesce(creator_address, '') <> ''
      limit 1000`,
    [hours],
  );
  for (const c of graduated.rows) {
    const wallet = notificationWalletKey(c.creator_address);
    if (!wallet) continue;
    const r = await notify(pool, {
      wallet,
      category: "coin",
      kind: "graduation",
      targetType: "campaign",
      targetId: `${c.chain_id}:${c.campaign_address}`,
      dedupeKey: `coin:graduation:${c.chain_id}:${c.campaign_address}`,
      title: `${ticker(c.symbol, c.name)} graduated`,
      body: "Your coin finished its bonding curve and now trades on its DEX pool.",
      target: coinPath(c.chain_id, c.campaign_address, c.token_address),
    });
    if (r.inserted) out.graduated += 1;
  }

  if (!(Number(largeBuyUsd) > 0)) return out;
  const minutes = String(Math.max(5, Math.floor(Number(tradeLookbackMinutes) || DEFAULT_TRADE_LOOKBACK_MINUTES)));
  const trades = await pool.query(
    `select t."chainId", t."campaignAddress", t."tokenAddress", t.wallet, t."nativeAmountRaw", t."volumeUsd",
            t."txHash", t."logIndex", c.creator_address, c.name, c.symbol
       from public.market_trades_v t
       join public.campaigns c on c.chain_id = t."chainId" and c.campaign_address = t."campaignAddress"
      where lower(t.side) = 'buy'
        and t."blockTime" >= now() - ($1 || ' minutes')::interval
        and coalesce(c.creator_address, '') <> ''
      limit 5000`,
    [minutes],
  );
  const prices = {};
  for (const chainId of new Set(trades.rows.map((t) => Number(t.chainId)))) {
    try {
      prices[chainId] = await priceOf(chainId);
    } catch {
      prices[chainId] = 0; // no live price: only trades that carry their own USD value are judged
    }
  }
  for (const t of trades.rows) {
    const usd = tradeUsd(t, prices);
    if (usd < Number(largeBuyUsd)) continue;
    const wallet = notificationWalletKey(t.creator_address);
    if (!wallet) continue;
    const r = await notify(pool, {
      wallet,
      actorWallet: t.wallet,
      category: "coin",
      kind: "large_buy",
      targetType: "trade",
      targetId: `${t.chainId}:${t.txHash}:${t.logIndex}`,
      dedupeKey: `coin:buy:${t.chainId}:${t.txHash}:${t.logIndex ?? 0}`,
      title: `Large buy on ${ticker(t.symbol, t.name)}`,
      body: `${shortWallet(t.wallet)} bought ${formatUsd(usd)} of ${ticker(t.symbol, t.name)}.`,
      target: coinPath(t.chainId, t.campaignAddress, t.tokenAddress),
    });
    if (r.inserted) out.largeBuy += 1;
  }
  return out;
}

/* -------------------------------- digest -------------------------------- */

const DIGEST_CATEGORIES = ["social", "rewards", "coin"];
const MAX_ITEMS_PER_EMAIL = 20;
/** Rows the digest could not mail (provider error) are retried for a day, then dropped. */
const RETRY_HOURS = 24;

export function buildDigestEmail(wallet, rows) {
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }
  const lines = [];
  let shown = 0;
  for (const category of DIGEST_CATEGORIES) {
    const items = byCategory.get(category) || [];
    if (!items.length) continue;
    lines.push(`${CATEGORY_LABELS[category]} (${items.length})`);
    for (const item of items) {
      if (shown >= MAX_ITEMS_PER_EMAIL) break;
      shown += 1;
      lines.push(`- ${item.title}${item.body ? `: ${item.body}` : ""}`);
      lines.push(`  ${absoluteTarget(item.metadata_json?.target)}`);
    }
    lines.push("");
  }
  if (rows.length > shown) lines.push(`And ${rows.length - shown} more in the bell on MemeWarzone.`, "");
  const stops = [...byCategory.keys()].map((category) => {
    const url = unsubscribeUrl(wallet, category);
    return url ? `Stop ${CATEGORY_LABELS[category].toLowerCase()} emails: ${url}` : null;
  }).filter(Boolean);
  const subject = rows.length === 1 ? `MemeWarzone: ${rows[0].title}` : `MemeWarzone: ${rows.length} new notifications`;
  const text = [...lines, ...stops, "", "MemeWarzone"].join("\n");
  return { subject, text };
}

export async function runNotificationDigest(pool, { send = sendEmailNotification, emailFor = verifiedEmailForWallet, prefsFor = loadPrefs, limit = 5000 } = {}) {
  const { rows } = await pool.query(
    `select id, wallet_address, category, title, body, metadata_json, created_at
       from public.prepare_mode_notifications
      where emailed_at is null and category = any($1::text[])
      order by wallet_address, created_at
      limit $2`,
    [DIGEST_CATEGORIES, limit],
  );
  const byWallet = new Map();
  for (const row of rows) {
    if (!byWallet.has(row.wallet_address)) byWallet.set(row.wallet_address, []);
    byWallet.get(row.wallet_address).push(row);
  }
  const out = { wallets: byWallet.size, emailed: 0, skipped: 0, failed: 0 };
  for (const [wallet, items] of byWallet) {
    let handled = items.map((r) => r.id);
    try {
      const { prefs } = await prefsFor(wallet);
      const wanted = items.filter((r) => prefs?.[r.category]?.email !== false);
      const to = wanted.length ? await emailFor(wallet) : null;
      if (to && wanted.length) {
        const mail = buildDigestEmail(wallet, wanted);
        await send({ to, subject: mail.subject, text: mail.text });
        out.emailed += 1;
      } else {
        out.skipped += 1;
      }
    } catch (error) {
      out.failed += 1;
      console.warn("[notification-digest] mail failed", shortWallet(wallet), error?.message || error);
      // Keep rows younger than a day for the next run; older ones are given up on.
      const cutoff = Date.now() - RETRY_HOURS * 3_600_000;
      handled = items.filter((r) => new Date(r.created_at).getTime() < cutoff).map((r) => r.id);
    }
    if (handled.length) {
      await pool.query(`update public.prepare_mode_notifications set emailed_at = now() where id = any($1::uuid[])`, [handled]);
    }
  }
  return out;
}

/* --------------------------- league check-in --------------------------- */

/** Reminders go out from this UTC hour on, so owners who check in early are not pinged. */
export const DEFAULT_CHECKIN_REMINDER_HOUR_UTC = 12;

/**
 * Daily check-in reminder (founder, 2026-10-08): owners of a coin in this month's Major War League who
 * have not checked in today get one bell row per UTC day. Same eligibility as the check-in itself
 * (api/arenaLeague.js ownedLeagueCoins): a league entry this month, owned as a graduated launchpad coin
 * by its creator or as a passed import. Seasons whose scoring is closed are skipped. Read-only on the
 * league tables; one row per wallet per day through the dedupe key.
 */
export async function scanCheckinReminders(pool, { now = new Date(), hourUtc = Number(process.env.NOTIFY_CHECKIN_REMINDER_HOUR_UTC ?? DEFAULT_CHECKIN_REMINDER_HOUR_UTC), notify = notifyWallet } = {}) {
  const out = { checkin: 0 };
  if (now.getUTCHours() < Math.max(0, Math.min(23, Number(hourUtc) || 0))) return out;
  const day = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const monthIndex = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
  const { rows } = await pool.query(
    `select s.chain_id, e.token_address, e.symbol, e.token_name, e.points, o.wallet,
            last.utc_day::text as last_day, last.streak_days
       from public.arena_league_seasons s
       join public.arena_league_entries e on e.season_id = s.id
       cross join lateral (
         select c.creator_address::text as wallet
           from public.campaigns c
          where c.chain_id = s.chain_id
            and c.graduated_at_chain is not null
            and (lower(coalesce(c.token_address::text, '')) = lower(e.token_address) or lower(c.campaign_address::text) = lower(e.token_address))
         union
         select i.owner_wallet
           from public.arena_token_imports i
          where i.chain_id = s.chain_id and i.status = 'passed' and lower(i.token_address) = lower(e.token_address)
       ) o
       left join lateral (
         select k.utc_day, k.streak_days from public.arena_creator_checkins k
          where lower(k.wallet) = lower(o.wallet)
          order by k.utc_day desc limit 1
       ) last on true
      where s.active = true
        and s.month is not null
        and s.year * 12 + s.month = $1
        and coalesce(s.regular_season_closed, false) = false
        and s.frozen_at is null
        and s.state not in ('quarter_finals', 'completed')
        and coalesce(o.wallet, '') <> ''
        and (last.utc_day is null or last.utc_day::text <> $2)
      order by e.points desc
      limit 2000`,
    [monthIndex, day],
  );

  // One reminder per wallet, naming its highest-scoring coin.
  const byWallet = new Map();
  for (const row of rows) {
    const wallet = notificationWalletKey(row.wallet);
    if (!wallet) continue;
    const entry = byWallet.get(wallet) || { row, coins: 0 };
    entry.coins += 1;
    byWallet.set(wallet, entry);
  }
  // Creators with a live streak (checked in yesterday, not yet today) are reminded too, whatever their
  // coin (2026-10-08): every 7th day in a row earns a free upvote. Same dedupe key: one reminder a day.
  const streakers = new Map();
  const streakTable = await pool.query(`select to_regclass('public.creator_checkins') is not null as ok`).catch(() => ({ rows: [] }));
  if (streakTable.rows[0]?.ok) {
    const { rows: live } = await pool.query(
      `select distinct on (lower(wallet)) wallet, utc_day::text as utc_day, streak_days
         from public.creator_checkins
        where utc_day >= $1::date - 1
        order by lower(wallet), utc_day desc
        limit 5000`,
      [day],
    );
    for (const row of live) {
      const wallet = notificationWalletKey(row.wallet);
      if (!wallet || row.utc_day !== yesterday || byWallet.has(wallet)) continue;
      streakers.set(wallet, Number(row.streak_days || 0));
    }
  }
  for (const [wallet, streakDays] of streakers) {
    const next = streakDays + 1;
    const r = await notify(pool, {
      wallet,
      category: "battles",
      kind: "creator_checkin",
      targetType: "league_checkin",
      targetId: `streak:${day}`,
      dedupeKey: `league:checkin:${wallet}:${day}`,
      title: `Keep your ${streakDays}-day streak`,
      body: next % 7 === 0
        ? `Check in today in Command Center to make it ${next} days and earn a free upvote.`
        : `Check in today in Command Center to make it ${next} days. Every 7th day in a row earns a free upvote.`,
      target: commandPath(wallet, "overview"),
    });
    if (r.inserted) out.checkin += 1;
  }

  for (const [wallet, { row, coins }] of byWallet) {
    const continuing = row.last_day === yesterday;
    const streakDay = continuing ? Number(row.streak_days || 0) + 1 : 1;
    const coinLabel = ticker(row.symbol, row.token_name);
    const streakLine = continuing
      ? ` Day ${streakDay} in a row${streakDay % 7 === 0 ? ": today adds the 0.5 streak bonus." : "; every 7th day adds 0.5."}`
      : " Every 7 days in a row adds 0.5.";
    const r = await notify(pool, {
      wallet,
      category: "battles",
      kind: "league_checkin",
      targetType: "league_checkin",
      targetId: `${row.chain_id}:${day}`,
      dedupeKey: `league:checkin:${wallet}:${day}`,
      title: "Daily check-in is open",
      body: `Check in for ${coinLabel}${coins > 1 ? ` (or one of your ${coins} league coins)` : ""} in Command Center: +0.1 league point.${streakLine}`,
      target: commandPath(wallet, "overview"),
    });
    if (r.inserted) out.checkin += 1;
  }
  return out;
}
