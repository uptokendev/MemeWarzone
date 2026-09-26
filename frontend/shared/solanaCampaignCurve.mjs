/**
 * Solana bonding progress, the way Token Details measures it (src/pages/TokenDetails.tsx): net SOL
 * raised against the SOL that actually closes THIS campaign's curve -- the smaller of its native
 * graduation target (its USD target at the SOL price) and the cost of selling its whole curve supply.
 * Offsets mirror decodeSolanaCampaignAccount (src/lib/solanaCampaignRead.ts) and the program's
 * Campaign account; a parity test pins them.
 */

const DISCRIMINATOR = 8;
// Byte offsets after the discriminator (see decodeSolanaCampaignAccount's take* sequence).
const OFF = (() => {
  let o = DISCRIMINATOR;
  o += 32 + 32 + 32 + 32; // campaign_id, generation_id, generation_config, generation_manifest_hash
  o += 32 * 4; // creator, mint, token_vault, sol_vault
  o += 32 * 4; // metadata_hash, cluster_hash, ticker_hash, reservation_id_hash
  o += 8 + 8; // reservation_version, launch_at
  const graduationTargetUsdMicros = o; o += 8;
  o += 1; // cluster_kind
  const economicsVersion = o; o += 2;
  o += 1; // curve_kind
  o += 8; // token_total_supply
  const curveTokenSupply = o; o += 8;
  o += 8 + 8; // liquidity_token_supply, reserve_token_supply
  const tokenDecimals = o; o += 1;
  o += 2 + 2; // curve_supply_bps, liquidity_token_bps
  const basePriceLamports = o; o += 8;
  const priceSlopeLamports = o; o += 8;
  o += 2 * 5 + 1; // buy/sell/finalize fee bps, creator/liquidity post-finalize bps, dex_adapter
  o += 32 * 5; // route/treasury/dex/oracle profiles
  o += 8 + 2 + 8; // creator_buy_lock_until, creator_buy_cap_bps, created_at
  const soldTokens = o; o += 8;
  const netRaisedLamports = o; o += 8;
  o += 8 * 4; // total buy/sell volume, buyer_count, creator_bought_tokens
  o += 2 + 1; // asset_initialization_version, mint_authority_revoked
  const graduated = o;
  return { graduationTargetUsdMicros, economicsVersion, curveTokenSupply, tokenDecimals, basePriceLamports, priceSlopeLamports, soldTokens, netRaisedLamports, graduated };
})();

export function decodeSolanaCampaignCurve(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < DISCRIMINATOR + 400) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o) => view.getBigUint64(o, true);
  return {
    graduationTargetUsdMicros: u64(OFF.graduationTargetUsdMicros),
    economicsVersion: view.getUint16(OFF.economicsVersion, true),
    curveTokenSupply: u64(OFF.curveTokenSupply),
    tokenDecimals: view.getUint8(OFF.tokenDecimals),
    basePriceLamports: u64(OFF.basePriceLamports),
    priceSlopeLamports: u64(OFF.priceSlopeLamports),
    soldTokens: u64(OFF.soldTokens),
    netRaisedLamports: u64(OFF.netRaisedLamports),
    graduated: view.getUint8(OFF.graduated) !== 0,
  };
}

/** Same integral as solanaCurveCostLamports (src/lib/solanaCampaignRead.ts). */
export function solanaCurveCostLamports(curve, supplyRaw) {
  const tokenScale = 10n ** BigInt(Math.max(0, Number(curve.tokenDecimals || 0)));
  const slopeDenominator = Number(curve.economicsVersion || 0) >= 3 ? tokenScale * 1_000_000_000n : tokenScale;
  if (supplyRaw <= 0n) return 0n;
  return (curve.basePriceLamports * supplyRaw) / tokenScale + (curve.priceSlopeLamports * supplyRaw * supplyRaw) / (2n * slopeDenominator * tokenScale);
}

/** Lamports at which this campaign's curve closes, exactly as Token Details computes it. */
export function solanaCurveCloseLamports(curve, solUsd) {
  let target = 0n;
  const price = Number(solUsd);
  if (price > 0 && curve.graduationTargetUsdMicros > 0n) {
    target = (curve.graduationTargetUsdMicros * 1_000_000_000n) / BigInt(Math.max(1, Math.round(price * 1_000_000)));
  }
  const full = solanaCurveCostLamports(curve, curve.curveTokenSupply);
  return target > 0n && target < full ? target : full;
}

/** Progress in percent (4 decimals), Token Details' formula; null when the close amount is unknown. */
export function solanaBondingProgressPct(curve, solUsd) {
  if (curve.graduated) return 100;
  const closesAt = solanaCurveCloseLamports(curve, solUsd);
  if (closesAt <= 0n) return null;
  return Math.max(0, Math.min(100, Number((curve.netRaisedLamports * 1_000_000n) / closesAt) / 10_000));
}
