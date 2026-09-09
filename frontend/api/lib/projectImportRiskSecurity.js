const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const REQUEST_TIMEOUT_MS = 6500;

function flag(value) { return value === "1" || value === 1 || value === true; }
function nestedFlag(value) { return Boolean(value) && flag(value.status); }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function add(list, condition, code, label) { if (condition && !list.some((entry) => entry.code === code)) list.push({ code, label }); }
function maliciousInAuthorities(value) {
  const entries = Array.isArray(value) ? value : [];
  return entries.some((entry) => flag(entry?.malicious_address));
}

function authHeaders() {
  const token = String(process.env.GOPLUS_ACCESS_TOKEN || "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json", ...authHeaders() }, signal: controller.signal });
    if (!response.ok) throw new Error(`GoPlus security scan failed (${response.status})`);
    const payload = await response.json();
    if (payload?.code !== undefined && Number(payload.code) !== 1) throw new Error(`GoPlus security scan returned ${payload?.message || "an error"}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function holderConcentration(raw, critical, review) {
  const holders = Array.isArray(raw?.holders) ? raw.holders : [];
  const topPercent = asNumber(holders[0]?.percent);
  add(critical, topPercent !== null && topPercent > 0.5, "holder_concentration_extreme", `Top holder controls ${(topPercent * 100).toFixed(1)}% of supply`);
  add(review, topPercent !== null && topPercent > 0.2 && topPercent <= 0.5, "holder_concentration_high", `Top holder controls ${(topPercent * 100).toFixed(1)}% of supply`);
  return topPercent;
}

function liquidityAssessment(raw, review) {
  const dex = Array.isArray(raw?.dex) ? raw.dex : [];
  add(review, dex.length === 0, "no_dex_liquidity", "No DEX liquidity was detected");
  const lpHolders = Array.isArray(raw?.lp_holders) ? raw.lp_holders : [];
  if (lpHolders.length) {
    const locked = lpHolders.some((entry) => flag(entry?.is_locked));
    add(review, !locked, "liquidity_not_locked", "No locked LP position was detected");
  }
  return { dexPools: dex.length, lpHolderCount: lpHolders.length };
}

function bnbAssessment(raw) {
  const critical = [];
  const review = [];
  add(critical, flag(raw?.is_honeypot), "honeypot", "Honeypot / cannot be sold");
  add(critical, flag(raw?.cannot_sell_all), "cannot_sell_all", "Sell-all restriction detected");
  add(critical, flag(raw?.malicious_address), "malicious_token", "Token is linked to malicious activity");
  add(critical, flag(raw?.honeypot_with_same_creator), "honeypot_creator", "Creator is linked to honeypot tokens");
  add(critical, flag(raw?.owner_change_balance), "owner_change_balance", "Owner can modify holder balances");
  add(critical, flag(raw?.selfdestruct), "selfdestruct", "Contract can self-destruct");
  add(critical, flag(raw?.can_take_back_ownership), "ownership_reclaim", "Ownership can be reclaimed after renouncing");

  add(review, raw?.is_open_source === "0" || raw?.is_open_source === 0, "closed_source", "Contract source is not verified/open");
  add(review, flag(raw?.hidden_owner), "hidden_owner", "Hidden owner mechanism detected");
  add(review, flag(raw?.transfer_pausable), "transfer_pausable", "Transfers can be paused");
  add(review, flag(raw?.is_blacklisted), "blacklist", "Blacklist restrictions detected");
  add(review, flag(raw?.is_whitelisted), "whitelist", "Whitelist trading restrictions detected");
  add(review, flag(raw?.is_mintable), "mintable", "Additional tokens can be minted");
  add(review, flag(raw?.slippage_modifiable), "modifiable_tax", "Trading tax/slippage can be changed");
  add(review, flag(raw?.is_proxy), "proxy", "Upgradeable proxy contract");
  add(review, flag(raw?.trading_cooldown), "trading_cooldown", "Trading cooldown restrictions detected");

  const buyTax = asNumber(raw?.buy_tax);
  const sellTax = asNumber(raw?.sell_tax);
  add(critical, sellTax !== null && sellTax >= 0.5, "extreme_sell_tax", `Extreme sell tax (${Math.round(sellTax * 100)}%)`);
  add(review, sellTax !== null && sellTax >= 0.1 && sellTax < 0.5, "high_sell_tax", `High sell tax (${Math.round(sellTax * 100)}%)`);
  add(review, buyTax !== null && buyTax >= 0.1, "high_buy_tax", `High buy tax (${Math.round(buyTax * 100)}%)`);

  const b20 = raw?.b20_token?.b20_info || {};
  add(critical, nestedFlag(b20?.cannot_sell), "b20_cannot_sell", "Sell restriction detected");
  add(critical, nestedFlag(b20?.owner_change_balance), "b20_owner_change_balance", "Admin can modify holder balances");
  add(review, nestedFlag(b20?.blacklist), "b20_blacklist", "Admin blacklist capability detected");
  add(review, nestedFlag(b20?.whitelist), "b20_whitelist", "Whitelist-only trading capability detected");
  add(review, nestedFlag(b20?.transfer_pausable), "b20_transfer_pausable", "Admin can pause transfers");

  const topHolderPercent = holderConcentration(raw, critical, review);
  const liquidity = liquidityAssessment(raw, review);
  return { critical, review, details: { buyTax, sellTax, holderCount: raw?.holder_count ?? null, topHolderPercent, ...liquidity } };
}

function solanaAssessment(raw) {
  const critical = [];
  const review = [];
  add(critical, String(raw?.default_account_state ?? "") === "1", "default_frozen", "New token accounts default to frozen");
  add(critical, flag(raw?.non_transferable), "non_transferable", "Token is non-transferable");
  add(critical, flag(raw?.creator?.malicious_address), "malicious_creator", "Token creator is flagged malicious");
  add(critical, nestedFlag(raw?.balance_mutable_authority), "balance_mutable", "Authority can alter holder balances");
  add(critical, maliciousInAuthorities(raw?.metadata_mutable?.metadata_upgrade_authority), "malicious_metadata_authority", "Metadata authority is flagged malicious");

  const transferHooks = Array.isArray(raw?.transfer_hook) ? raw.transfer_hook : raw?.transfer_hook ? [raw.transfer_hook] : [];
  add(critical, transferHooks.some((entry) => flag(entry?.malicious_address)), "malicious_transfer_hook", "Transfer hook is flagged malicious");
  add(review, transferHooks.length > 0, "transfer_hook", "External transfer hook is present");

  add(review, nestedFlag(raw?.freezable), "freezable", "Authority can freeze token accounts");
  add(review, nestedFlag(raw?.closable), "closable", "Token accounts can be closed by authority");
  add(review, nestedFlag(raw?.mintable), "mintable", "Additional tokens can be minted");
  add(review, nestedFlag(raw?.metadata_mutable), "metadata_mutable", "Token metadata can be changed");
  add(review, nestedFlag(raw?.transfer_fee_upgradable), "fee_upgradable", "Transfer fee can be changed");
  add(review, nestedFlag(raw?.default_account_state_upgradable), "default_state_upgradable", "Default account state can be changed");
  add(review, nestedFlag(raw?.transfer_hook_upgradable), "hook_upgradable", "Transfer hook can be changed");

  const currentFeeBps = asNumber(raw?.transfer_fee?.current_fee_rate?.fee_rate);
  add(critical, currentFeeBps !== null && currentFeeBps >= 5000, "extreme_transfer_fee", `Extreme transfer fee (${(currentFeeBps / 100).toFixed(0)}%)`);
  add(review, currentFeeBps !== null && currentFeeBps >= 1000 && currentFeeBps < 5000, "high_transfer_fee", `High transfer fee (${(currentFeeBps / 100).toFixed(0)}%)`);

  const topHolderPercent = holderConcentration(raw, critical, review);
  const liquidity = liquidityAssessment(raw, review);
  return { critical, review, details: { transferFeeBps: currentFeeBps, trustedToken: raw?.trusted_token ?? null, holderCount: raw?.holder_count ?? null, topHolderPercent, ...liquidity } };
}

export function classifyProjectImportSecurity({ chainId, raw }) {
  const assessment = Number(chainId) === 56 ? bnbAssessment(raw) : Number(chainId) === 101 ? solanaAssessment(raw) : null;
  if (!assessment) return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "unsupported_chain", label: "Security scanner does not support this chain" }], details: {} };
  const status = assessment.critical.length ? "blocked" : assessment.review.length ? "review" : "pass";
  return { status, provider: "goplus", criticalRisks: assessment.critical, reviewRisks: assessment.review, details: assessment.details };
}

export async function scanProjectImportSecurity({ chainId, tokenAddress, fetchImpl = fetch }) {
  const id = Number(chainId);
  const token = String(tokenAddress || "").trim();
  const url = id === 56
    ? `${GOPLUS_BASE}/token_security/56?contract_addresses=${encodeURIComponent(token.toLowerCase())}`
    : id === 101
      ? `${GOPLUS_BASE}/solana/token_security?contract_addresses=${encodeURIComponent(token)}`
      : null;
  if (!url) return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "unsupported_chain", label: "Security scanner does not support this chain" }], details: {} };
  try {
    const payload = await fetchJson(url, fetchImpl);
    const result = payload?.result;
    const raw = id === 56 ? result?.[token.toLowerCase()] || result?.[token] : result?.[token] || result?.[token.toLowerCase()];
    if (!raw) {
      return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "no_security_data", label: "No security data returned for this token" }], details: {} };
    }
    return classifyProjectImportSecurity({ chainId: id, raw });
  } catch (error) {
    return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "scanner_unavailable", label: "Automatic scam-risk scan is unavailable" }], details: { error: String(error?.message || error) } };
  }
}

export function securityAllowsAutomaticImport(security) {
  return security?.status === "pass";
}
