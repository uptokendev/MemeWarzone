import { pool } from "./db.js";
import { ENV } from "./env.js";

/**
 * Campaigns that advanced their indexer cursor while eth_getLogs was broken
 * end up with last_indexed_block >> created_block and zero curve_trades.
 *
 * When created_block is 0 (legacy rows), we still must rewind — previously we
 * skipped those and ATS/WIC never recovered history.
 */
export async function rewindEmptyCampaignTradeCursor(
  chainId: number,
  campaignAddress: string,
): Promise<{ rewound: boolean; from?: number; to?: number; reason?: string }> {
  const campaign = String(campaignAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(campaign) || !Number.isInteger(chainId) || chainId <= 0) {
    return { rewound: false, reason: "invalid_args" };
  }

  try {
    const stats = await pool.query(
      `select
         coalesce(c.created_block,0)::bigint as created_block,
         coalesce(c.factory_address,'') as factory_address,
         (select count(*)::int from public.curve_trades t
           where t.chain_id=c.chain_id and t.campaign_address=c.campaign_address) as trade_count
       from public.campaigns c
       where c.chain_id=$1 and c.campaign_address=$2
       limit 1`,
      [chainId, campaign],
    );
    const row = stats.rows[0];
    if (!row) return { rewound: false, reason: "campaign_missing" };

    const tradeCount = Number(row.trade_count || 0);
    if (tradeCount > 0) return { rewound: false, reason: "has_trades" };

    const createdBlock = Number(row.created_block || 0);
    const factoryStart =
      chainId === 56
        ? Number(ENV.FACTORY_START_BLOCK_56 || 0)
        : chainId === 46630
          ? Number(ENV.FACTORY_START_BLOCK_46630 || 0)
          : chainId === 4663
            ? Number(ENV.FACTORY_START_BLOCK_4663 || 0)
            : Number(ENV.FACTORY_START_BLOCK_97 || 0);

    const cursor = `campaign:${campaign}`;
    const state = await pool.query(
      `select last_indexed_block from public.indexer_state
       where chain_id=$1 and cursor=$2 limit 1`,
      [chainId, cursor],
    );
    const last = Number(state.rows[0]?.last_indexed_block || 0);
    // No cursor yet: seed at created/factory so the next indexer pass has a floor.
    if (last <= 0) {
      const seed = createdBlock > 0 ? createdBlock : factoryStart > 0 ? factoryStart : 0;
      if (seed <= 0) return { rewound: false, reason: "no_cursor" };
      await pool.query(
        `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
         values ($1,$2,$3)
         on conflict (chain_id,cursor) do update
           set last_indexed_block = least(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
               updated_at = now()`,
        [chainId, cursor, Math.max(0, seed - 1)],
      );
      return { rewound: true, from: 0, to: Math.max(0, seed - 1), reason: "seeded" };
    }

    // created_block when known; else factory start; else last-N so we re-scan a real window.
    // IMPORTANT: when last == created_block the old logic treated cursor as "ok" and never
    // rewound, but getLogs may have failed for months — force a re-scan from created-1.
    let target =
      createdBlock > 0
        ? Math.max(0, createdBlock - 1)
        : factoryStart > 0
          ? factoryStart
          : Math.max(0, last - Number(ENV.FACTORY_LOOKBACK_BLOCKS || 250_000));

    // Always pull cursor back at least a recent window so late buys are not skipped when
    // the rolling lookback advanced past a stuck cursor.
    const recentFloor = Math.max(0, last - Number(ENV.REPAIR_LOOKBACK_BLOCKS || 20_000));
    if (createdBlock > 0) target = Math.min(target, recentFloor);
    else target = Math.min(target, recentFloor);

    if (last <= target) return { rewound: false, reason: "cursor_ok", from: last, to: target };

    await pool.query(
      `insert into public.indexer_state(chain_id,cursor,last_indexed_block)
       values ($1,$2,$3)
       on conflict (chain_id,cursor) do update
         set last_indexed_block = least(public.indexer_state.last_indexed_block, excluded.last_indexed_block),
             updated_at = now()`,
      [chainId, cursor, target],
    );

    console.log("[indexer] rewound empty-trade campaign cursor", {
      chainId,
      campaign,
      from: last,
      to: target,
      createdBlock,
      factoryStart,
    });
    return { rewound: true, from: last, to: target };
  } catch (error) {
    console.warn("[indexer] rewindEmptyCampaignTradeCursor failed", {
      chainId,
      campaign,
      error: String((error as any)?.message || error),
    });
    return { rewound: false, reason: "error" };
  }
}
