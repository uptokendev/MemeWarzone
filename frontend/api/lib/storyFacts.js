/**
 * Facts for one coin's Story (see storyBuilder.mjs for the rules that turn them into chapters).
 * Read-only. Everything a chapter states comes from a source the app already shows:
 *   - launched coins: the campaign card (campaigns-base, incl. bonding progress), the Prepare Mode
 *     draft and its promotion metrics, curve_trades, market_stats;
 *   - imported coins: arena_token_imports, arena_import_market_stats, the import's DEX pool history
 *     and birth (GeckoTerminal via the shared, rate-capped source);
 *   - both: finished arena battles (vote counts as stored at settlement, what the Battle Wall shows),
 *     the Major War League board and the featured-votes list (their own handlers, in-process).
 */
import { pool } from "../../server/db.js";
import campaignsBase from "../campaigns-base.js";
import arenaLeague from "../arenaLeague.js";
import arenaVotes from "../arenaVotes.js";
import { importPool } from "../arenaImports.js";
import { impliedSupply, sharedCandleSource, toCandleRows } from "./arenaImportCandles.js";
import { geckoTerminalNetwork } from "./arenaImportMarketFeed.js";
import { getArenaTokenProfile } from "./arenaTokenProfile.js";
import { callJson } from "./internalJson.js";
import { logoAssets } from "./storyImages.js";

const CHAIN_LABEL = { 101: "Solana", 56: "BNB Chain", 4663: "Robinhood Chain" };
const NATIVE = { 101: "SOL", 56: "BNB", 4663: "ETH" };
const TX_BASE = { 101: "https://solscan.io/tx/", 56: "https://bscscan.com/tx/", 4663: "https://robinhoodchain.blockscout.com/tx/" };
export const STORY_CHAINS = Object.keys(CHAIN_LABEL).map(Number);

/** Firsts only count from the public launch; earlier rows are test campaigns (founder, 2026-09-27). */
function publicLaunchAt() {
  const raw = String(process.env.MWZ_PUBLIC_LAUNCH_AT || "2026-09-25T00:00:00Z");
  const t = Date.parse(raw);
  return new Date(Number.isFinite(t) ? t : Date.parse("2026-09-25T00:00:00Z")).toISOString();
}

