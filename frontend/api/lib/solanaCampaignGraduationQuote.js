/**
 * Which quote asset a Solana campaign graduates against.
 *
 * The creator picks a Graduation Market in the create flow. That choice is
 * stored in campaign_draft_graduation_quote_selection keyed by the draft, and
 * the draft is linked to the campaign PDA when the create is finalized.
 * Nothing else carries the choice: the on-chain campaign has no quote field
 * before graduation, and the graduation executor used to read one global
 * SOLANA_GRADUATION_QUOTE_CONFIG_ID for every campaign, so a USDC selection
 * would have graduated as SOL. This module is the single place that turns a
 * campaign address into its bound quote, so the authorization API, the handoff
 * route and the indexer keeper all agree.
 *
 * A campaign without a draft selection (direct create, drafts made before the
 * catalog) is a native SOL campaign.
 */

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * The binding written at finalize (draft and direct creates alike), with the
 * catalog deployment it points at (if it still exists).
 */
export const SOLANA_CAMPAIGN_QUOTE_BINDING_SQL = `
select
  b.draft_id::text as draft_id,
  b.source as binding_source,
  b.quote_asset_id,
  b.policy_version,
  b.selected_state_version,
  q.id::text as deployment_id,
  q.identity_kind,
  q.contract_address_or_mint,
  q.decimals,
  q.catalog_state,
  a.symbol,
  a.asset_class
from public.campaign_graduation_quote_bindings b
left join public.quote_asset_deployments q on q.id::text = lower(trim(b.quote_asset_id))
left join public.quote_assets a on a.id = q.quote_asset_id
where b.chain_id = $1 and b.campaign_address = $2
limit 1`;

/**
 * Fallback for campaigns finalized before campaign_graduation_quote_bindings
 * existed: the draft's selection, reached through the draft's campaign link.
 */
export const SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL = `
select
  d.id::text as draft_id,
  'draft'::text as binding_source,
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

export const SOLANA_CAMPAIGN_QUOTE_BINDING_UPSERT_SQL = `
insert into public.campaign_graduation_quote_bindings(
  chain_id, campaign_address, quote_asset_id, selected_state_version, policy_version, source, draft_id, updated_at
) values ($1, $2, $3, $4, $5, $6, $7::uuid, now())
on conflict (chain_id, campaign_address) do update set
  quote_asset_id = excluded.quote_asset_id,
  selected_state_version = excluded.selected_state_version,
  policy_version = excluded.policy_version,
  source = excluded.source,
  draft_id = coalesce(excluded.draft_id, public.campaign_graduation_quote_bindings.draft_id),
  updated_at = now()
