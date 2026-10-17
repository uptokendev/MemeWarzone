/**
 * Blocked coins (Command Center -> Abuse -> Blocked coins, founder 2026-10-10). Read and write model
 * for public.blocked_coins (db/migrations/20261010_000020_blocked_coins.sql). No database import:
 * every function takes the db (pool or client), so the admin handlers can be tested with a fake.
 *
 * A block never touches campaigns (the indexer would re-create a deleted row). Public reads leave a
 * blocked coin out through publicHiddenOrBlockedWhere (publicHiddenSql.js) and the checks here.
 * Before the migration runs there is no table: every read answers "no block" and never throws.
 */
import { probeBlockedCoinsTable } from "./publicHiddenSql.js";

export const BLOCK_KINDS = Object.freeze(["test", "abuse"]);
export const BLOCK_MODES = Object.freeze(["hide", "remove"]);

const SOLANA_CHAINS = new Set([101, 102]);
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSolanaBlockChain(chainId) {
  return SOLANA_CHAINS.has(Number(chainId));
}

/** The stored form of an address: EVM lower-case, Solana as-is. "" when it is not a valid address. */
export function blockedAddressKey(chainId, address) {
  const raw = String(address ?? "").trim();
  if (!raw) return "";
  if (isSolanaBlockChain(chainId)) return SOLANA_ADDRESS.test(raw) ? raw : "";
  return EVM_ADDRESS.test(raw) ? raw.toLowerCase() : "";
}

export function isMissingTable(error) {
  return error?.code === "42P01";
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/** BlockedCoin as the dashboard reads it. */
export function mapBlockedCoin(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    campaignAddress: row.campaign_address || null,
    tokenAddress: row.token_address || null,
    name: row.name || null,
    symbol: row.symbol || null,
    kind: String(row.kind),
    mode: String(row.mode),
    reason: row.reason || "",
    abuseReportId: row.abuse_report_id ? String(row.abuse_report_id) : null,
    createdByEmail: row.created_by_email || null,
    createdAt: iso(row.created_at),
    releasedAt: iso(row.released_at),
    releasedByEmail: row.released_by_email || null,
    releaseReason: row.release_reason || null,
  };
}

const BLOCK_COLUMNS = `id, chain_id, campaign_address, token_address, name, symbol, kind, mode, reason, abuse_report_id,
  created_by, created_by_email, created_at, released_at, released_by, released_by_email, release_reason, side_effects`;

