/**
 * Which quote asset a Solana campaign graduates against (keeper side).
 *
 * Mirror of frontend/api/lib/solanaCampaignGraduationQuote.js: the creator's
 * Graduation Market selection lives on the draft, the draft is linked to the
 * campaign PDA at finalize, and nothing else carries the choice. The keeper
 * reads it here so a USDC-bound campaign is sent to the quote-aware operator
 * and never to the native one. Keep the SQL and the rules identical to the API
 * copy; the authorization API enforces the same binding when the operator asks
 * for its signature, so a drift here is refused there.
 */

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export const SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL = `
select
  d.id::text as draft_id,
  s.quote_asset_id,
  s.policy_version,
  s.selected_state_version,
  q.id::text as deployment_id,
  q.identity_kind,
  q.contract_address_or_mint,
  q.decimals,
  q.catalog_state,
  a.symbol,
  a.asset_class
from public.campaign_drafts d
join public.campaign_draft_graduation_quote_selection s on s.draft_id = d.id
left join public.quote_asset_deployments q on q.id::text = lower(trim(s.quote_asset_id))
left join public.quote_assets a on a.id = q.quote_asset_id
where d.chain_id = $1 and d.campaign_address = $2
order by s.updated_at desc
limit 1`;

export type SolanaQuoteSelectionRow = {
  draft_id?: string | null;
  quote_asset_id?: string | null;
  policy_version?: string | null;
  selected_state_version?: string | number | null;
  deployment_id?: string | null;
  identity_kind?: string | null;
  contract_address_or_mint?: string | null;
  decimals?: number | string | null;
  catalog_state?: string | null;
  symbol?: string | null;
  asset_class?: string | null;
};

export type SolanaGraduationQuoteBinding = {
  source: "native_default" | "draft_selection";
  quoteConfigId: string | null;
  native: boolean;
  resolved: boolean;
  quoteMint: string | null;
  symbol: string | null;
  decimals: number | null;
  assetClass: string | null;
  catalogState: string | null;
  draftId: string | null;
};

type Queryable = { query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> };

export async function loadSolanaCampaignQuoteSelection(
  db: Queryable,
  input: { chainId: number; campaignAddress: string },
): Promise<SolanaQuoteSelectionRow | null> {
  const campaign = String(input.campaignAddress || "").trim();
  if (!Number.isInteger(input.chainId) || !campaign) return null;
  const result = await db.query(SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL, [input.chainId, campaign]);
  return (result.rows[0] as SolanaQuoteSelectionRow | undefined) || null;
}

export function describeSolanaGraduationQuoteBinding(input: {
  selection: SolanaQuoteSelectionRow | null;
  nativeQuoteConfigId?: string | null;
}): SolanaGraduationQuoteBinding {
  const nativeDefault = String(input.nativeQuoteConfigId || "").trim() || null;
  const selection = input.selection;
  if (!selection) {
    return {
      source: "native_default",
      quoteConfigId: nativeDefault,
      native: true,
      resolved: true,
      quoteMint: NATIVE_SOL_MINT,
      symbol: "SOL",
      decimals: 9,
      assetClass: "NATIVE",
      catalogState: null,
      draftId: null,
    };
  }
  const quoteConfigId = String(selection.quote_asset_id || "").trim().toLowerCase();
  const resolved = Boolean(selection.deployment_id);
  const identityKind = String(selection.identity_kind || "").toUpperCase();
  const assetClass = String(selection.asset_class || "").toUpperCase();
  const native = resolved && (identityKind === "NATIVE" || assetClass === "NATIVE");
  const mint = String(selection.contract_address_or_mint || "").trim();
  return {
    source: "draft_selection",
    quoteConfigId,
    native,
    resolved,
    quoteMint: native ? NATIVE_SOL_MINT : resolved && mint ? mint : null,
    symbol: resolved ? String(selection.symbol || "").trim() || null : null,
    decimals: native ? 9 : resolved && selection.decimals != null ? Number(selection.decimals) : null,
    assetClass: resolved ? assetClass || null : null,
    catalogState: resolved ? selection.catalog_state || null : null,
    draftId: selection.draft_id ? String(selection.draft_id) : null,
  };
}

export function solanaGraduationOperatorEnv(binding: SolanaGraduationQuoteBinding): Record<string, string> {
  return {
    SOLANA_GRADUATION_QUOTE_PROFILE: binding.native ? "native" : "quote",
    ...(binding.quoteConfigId ? { SOLANA_GRADUATION_QUOTE_CONFIG_ID: binding.quoteConfigId } : {}),
    ...(binding.symbol ? { SOLANA_GRADUATION_QUOTE_SYMBOL: binding.symbol } : {}),
    ...(binding.quoteMint ? { SOLANA_GRADUATION_QUOTE_MINT: binding.quoteMint } : {}),
  };
}

export type SolanaGraduationOperatorSelection = {
  command: string | null;
  env: Record<string, string>;
  reason?: string;
};

/**
 * The native operator signs a SOL-only binding locally. Anything else goes to
 * the quote-aware operator, and when that is not configured the campaign
 * waits instead of graduating against the wrong asset.
 */
export function selectSolanaGraduationOperatorCommand(input: {
  binding: SolanaGraduationQuoteBinding;
  nativeCommand?: string | null;
  quoteCommand?: string | null;
}): SolanaGraduationOperatorSelection {
  const native = String(input.nativeCommand || "").trim();
  const quote = String(input.quoteCommand || "").trim();
  const env = solanaGraduationOperatorEnv(input.binding);
  const binding = input.binding;
  if (binding.source === "draft_selection" && !binding.resolved) {
    return { command: null, env, reason: `campaign is bound to quote ${binding.quoteConfigId || "(empty)"} which is not in the catalog` };
  }
  if (binding.native) {
    const command = native || quote;
    return command ? { command, env } : { command: null, env, reason: "SOLANA_GRADUATION_HANDOFF_COMMAND is not configured" };
  }
  return quote
    ? { command: quote, env }
    : {
        command: null,
        env,
        reason: `SOLANA_GRADUATION_QUOTE_HANDOFF_COMMAND is not configured; refusing to graduate a ${binding.symbol || binding.quoteConfigId} campaign with the native operator`,
      };
}
