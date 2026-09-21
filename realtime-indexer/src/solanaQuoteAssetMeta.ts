/**
 * What the indexer records about the quote side of a graduated Solana pool.
 *
 * CampaignGraduated carries the quote mint; the catalog knows its symbol,
 * decimals and (for stablecoins) the USD reference the graduation was priced
 * with. Native SOL needs no lookup. Unknown mints are still recorded, just
 * without a symbol, so a pool never disappears from the indexer because the
 * catalog changed.
 */

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export type SolanaQuoteAssetType = "WRAPPED_NATIVE" | "OTHER";

export type SolanaQuoteAssetMeta = {
  quoteMint: string;
  quoteSymbol: string | null;
  quoteDecimals: number | null;
  quoteAssetClass: string | null;
  quoteAssetType: SolanaQuoteAssetType;
  quoteDeploymentId: string | null;
  /** USD per whole quote unit from the active catalog policy, when it states one. */
  quoteReferenceUsd: number | null;
};

export type SolanaQuoteCatalogRow = {
  deployment_id?: string | null;
  symbol?: string | null;
  asset_class?: string | null;
  decimals?: number | string | null;
  reference_usd_micros?: string | number | null;
};

export const SOLANA_QUOTE_CATALOG_BY_MINT_SQL = `
select
  d.id::text as deployment_id,
  a.symbol,
  a.asset_class,
  d.decimals,
  pv.policy_config #>> '{solanaGraduation,referenceUsdMicros}' as reference_usd_micros
from public.quote_asset_deployments d
join public.quote_assets a on a.id = d.quote_asset_id
left join public.quote_asset_policy_versions pv on pv.quote_asset_id = a.id and pv.policy_status = 'active'
where d.chain_id = $1 and d.contract_address_or_mint = $2
order by pv.version desc nulls last
limit 1`;

export function quoteAssetTypeForMint(quoteMint: string): SolanaQuoteAssetType {
  return String(quoteMint || "").trim() === NATIVE_SOL_MINT ? "WRAPPED_NATIVE" : "OTHER";
}

export function describeSolanaQuoteAsset(input: { quoteMint: string; row: SolanaQuoteCatalogRow | null }): SolanaQuoteAssetMeta {
  const quoteMint = String(input.quoteMint || "").trim() || NATIVE_SOL_MINT;
  if (quoteMint === NATIVE_SOL_MINT) {
    return {
      quoteMint,
      quoteSymbol: "SOL",
      quoteDecimals: 9,
      quoteAssetClass: "NATIVE",
      quoteAssetType: "WRAPPED_NATIVE",
      quoteDeploymentId: null,
      quoteReferenceUsd: null,
    };
  }
  const row = input.row;
  const decimals = row?.decimals != null ? Number(row.decimals) : NaN;
  const micros = row?.reference_usd_micros != null && String(row.reference_usd_micros).trim() !== "" ? Number(row.reference_usd_micros) : NaN;
  return {
    quoteMint,
    quoteSymbol: row?.symbol ? String(row.symbol).trim() || null : null,
    quoteDecimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : null,
    quoteAssetClass: row?.asset_class ? String(row.asset_class).trim().toUpperCase() || null : null,
    quoteAssetType: "OTHER",
    quoteDeploymentId: row?.deployment_id ? String(row.deployment_id) : null,
    quoteReferenceUsd: Number.isFinite(micros) && micros > 0 ? micros / 1_000_000 : null,
  };
}

export async function loadSolanaQuoteAssetMeta(
  db: { query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> },
  input: { chainId: number; quoteMint: string },
): Promise<SolanaQuoteAssetMeta> {
  const quoteMint = String(input.quoteMint || "").trim();
  if (!quoteMint || quoteMint === NATIVE_SOL_MINT) return describeSolanaQuoteAsset({ quoteMint: NATIVE_SOL_MINT, row: null });
  let row: SolanaQuoteCatalogRow | null = null;
  try {
    const result = await db.query(SOLANA_QUOTE_CATALOG_BY_MINT_SQL, [String(input.chainId), quoteMint]);
    row = (result.rows[0] as SolanaQuoteCatalogRow | undefined) || null;
  } catch (error) {
    console.warn("[solana-indexer] quote catalog lookup failed", { quoteMint, error: error instanceof Error ? error.message : String(error) });
  }
  return describeSolanaQuoteAsset({ quoteMint, row });
}
