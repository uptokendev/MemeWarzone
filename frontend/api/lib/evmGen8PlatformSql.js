/**
 * The platform status of a generation 8 coin in SQL (contract fix round 2026-10-12, F1; founder rule): a gen-8 coin is
 * graduated for the platform only when its one-time latch is set AND its pool price is at or past the graduation
 * price now (evm_gen8_pools.graduated_block is not null AND last_phase = 'post', written by the gen-8 indexer). The
 * latch alone (campaigns.graduated_at_chain / graduated_block, which the indexer never clears) is not enough: a forced
 * latch whose price fell back into range A is a bonding coin again (shared/evmGen8.mjs gen8PlatformStatus).
 *
 * For the Arena paths that admit only graduated launch coins (votes, tournament opt-in, MWL check-in and league coins,
 * battles). The rule is on only where gen-8 is configured for the chain AND the fix-round columns exist
 * (gen8Tables().phase); otherwise every helper returns the caller's original text, byte for byte. Gen-6/7 and Solana
 * rows are never affected: the extra condition applies to campaigns.factory_generation = 8 only.
 */
import { gen8ConfigFor } from "./evmGen8Config.js";
import { gen8Tables } from "./evmGen8Schema.js";

/** True when the price-phase rule applies on `db` for `chainId`. Never throws. */
export async function gen8PhaseRuleOn(db, chainId, env = process.env) {
  if (!gen8ConfigFor(Number(chainId), env)) return false;
  try {
    return Boolean((await gen8Tables(db)).phase);
  } catch {
    return false;
  }
}

/**
 * SQL boolean: the gen-8 pool of the campaigns row `outer` (a qualifier ending in ".", e.g. "c." or "campaigns.") is
 * latched AND in its post phase.
 */
export function gen8PoolGraduatedSql(outer) {
  return `exists (select 1 from public.evm_gen8_pools g8s
            where g8s.chain_id = ${outer}chain_id and g8s.token_address = ${outer}campaign_address
              and g8s.graduated_block is not null and g8s.last_phase = 'post')`;
}

/**
 * Replacement for `<q>graduated_at_chain is not null`: the same text when `on` is false; else that condition AND,
 * for a gen-8 row, the platform rule. `outer` qualifies the campaigns row inside the subquery (default `q`; pass
 * "campaigns." when the caller's text is unqualified).
 */
export function graduatedSqlFor(q, on, outer = q) {
  const base = `${q}graduated_at_chain is not null`;
  if (!on) return base;
  return `(${base} and (coalesce(${outer}factory_generation, 0) <> 8 or ${gen8PoolGraduatedSql(outer)}))`;
}

/**
 * An extra select column `gen8_platform_graduated` for a campaigns row aliased `outer` ("c."): NULL for every row that
 * is not gen-8, true / false for a gen-8 row. Empty string when `on` is false, so the select list is unchanged.
 */
export function gen8PlatformGraduatedColumn(outer, on) {
  if (!on) return "";
  return `,
        (case when coalesce(${outer}factory_generation, 0) = 8 then ${gen8PoolGraduatedSql(outer)} end) as gen8_platform_graduated`;
}