const isSolana = (chainId) => Number(chainId) === 101;
const sameAddr = (chainId, a, b) => (isSolana(chainId) ? String(a || "") === String(b || "") : String(a || "").toLowerCase() === String(b || "").toLowerCase());
const shortWallet = (w) => { const s = String(w || ""); return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-3)}` : s || null; };
const httpsOrNull = (v) => (/^https:\/\//i.test(String(v || "")) ? String(v) : null);
const addrClause = (chainId, column, param) => (isSolana(chainId) ? `${column} = ${param}` : `lower(${column}) = lower(${param})`);

async function one(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function battleFacts(chainId, ids) {
  const keys = ids.filter(Boolean);
  if (!keys.length) return [];
  const { rows } = await pool.query(
    `select id, battle_mode, started_at, winner_token, participants, challenger_token, defender_token,
            challenger_battle_points, defender_battle_points
       from public.arena_battles
      where chain_id = $1 and state = 'finished'
        and (challenger_token = any($2::text[]) or defender_token = any($2::text[]))
      order by coalesce(finished_at, settled_at, started_at) desc
      limit 2`,
    [chainId, keys],
  );
  const out = [];
  for (const row of rows) {
    const parts = Array.isArray(row.participants) ? row.participants : [];
    const mineToken = keys.find((k) => sameAddr(chainId, k, row.challenger_token)) ? row.challenger_token : row.defender_token;
    const rivalToken = sameAddr(chainId, mineToken, row.challenger_token) ? row.defender_token : row.challenger_token;
    const pick = (token) => parts.find((p) => [p.tokenAddress, p.tokenId, p.campaignAddress].some((v) => sameAddr(chainId, v, token))) || {};
    const me = pick(mineToken), rival = pick(rivalToken);
    const vote = row.battle_mode === "vote";
    const myPoints = vote ? me.votePoints : sameAddr(chainId, mineToken, row.challenger_token) ? row.challenger_battle_points : row.defender_battle_points;
    const rivalPoints = vote ? rival.votePoints : sameAddr(chainId, mineToken, row.challenger_token) ? row.defender_battle_points : row.challenger_battle_points;
    const rivalProfile = await getArenaTokenProfile(chainId, rivalToken).catch(() => null);
    out.push({
      id: String(row.id), at: row.started_at, mode: vote ? "vote" : "metrics",
      won: sameAddr(chainId, row.winner_token, mineToken),
      me: { points: myPoints ?? null },
      rival: { ticker: String(rival.symbol || rivalProfile?.symbol || "").replace(/^\$/, "") || null, points: rivalPoints ?? null, imageUrl: httpsOrNull(rival.imageUrl || rivalProfile?.imageUrl) },
    });
  }
  return out.filter((b) => b.rival.ticker);
}

async function standingFacts(chainId, ids) {
  const rows = [];
  const league = await callJson(arenaLeague, "/arena/league", { chainId }).catch(() => null);
  const season = league?.season;
  const entry = (season?.entries || []).find((e) => ids.some((id) => sameAddr(chainId, id, e.tokenAddress || e.tokenId)));
  if (entry && Number(entry.rank) > 0) {
    const pts = Number(entry.points || 0);
    rows.push({ position: `#${entry.rank}`, label: String(season.label || "Major War League"), detail: `${pts} pt${pts === 1 ? "" : "s"} · ${Number(entry.wins || 0)}W / ${Number(entry.losses || 0)}L` });
  }
  const featured = await callJson(arenaVotes, "/arena/votes/featured", {}).catch(() => null);
  const idx = (featured?.items || []).findIndex((f) => Number(f.chainId) === Number(chainId) && ids.some((id) => sameAddr(chainId, id, f.tokenAddress)));
  if (idx >= 0) {
    const v = Number(featured.items[idx].votes24h || 0);
    rows.push({ position: `#${idx + 1}`, label: "Featured memecoins", detail: `${v} UP vote${v === 1 ? "" : "s"} in 24h` });
  }
  return rows;
}