returning chain_id, campaign_address, quote_asset_id, selected_state_version, policy_version, source, draft_id::text as draft_id`;

export class SolanaGraduationQuoteBindingError extends Error {
  constructor(message, { code = "SOLANA_GRADUATION_QUOTE_BINDING_INVALID", httpStatus = 409 } = {}) {
    super(message);
    this.name = "SolanaGraduationQuoteBindingError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Binding first (draft and direct creates), then the legacy draft selection. */
export async function loadSolanaCampaignQuoteSelection(db, { chainId, campaignAddress }) {
  const chain = Number(chainId);
  const campaign = String(campaignAddress || "").trim();
  if (!Number.isInteger(chain) || !campaign) return null;
  const bound = await db.query(SOLANA_CAMPAIGN_QUOTE_BINDING_SQL, [chain, campaign]);
  if (bound?.rows?.[0]) return bound.rows[0];
  const result = await db.query(SOLANA_CAMPAIGN_QUOTE_SELECTION_SQL, [chain, campaign]);
  return result?.rows?.[0] || null;
}

/**
 * Bind a campaign to its Graduation Market at finalize. `source` says which
 * create path wrote it. The value is a catalog reference (deployment id, state
 * version, policy version), never a mint: the catalog stays the authority for
 * what that id means.
 */
export async function recordSolanaCampaignGraduationQuote(db, {
  chainId,
  campaignAddress,
  quoteAssetId,
  selectedStateVersion = 0,
  policyVersion,
  source,
  draftId = null,
}) {
  const chain = Number(chainId);
  const campaign = String(campaignAddress || "").trim();
  const quote = String(quoteAssetId || "").trim().toLowerCase();
  const policy = String(policyVersion ?? "").trim();
  if (!Number.isInteger(chain) || !campaign) throw new SolanaGraduationQuoteBindingError("chainId and campaignAddress are required to bind a Graduation Market.", { httpStatus: 400 });
  if (!quote) throw new SolanaGraduationQuoteBindingError("quoteAssetId is required to bind a Graduation Market.", { httpStatus: 400 });
  if (!policy) throw new SolanaGraduationQuoteBindingError("policyVersion is required to bind a Graduation Market.", { httpStatus: 400 });
  if (!["draft", "direct", "operator"].includes(String(source))) throw new SolanaGraduationQuoteBindingError(`Unknown binding source ${source}.`, { httpStatus: 400 });
  const result = await db.query(SOLANA_CAMPAIGN_QUOTE_BINDING_UPSERT_SQL, [
    chain,
    campaign,
    quote,
    Number.isFinite(Number(selectedStateVersion)) ? Math.max(0, Math.trunc(Number(selectedStateVersion))) : 0,
    policy,
    String(source),
    draftId ? String(draftId) : null,
  ]);
  return result?.rows?.[0] || null;
}

/**
 * Turn a selection row (or none) into the binding the operators act on.
 *
 * `resolved` is false when the draft references a deployment the catalog no
 * longer has; such a campaign must not graduate until an operator looks at it.
 */
export function describeSolanaGraduationQuoteBinding({ selection, nativeQuoteConfigId }) {
  const nativeDefault = String(nativeQuoteConfigId || "").trim() || null;
  if (!selection) {
    return {
      source: "native_default",
      bindingSource: null,
      quoteConfigId: nativeDefault,
      native: true,
      resolved: true,
      quoteMint: NATIVE_SOL_MINT,
      symbol: "SOL",
      decimals: 9,
      assetClass: "NATIVE",
      catalogState: null,
      draftId: null,
      policyVersion: null,
      selectedStateVersion: null,
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
    bindingSource: selection.binding_source ? String(selection.binding_source) : "draft",
    quoteConfigId,
    native,
    resolved,
    quoteMint: native ? NATIVE_SOL_MINT : resolved && mint ? mint : null,
    symbol: resolved ? String(selection.symbol || "").trim() || null : null,
    decimals: native ? 9 : resolved && selection.decimals != null ? Number(selection.decimals) : null,
    assetClass: resolved ? assetClass || null : null,
    catalogState: resolved ? selection.catalog_state || null : null,
    draftId: selection.draft_id ? String(selection.draft_id) : null,
    policyVersion: selection.policy_version != null ? String(selection.policy_version) : null,
    selectedStateVersion: selection.selected_state_version != null ? Number(selection.selected_state_version) : null,
  };
}

export async function resolveSolanaCampaignGraduationQuote(db, { chainId, campaignAddress, nativeQuoteConfigId }) {
  const selection = await loadSolanaCampaignQuoteSelection(db, { chainId, campaignAddress });
  return describeSolanaGraduationQuoteBinding({
    selection,
    nativeQuoteConfigId: nativeQuoteConfigId ?? process.env.SOLANA_GRADUATION_NATIVE_QUOTE_CONFIG_ID,
  });
}

/**
 * The quote config id the authorization signs for.
 *
 * A bound campaign graduates against its selection, full stop: a caller that
 * asks for something else is refused rather than silently corrected, because
 * an executor asking for the wrong quote is misconfigured. An unbound campaign
 * takes the caller's id (the executor's env) or the native default.
 */
export function decideSolanaGraduationQuoteConfigId({ requestedConfigId, binding }) {
  const requested = String(requestedConfigId || "").trim();
  if (binding.source === "draft_selection") {
    if (!binding.resolved) {
      throw new SolanaGraduationQuoteBindingError(
        `Campaign is bound to quote ${binding.quoteConfigId || "(empty)"}, which is not in the Quote Asset Catalog.`,
        { code: "SOLANA_GRADUATION_QUOTE_BINDING_UNRESOLVED" },
      );
    }
    if (requested && requested.toLowerCase() !== binding.quoteConfigId) {
      throw new SolanaGraduationQuoteBindingError(
        `Campaign is bound to quote ${binding.quoteConfigId} (${binding.symbol || "?"}); requested ${requested}.`,
        { code: "SOLANA_GRADUATION_QUOTE_BINDING_MISMATCH" },
      );
    }
    return binding.quoteConfigId;
  }
  if (requested) return requested;
  if (binding.quoteConfigId) return binding.quoteConfigId;
  throw new SolanaGraduationQuoteBindingError(
    "quoteConfigId is required and must be an authoritative Quote Asset Catalog deployment id.",
    { code: "SOLANA_GRADUATION_QUOTE_NOT_APPROVED", httpStatus: 400 },
  );
}

/** Environment the spawned operator receives so it can log and cross-check the binding. */
export function solanaGraduationOperatorEnv(binding) {
  return {
    SOLANA_GRADUATION_QUOTE_PROFILE: binding.native ? "native" : "quote",
    ...(binding.quoteConfigId ? { SOLANA_GRADUATION_QUOTE_CONFIG_ID: binding.quoteConfigId } : {}),
    ...(binding.symbol ? { SOLANA_GRADUATION_QUOTE_SYMBOL: binding.symbol } : {}),
    ...(binding.quoteMint ? { SOLANA_GRADUATION_QUOTE_MINT: binding.quoteMint } : {}),
  };
}

/**
 * Which operator command graduates this campaign.
 *
 * The native operator (scripts/solana/graduate-campaign.mjs) signs a SOL-only
 * binding locally and knows nothing about quotes. A campaign bound to USDC must
 * go to the quote-aware operator, and if that is not configured the campaign
 * waits rather than graduating against the wrong asset.
 */
export function selectSolanaGraduationOperatorCommand({ binding, nativeCommand, quoteCommand }) {
  const native = String(nativeCommand || "").trim();
  const quote = String(quoteCommand || "").trim();
  const env = solanaGraduationOperatorEnv(binding);
  if (binding.source === "draft_selection" && !binding.resolved) {
    return { command: null, env, reason: `campaign is bound to quote ${binding.quoteConfigId || "(empty)"} which is not in the catalog` };
  }
  if (binding.native) {
    const command = native || quote;
    return command
      ? { command, env }
      : { command: null, env, reason: "SOLANA_GRADUATION_HANDOFF_COMMAND is not configured" };
  }
  return quote
    ? { command: quote, env }
    : {
        command: null,
        env,
        reason: `SOLANA_GRADUATION_QUOTE_HANDOFF_COMMAND is not configured; refusing to graduate a ${binding.symbol || binding.quoteConfigId} campaign with the native operator`,
      };
}