/** Active block for a coin by its campaign or token address, or null (also before the migration). */
export async function findActiveBlock(db, chainId, address) {
  const chain = Number(chainId);
  const key = blockedAddressKey(chain, address);
  if (!Number.isInteger(chain) || chain <= 0 || !key) return null;
  if (!(await probeBlockedCoinsTable(db))) return null;
  try {
    const { rows } = await db.query(
      `select ${BLOCK_COLUMNS} from public.blocked_coins
        where released_at is null and chain_id = $1 and (campaign_address = $2 or token_address = $2)
        order by id desc limit 1`,
      [chain, key],
    );
    return rows[0] || null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

// Public pages (coin page, story, share link) ask per view; a short cache keeps that off the database.
const PUBLIC_TTL_MS = 30_000;
const publicCache = new Map();

export function clearBlockedCoinCache() {
  publicCache.clear();
}

/** findActiveBlock for public reads: cached 30 s, and a database error reads as "no block". */
export async function activeBlockForPublic(db, chainId, address) {
  const key = `${Number(chainId)}:${blockedAddressKey(chainId, address)}`;
  const hit = publicCache.get(key);
  if (hit && Date.now() - hit.at < PUBLIC_TTL_MS) return hit.block;
  let block = null;
  try {
    block = await findActiveBlock(db, chainId, address);
  } catch (error) {
    console.warn("[blockedCoins] block check failed", error?.message || error);
    return null;
  }
  if (publicCache.size > 5000) publicCache.clear();
  publicCache.set(key, { at: Date.now(), block });
  return block;
}

/** Active blocks on one chain (for /api/campaigns/hidden and the listing key set). [] before the migration. */
export async function loadActiveBlocks(db, chainId) {
  if (!(await probeBlockedCoinsTable(db))) return [];
  try {
    const { rows } = await db.query(
      `select id, chain_id, campaign_address, token_address, mode from public.blocked_coins
        where released_at is null and chain_id = $1`,
      [Number(chainId)],
    );
    return rows;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** Blocks for the dashboard list. status: active | released | all. */
export async function listBlocks(db, status = "active") {
  const where = status === "released" ? "where released_at is not null" : status === "all" ? "" : "where released_at is null";
  const { rows } = await db.query(
    `select ${BLOCK_COLUMNS} from public.blocked_coins ${where} order by created_at desc, id desc limit 500`,
  );
  return rows;
}

function addrMatch(chainId, column, param) {
  return isSolanaBlockChain(chainId) ? `${column} = ${param}` : `lower(${column}) = ${param}`;
}

/**
 * The coin behind a campaign or token address: a launched coin (campaigns) first, else a listed import
 * (arena_token_imports). null when neither knows it.
 */
export async function lookupCoin(db, chainId, address) {
  const chain = Number(chainId);
  const key = blockedAddressKey(chain, address);
  if (!key) return null;
  const { rows } = await db.query(
    `select chain_id, campaign_address, token_address, name, symbol, creator_address, logo_uri, launched, graduated_at_chain
       from public.campaigns
      where chain_id = $1 and (${addrMatch(chain, "campaign_address", "$2")} or ${addrMatch(chain, "token_address", "$2")})
      order by created_at desc nulls last
      limit 1`,
    [chain, key],
  );
  const c = rows[0];
  if (c) {
    return {
      chainId: chain,
      campaignAddress: blockedAddressKey(chain, c.campaign_address) || null,
      tokenAddress: blockedAddressKey(chain, c.token_address) || null,
      name: c.name || null,
      symbol: c.symbol || null,
      creatorAddress: c.creator_address || null,
      logoUrl: c.logo_uri || null,
      launched: Boolean(c.launched),
      graduated: Boolean(c.graduated_at_chain),
      imported: false,
    };
  }
  try {
    const imported = await db.query(
      `select chain_id, token_address, name, symbol, coalesce(project_owner_wallet, owner_wallet) as owner, image_url
         from public.arena_token_imports
        where chain_id = $1 and ${addrMatch(chain, "token_address", "$2")}
        order by updated_at desc nulls last
        limit 1`,
      [chain, key],
    );
    const i = imported.rows[0];
    if (!i) return null;
    return {
      chainId: chain,
      campaignAddress: null,
      tokenAddress: blockedAddressKey(chain, i.token_address) || key,
      name: i.name || null,
      symbol: i.symbol || null,
      creatorAddress: i.owner || null,
      logoUrl: i.image_url || null,
      launched: false,
      graduated: false,
      imported: true,
    };
  } catch (error) {
    if (isMissingTable(error) || error?.code === "42703") return null;
    throw error;
  }
}

/** Runs fn inside a savepoint; a missing table/column (migration not applied) skips it. */
async function optionalStep(client, name, fn, fallback) {
  await client.query(`savepoint ${name}`);
  try {
    const out = await fn();
    await client.query(`release savepoint ${name}`);
    return out;
  } catch (error) {
    await client.query(`rollback to savepoint ${name}`);
    if (error?.code === "42P01" || error?.code === "42703") return fallback;
    throw error;
  }
}

function addressForms(chainId, ...addresses) {
  const out = new Set();
  for (const a of addresses) {
    const raw = String(a || "").trim();
    if (!raw) continue;
    out.add(raw);
    if (!isSolanaBlockChain(chainId)) out.add(raw.toLowerCase());
  }
  return [...out];
}

/**
 * What a block takes down with it, inside the caller's transaction:
 *  - the coin's launch / graduation auto-update posts (social_posts.system_event_key), every post that
 *    mentions the coin (its coin card), and the replies to those posts: soft-deleted (status 2);
 *  - the creator's "coin is live" notification: marked read.
 * Returns the ids it changed, stored in blocked_coins.side_effects so a release can undo the posts.
 */
export async function applyBlockSideEffects(client, { chainId, campaignAddress, tokenAddress }) {
  const chain = Number(chainId);
  const coinAddrs = addressForms(chain, campaignAddress, tokenAddress);
  const campaignForms = addressForms(chain, campaignAddress);
  const eventKeys = campaignForms.flatMap((a) => [`deploy:${chain}:${a}`, `graduated:${chain}:${a}`]);
  const notifyKeys = campaignForms.map((a) => `coin:launch:${chain}:${a}`);
  const mentionLower = isSolanaBlockChain(chain) ? coinAddrs : coinAddrs.map((a) => a.toLowerCase());
  const mention = isSolanaBlockChain(chain)
    ? "(p.mentioned_campaign = any($2::text[]) or p.mentioned_token = any($2::text[]))"
    : "(lower(p.mentioned_campaign) = any($2::text[]) or lower(p.mentioned_token) = any($2::text[]))";

  const hidePosts = (withEventKeys) =>
    client.query(
      `with targets as (
         select p.id from public.social_posts p
          where p.status = 0
            and ((p.mentioned_chain_id = $1 and ${mention})${withEventKeys ? " or p.system_event_key = any($3::text[])" : ""})
       ), replies as (
         select r.id from public.social_posts r
          where r.status = 0 and r.parent_id in (select id from targets)
       )
       update public.social_posts s
          set status = 2
        where s.id in (select id from targets union select id from replies)
        returning s.id`,
      withEventKeys ? [chain, mentionLower, eventKeys] : [chain, mentionLower],
    );

  let socialPostIds = [];
  if (coinAddrs.length) {
    // social_posts.system_event_key arrived with a later migration: without it, mentions only.
    const { rows: col } = await client.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'social_posts' and column_name = 'system_event_key' limit 1`,
    );
    const withEventKeys = (col?.length ?? 0) > 0;
    socialPostIds = await optionalStep(
      client,
      "blocked_coin_posts",
      async () => (await hidePosts(withEventKeys)).rows.map((r) => String(r.id)),
      [],
    );
  }

  const notificationIds = !notifyKeys.length
    ? []
    : await optionalStep(
        client,
        "blocked_coin_notifications",
        async () =>
          (
            await client.query(
              `update public.prepare_mode_notifications
                  set is_read = true, read_at = coalesce(read_at, now())
                where dedupe_key = any($1::text[]) and is_read = false
                returning id`,
              [notifyKeys],
            )
          ).rows.map((r) => String(r.id)),
        [],
      );

  return { socialPostIds, notificationIds };
}

/** Release: puts back the posts the block soft-deleted (only those still soft-deleted). */
export async function undoBlockSideEffects(client, sideEffects) {
  const ids = (Array.isArray(sideEffects?.socialPostIds) ? sideEffects.socialPostIds : [])
    .map((id) => String(id))
    .filter((id) => /^\d{1,18}$/.test(id));
  if (!ids.length) return { restoredPostIds: [] };
  const restored = await optionalStep(
    client,
    "blocked_coin_restore",
    async () =>
      (
        await client.query(
          `update public.social_posts set status = 0 where id = any($1::bigint[]) and status = 2 returning id`,
          [ids],
        )
      ).rows.map((r) => String(r.id)),
    [],
  );
  return { restoredPostIds: restored };
}