async function launchedFacts(chainId, token) {
  const cards = await callJson(campaignsBase, "/campaigns", { chainId, search: token, limit: 5 });
  const card = (cards?.items || []).find((c) => sameAddr(chainId, c.tokenAddress, token) || sameAddr(chainId, c.campaignAddress, token));
  if (!card) return null;
  const campaign = String(card.campaignAddress), tokenAddress = String(card.tokenAddress || campaign);
  const launchAt = card.createdAtChain ? new Date(card.createdAtChain).toISOString() : null;
  const since = publicLaunchAt();

  const draft = await one(
    `select d.*, p.mission_statement, p.creator_note, p.x_url as p_x, p.telegram_url as p_tg, p.website_url as p_web, p.published_at,
            m.views, m.follows,
            (select min(f.created_at) from public.campaign_draft_follows f where f.draft_id = d.id) as first_follow_at
       from public.campaign_drafts d
       left join public.campaign_draft_promotion p on p.draft_id = d.id
       left join public.campaign_draft_metrics m on m.draft_id = d.id
      where d.chain_id = $1 and (${addrClause(chainId, "d.campaign_address", "$2")} or ${addrClause(chainId, "d.token_address", "$3")})
      order by d.deployed_at desc nulls last limit 1`,
    [chainId, campaign, tokenAddress],
  );
  const firsts = launchAt && launchAt >= since
    ? await one(
      `select (select campaign_address from public.campaigns where chain_id in (56, 101, 4663) and created_at >= $1 order by created_at asc limit 1) as first_any,
              (select campaign_address from public.campaigns where chain_id = $2 and created_at >= $1 order by created_at asc limit 1) as first_chain`,
      [since, chainId],
    )
    : null;
  const tradeAgg = await one(
    `select count(*)::int as n, count(distinct wallet)::int as wallets from public.curve_trades where chain_id = $1 and ${addrClause(chainId, "campaign_address", "$2")}`,
    [chainId, campaign],
  );
  const firstBuy = await one(
    `select block_time, wallet, bnb_amount, tx_hash from public.curve_trades where chain_id = $1 and ${addrClause(chainId, "campaign_address", "$2")} and side = 'buy' order by block_time asc, log_index asc limit 1`,
    [chainId, campaign],
  );
  const bigBuy = await one(
    `select block_time, wallet, bnb_amount, tx_hash from public.curve_trades where chain_id = $1 and ${addrClause(chainId, "campaign_address", "$2")} and side = 'buy' order by bnb_amount::numeric desc, block_time asc limit 1`,
    [chainId, campaign],
  );
  const stats = await one(`select holders from public.market_stats where chain_id = $1 and ${addrClause(chainId, "campaign_address", "$2")} limit 1`, [chainId, campaign]);
  const trade = (row) => row && {
    at: new Date(row.block_time).toISOString(), amount: Number(row.bnb_amount), unit: NATIVE[chainId],
    wallet: shortWallet(row.wallet), txUrl: row.tx_hash ? `${TX_BASE[chainId]}${row.tx_hash}` : null,
  };
  const logoUrl = httpsOrNull(card.logoUri || draft?.logo_url);
  return {
    origin: "launched", name: String(card.name || draft?.name || "").trim(), ticker: String(card.symbol || draft?.ticker || "").replace(/^\$/, ""),
    token: tokenAddress, logoUrl, tokenPath: `/token/${tokenAddress}`, ids: [tokenAddress, campaign],
    creator: {
      description: draft?.description || draft?.mission_statement || null, note: draft?.creator_note || null,
      socials: { x: httpsOrNull(draft?.p_x || draft?.x_url), telegram: httpsOrNull(draft?.p_tg), website: httpsOrNull(draft?.p_web || draft?.website_url) },
    },
    promotion: draft && (draft.published_at || draft.status === "deployed") ? { createdAt: draft.created_at, views: draft.views, follows: draft.follows, firstFollowAt: draft.first_follow_at } : null,
    launch: launchAt ? { at: launchAt, firstOnMwz: sameAddr(chainId, firsts?.first_any, campaign), firstOnChain: sameAddr(chainId, firsts?.first_chain, campaign) } : null,
    trades: tradeAgg?.n ? { count: tradeAgg.n, wallets: tradeAgg.wallets, first: trade(firstBuy), biggest: trade(bigBuy) } : null,
    holders: stats?.holders != null ? Number(stats.holders) : null,
    progress: Number.isFinite(Number(card.progressPct)) ? { percent: Math.round(Number(card.progressPct) * 100) / 100, targetUsd: Number(card.graduationTargetUsd) || null } : null,
  };
}

