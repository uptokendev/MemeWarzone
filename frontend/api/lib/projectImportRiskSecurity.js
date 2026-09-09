const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const REQUEST_TIMEOUT_MS = 6500;

function flag(value) { return value === "1" || value === 1 || value === true; }
function nestedFlag(value) { return Boolean(value) && flag(value.status); }
function asNumber(value) { if (value == null || typeof value === "boolean" || String(value).trim() === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
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

function holderConcentration(raw, critical, review, context = {}) {
  const holders = Array.isArray(raw?.holders) ? raw.holders : null;
  if (!holders) { add(review,true,"holder_data_unavailable","Holder concentration could not be checked"); return { topHolderPercent:null, excludedMarketInventory:[] }; }
  const custody = Array.isArray(context.custody) ? context.custody : [];
  const excludedMarketInventory = [], percentages = [];
  for (const holder of holders) {
    const percent = asNumber(holder?.percent);
    if (percent === null || percent < 0 || percent > 1) { add(review,true,"holder_data_invalid","A holder percentage was unavailable or invalid"); continue; }
    const match = custody.find(c => c.verified === true && c.mint === context.tokenAddress && holder.token_account === c.tokenAccount && (!holder.account || holder.account === c.owner));
    if (match) { excludedMarketInventory.push({ account:match.owner, tokenAccount:match.tokenAccount, percent, reason:"verified_market_custody" }); continue; }
    percentages.push(percent);
  }
  const topPercent = percentages.length ? Math.max(...percentages) : null;
  add(critical, topPercent !== null && topPercent > 0.5, "holder_concentration_extreme", `Largest listed non-market holder has ${(topPercent * 100).toFixed(1)}% of supply`);
  add(review, topPercent !== null && topPercent > 0.2 && topPercent <= 0.5, "holder_concentration_high", `Largest listed non-market holder has ${(topPercent * 100).toFixed(1)}% of supply`);
  return { topHolderPercent:topPercent, excludedMarketInventory };
}

function liquidityAssessment(raw, review, context = {}) {
  const market=context.market;
  if (market?.verified && market?.phase === "bonding") return { dexPools:null, lpHolderCount:null, liquidityEvidence:"bonding_curve_not_graduated" };
  if (market?.verified && market?.phase === "postgrad") {
    add(review, market.liquidityAvailable !== true, "pool_reserves_unavailable", "A post-graduation pool exists but usable reserves were not established");
    return { dexPools:1, lpHolderCount:null, liquidityEvidence:"onchain_pool_and_reserves", executionTested:false };
  }
  const dex = Array.isArray(raw?.dex) ? raw.dex : null;
  add(review, dex === null, "liquidity_data_unavailable", "The scanner did not provide DEX liquidity data; this is not a zero-liquidity finding");
  add(review, dex !== null && dex.length === 0, "no_indexed_dex_pool", "The scanner reported no indexed DEX pool; market status needs verification");
  const lpHolders = Array.isArray(raw?.lp_holders) ? raw.lp_holders : null;
  if (lpHolders?.length) add(review, !lpHolders.some(entry => flag(entry?.is_locked)), "liquidity_not_locked", "No locked LP position was reported by the scanner");
  return { dexPools:dex?.length ?? null, lpHolderCount:lpHolders?.length ?? null, liquidityEvidence:dex ? "provider_report_only" : "unavailable" };
}

function providerRawSnapshot(raw) {
  const fields=["default_account_state","non_transferable","freezable","mintable","closable","balance_mutable_authority","metadata_mutable","transfer_fee","transfer_fee_upgradable","transfer_hook","transfer_hook_upgradable","default_account_state_upgradable","creator","creators","holder_count","holders","dex","lp_holders","is_honeypot","cannot_sell_all","buy_tax","sell_tax","is_open_source","owner_change_balance","selfdestruct","can_take_back_ownership","hidden_owner","transfer_pausable","is_blacklisted","is_whitelisted","slippage_modifiable","is_proxy","trading_cooldown","malicious_address","honeypot_with_same_creator"];
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,Array.isArray(raw[k])?raw[k].slice(0,20):raw[k]]));
}

function bnbAssessment(raw, context) {
  const critical = [];
  const review = [];
  add(review,["is_honeypot","cannot_sell_all"].some(k=>!["0","1",0,1,false,true].includes(raw?.[k])),"sell_risk_data_unavailable","Honeypot or sell-restriction data is incomplete");
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

  const concentration = holderConcentration(raw, critical, review, context);
  const liquidity = liquidityAssessment(raw, review, context);
  return { critical, review, details: { buyTax, sellTax, holderCount: raw?.holder_count ?? null, ...concentration, ...liquidity } };
}

function solanaAssessment(raw, context) {
  const critical = [];
  const review = [];
  add(critical, String(raw?.default_account_state ?? "") === "2", "default_frozen", "New token accounts default to frozen");
  add(review, String(raw?.default_account_state ?? "") === "0", "default_uninitialized", "Token account state was reported uninitialized");
  add(review, !["0","1","2"].includes(String(raw?.default_account_state ?? "")), "default_state_unavailable", "Default token account state could not be checked");
  add(review, !["0","1",0,1,false,true].includes(raw?.non_transferable), "transferability_unavailable", "Transferability data is missing");
  add(review, ["freezable","mintable","balance_mutable_authority"].some(k => !["0","1",0,1,false,true].includes(raw?.[k]?.status)), "authority_risk_data_unavailable", "One or more token-authority risk checks are incomplete");
  add(critical, maliciousInAuthorities(raw?.creators), "malicious_creator", "A reported token creator is flagged malicious");
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

  const concentration = holderConcentration(raw, critical, review, context);
  const liquidity = liquidityAssessment(raw, review, context);
  return { critical, review, details: { transferFeeBps: currentFeeBps, trustedToken: raw?.trusted_token ?? null, holderCount: raw?.holder_count ?? null, ...concentration, ...liquidity } };
}

export function classifyProjectImportSecurity({ chainId, raw, tokenAddress = null, market = null, custody = [] }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) return { status:"review",provider:"goplus",criticalRisks:[],reviewRisks:[{code:"no_security_data",label:"No usable security data returned"}],details:{},providerRaw:null };
  const context={tokenAddress,market,custody};
  const assessment = Number(chainId) === 56 ? bnbAssessment(raw, context) : Number(chainId) === 101 ? solanaAssessment(raw, context) : null;
  if (!assessment) return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "unsupported_chain", label: "Security scanner does not support this chain" }], details: {} };
  const status = assessment.critical.length ? "blocked" : assessment.review.length ? "review" : "pass";
  return { status, provider: "goplus", criticalRisks: assessment.critical, reviewRisks: assessment.review, details: assessment.details, providerRaw: providerRawSnapshot(raw) };
}

export async function scanProjectImportSecurity({ chainId, tokenAddress, market = null, custody = [], fetchImpl = fetch }) {
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
    const raw = id === 56 ? result?.[token.toLowerCase()] || result?.[token] : result?.[token];
    if (!raw) {
      return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "no_security_data", label: "No security data returned for this token" }], details: {} };
    }
    return { ...classifyProjectImportSecurity({ chainId: id, raw, tokenAddress:token, market, custody }), checkedAt:new Date().toISOString() };
  } catch (error) {
    return { status: "review", provider: "goplus", criticalRisks: [], reviewRisks: [{ code: "scanner_unavailable", label: "Automatic scam-risk scan is unavailable" }], details: { error: String(error?.message || error) } };
  }
}

export function securityAllowsAutomaticImport(security) {
  return security?.status === "pass";
}