async function importedFacts(chainId, token) {
  const row = await one(
    `select i.*, s.holders, s.market_cap_usd, s.liquidity_usd from public.arena_token_imports i
       left join public.arena_import_market_stats s on s.chain_id = i.chain_id and s.token_address = i.token_address
      where i.chain_id = $1 and ${addrClause(chainId, "i.token_address", "$2")} limit 1`,
    [chainId, token],
  );
  if (!row) return null;
  const tokenAddress = String(row.token_address);
  const profile = await getArenaTokenProfile(chainId, tokenAddress).catch(() => null);
  const network = geckoTerminalNetwork(chainId);
  const found = await importPool(chainId, tokenAddress).catch(() => null);
  let history = [], born = null;
  if (network && found?.pairAddress) {
    const source = sharedCandleSource();
    const [daily, info] = await Promise.all([
      source.bars({ network, pairAddress: found.pairAddress, tokenAddress, resolution: "1d" }).catch(() => ({ bars: [] })),
      source.poolInfo({ network, pairAddress: found.pairAddress }).catch(() => null),
    ]);
    history = toCandleRows(daily.bars || [], impliedSupply(found.marketCapUsd, found.priceUsd, daily.bars || []))
      .filter((r) => r.mcap_c != null)
      .map((r) => ({ time: r.bucket_start, high: Number(r.mcap_h), low: Number(r.mcap_l), close: Number(r.mcap_c) }));
    if (info?.createdAt) born = { at: info.createdAt };
  }
  return {
    origin: "imported", name: String(row.name || profile?.name || "").trim(), ticker: String(row.symbol || profile?.symbol || "").replace(/^\$/, ""),
    token: tokenAddress, logoUrl: httpsOrNull(row.image_url || profile?.imageUrl), tokenPath: `/token/${tokenAddress}?chainId=${chainId}`, ids: [tokenAddress],
    creator: { description: row.description || null, note: null, socials: { x: httpsOrNull(row.x_url), telegram: httpsOrNull(row.telegram_url), website: httpsOrNull(row.website) } },
    born, history,
    joined: { at: row.created_at, ownerVerified: row.ownership_status === "ownership_verified", cleared: row.status === "passed" },
    market: { holders: row.holders ?? profile?.holders ?? null, marketCapUsd: row.market_cap_usd ?? profile?.marketCapUsd ?? null, liquidityUsd: row.liquidity_usd ?? profile?.liquidityUsd ?? null },
  };
}

/** The owner's saved text; a missing table (migration not yet applied) reads as "nothing written". */
async function storyProfile(chainId, token) {
  try {
    const row = await one(`select short_story, sections, updated_at from public.token_story_profiles where chain_id = $1 and ${addrClause(chainId, "token_address", "$2")} limit 1`, [chainId, token]);
    return row ? { shortStory: row.short_story || null, sections: row.sections || {}, updatedAt: row.updated_at } : null;
  } catch (error) {
    if (!/token_story_profiles/.test(String(error?.message || ""))) throw error;
    return null;
  }
}

/**
 * Coin page edits that the Story reads (founder D3 + D4, 2026-10-02): the bio and the founder note set
 * after launch. Separate from storyProfile so a database without those columns reads as "not set".
 */
async function coinPageStoryOverrides(chainId, token) {
  try {
    const row = await one(`select bio, founder_note from public.token_story_profiles where chain_id = $1 and ${addrClause(chainId, "token_address", "$2")} limit 1`, [chainId, token]);
    return row ? { bio: row.bio || null, founderNote: row.founder_note || null } : null;
  } catch (error) {
    if (error?.code === "42703" || error?.code === "42P01") return null;
    throw error;
  }
}

/** Facts for buildStory, or null when the coin is neither a MemeWarzone launch nor an import. */
export async function storyFacts(chainId, token, { shareBase } = {}) {
  const id = Number(chainId);
  if (!CHAIN_LABEL[id] || !token) return null;
  const base = (await importedFacts(id, token)) || (await launchedFacts(id, token));
  if (!base || !base.name || !base.ticker || !base.logoUrl) return null;
  const [assets, battles, standing, profile, overrides] = await Promise.all([
    logoAssets(base.logoUrl),
    battleFacts(id, base.ids),
    standingFacts(id, base.ids),
    storyProfile(id, base.token),
    base.origin === "launched" ? coinPageStoryOverrides(id, base.token) : null,
  ]);
  const { ids, ...rest } = base;
  // Launched coins only, and only when set: otherwise the Story reads exactly what it did before.
  if (overrides && rest.creator) {
    rest.creator = {
      ...rest.creator,
      description: overrides.bio || rest.creator.description,
      note: overrides.founderNote || rest.creator.note,
    };
  }
  return {
    ...rest, chainId: id, chainLabel: CHAIN_LABEL[id],
    accent: assets.accent, accent2: assets.accent2, logoAnimated: assets.animated,
    shareBase: String(shareBase || process.env.STORY_SHARE_BASE || "https://api.memewar.zone").replace(/\/+$/, ""),
    battles, standing, storyProfile: profile,
  };
}
