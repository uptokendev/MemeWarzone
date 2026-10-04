// Finance status checks for the Command Center Overview and Reconciliation.
//
// Every status the dashboard shows comes from one of the checks below, built
// from reads the other finance pages already make (fee-routing balances and
// wiring, payouts coverage, the revenue lanes, the indexer LP read, the
// accounting tables). A check is real and says what to do; nothing is
// "disabled by design". Pure functions: the reads are passed in.
//
// check: { id, module, chainId, status: ok | attention | blocked, title, detail, action }
//   attention = something to look at or set; blocked = money can go wrong
//   (a fee path paying the deployer, a vault mismatch) or a source that the
//   page cannot read at all.

export const CHAIN_MODULES = Object.freeze(["inventory", "revenue", "rewards", "reconciliation"]);
export const ACCOUNTING_MODULES = Object.freeze(["costs", "taxReserves", "close", "distributions"]);
export const STATUS_MODULES = Object.freeze(["inventory", "revenue", "rewards", "costs", "taxReserves", "reconciliation", "close", "distributions"]);

const CHAIN_NAMES = Object.freeze({ 101: "Solana", 56: "BNB", 4663: "Robinhood" });
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function chainName(chainId) {
  return CHAIN_NAMES[Number(chainId)] || `Chain ${chainId}`;
}

export function monthName(month) {
  const [year, m] = String(month).split("-");
  return `${MONTH_NAMES[Number(m) - 1] || m} ${year}`;
}

function text(value, max = 400) {
  const s = String(value ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function makeCheck({ id, module, chainId = null, status, title, detail = null, action = null }) {
  return { id, module, chainId, status, title: text(title, 240), detail: detail ? text(detail, 600) : null, action: action ? text(action, 300) : null };
}

function shortAddress(address) {
  const s = String(address || "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// ---------------------------------------------------------------------------
// Wallet balances (module "inventory"): every fee destination on the
// fee-routing map that is not watch-only must have a balance that was read.

export function walletChecks(network, feeRouting, feeRoutingError = null) {
  const chainId = network.chainId;
  const name = chainName(chainId);
  if (!feeRouting) {
    return [makeCheck({ id: `wallets:${chainId}:read`, module: "inventory", chainId, status: "blocked", title: `${name}: wallet balances could not be read`, detail: feeRoutingError, action: "Reload in a minute. If it stays, check the API logs for [api/admin/finance]." })];
  }
  const checks = [];
  let read = 0;
  let tracked = 0;
  for (const d of feeRouting.destinations || []) {
    if ((d.flags || []).includes("watch") || d.ownership === "watch") continue;
    const balances = d.balances || [];
    if (balances.length === 0) continue;
    tracked += 1;
    const bad = balances.filter((b) => b.status !== "ok");
    if (bad.length === 0) { read += 1; continue; }
    const notSet = bad.find((b) => b.status === "not_configured");
    checks.push(makeCheck({
      id: `wallets:${chainId}:${d.id}`,
      module: "inventory",
      chainId,
      status: "attention",
      title: notSet ? `${name}: ${d.label} address is not set` : `${name}: ${d.label} balance could not be read`,
      detail: [...new Set(bad.map((b) => b.error).filter(Boolean))].join(" ") || null,
      action: notSet
        ? `Set the address on the API (Coolify, API service): ${notSet.error || "see the Fee Routing page"}`
        : "Usually a short RPC outage: reload in a minute. If it stays, check the RPC URL for this chain on the API.",
    }));
  }
  if (checks.length === 0) {
    checks.push(makeCheck({ id: `wallets:${chainId}:ok`, module: "inventory", chainId, status: "ok", title: `${name}: all ${tracked} fee wallets read`, detail: `Balances of ${read} wallets and vaults on the Fee Routing page.` }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Revenue: the database lanes, the UP vote check, and the indexer's LP read
// (hidden test coins are counted apart and never raise a warning).

export function lpReadSummary(payload, hidden = [], { solana = false } = {}) {
  const skip = new Set(hidden.map((a) => (solana ? String(a) : String(a).toLowerCase())));
  const errors = [];
  const testCoinErrors = [];
  let registered = 0;
  for (const item of payload?.items || []) {
    const campaign = typeof item?.campaignAddress === "string" ? item.campaignAddress.trim() : "";
    const isTest = campaign && skip.has(solana ? campaign : campaign.toLowerCase());
    if (item?.fees?.registered === true && !isTest) registered += 1;
    const error = typeof item?.fees?.error === "string" ? item.fees.error.trim() : "";
    if (!error) continue;
    (isTest ? testCoinErrors : errors).push({ campaign, symbol: typeof item?.symbol === "string" ? item.symbol : "", error });
  }
  return { itemCount: (payload?.items || []).length, registered, errors, testCoinErrors };
}

export function revenueChecks(network, { revenueError = null, notes = [], lp = null, lpError = null } = {}) {
  const chainId = network.chainId;
  const name = chainName(chainId);
  const checks = [];
  if (revenueError) {
    checks.push(makeCheck({ id: `revenue:${chainId}:read`, module: "revenue", chainId, status: "blocked", title: `${name}: revenue could not be read from the database`, detail: revenueError, action: "Check the API logs for [api/admin/finance]." }));
  }
  for (const [index, note] of notes.entries()) {
    checks.push(makeCheck({ id: `revenue:${chainId}:note:${index}`, module: "revenue", chainId, status: "attention", title: note }));
  }
  if (lpError) {
    const opsKey = /ops key/i.test(lpError);
    checks.push(makeCheck({
      id: `revenue:${chainId}:lp-read`, module: "revenue", chainId, status: "attention",
      title: `${name}: LP fee positions could not be read from the indexer`,
      detail: lpError,
      action: opsKey ? "Set DASHBOARD_OPS_KEY on the API to the indexer's ops key (the indexer only serves mainnet LP reads with it)." : "Check that the indexer is up and INDEXER_API_BASE_URL on the API points to it.",
    }));
  } else if (lp) {
    for (const item of lp.errors) {
      checks.push(makeCheck({
        id: `revenue:${chainId}:lp:${item.campaign || item.symbol}`, module: "revenue", chainId, status: "attention",
        title: `${name}: LP position of ${item.symbol || shortAddress(item.campaign)} could not be read`,
        detail: item.error,
        action: "Its LP fees are not counted until the position reads again. Check the coin on the LP Harvest page.",
      }));
    }
    if (lp.testCoinErrors.length > 0) {
      checks.push(makeCheck({
        id: `revenue:${chainId}:lp-test-coins`, module: "revenue", chainId, status: "ok",
        title: `${name}: ${lp.testCoinErrors.length} test coin${lp.testCoinErrors.length === 1 ? "" : "s"} with an unreadable LP position ignored`,
        detail: "Test coins are hidden from public listings and left out of revenue, so their LP errors do not count.",
      }));
    }
  }
  if (!checks.some((c) => c.status !== "ok")) {
    checks.unshift(makeCheck({ id: `revenue:${chainId}:ok`, module: "revenue", chainId, status: "ok", title: `${name}: every revenue source read`, detail: lp ? `${lp.registered} graduated coin${lp.registered === 1 ? "" : "s"} with LP fee positions.` : null }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Rewards: what the payout pages say is owed against the vault that pays it.

function payoutCoverageCheck(network, type) {
  const chainId = network.chainId;
  const name = chainName(chainId);
  const cov = type?.coverage || {};
  const asset = type?.asset || network.asset;
  if (cov.status === "short") {
    return makeCheck({
      id: `rewards:${chainId}:${type.id}`, module: "rewards", chainId, status: "attention",
      title: `${name}: ${type.label || type.id} vault is short by ${cov.shortByAmount} ${asset}`,
      detail: `Owed ${cov.owedAmount} ${asset}, the paying vault holds ${cov.vaultAmount ?? "an unknown amount"}. ${cov.note || ""}`.trim(),
      action: "See Payouts for which vault pays this and top it up or fix the vault address.",
    });
  }
  if (cov.status === "unknown") {
    return makeCheck({
      id: `rewards:${chainId}:${type.id}`, module: "rewards", chainId, status: "attention",
      title: `${name}: ${type.label || type.id} vault balance could not be read`,
      detail: cov.note || null,
      action: "Reload in a minute; the coverage check needs the vault balance.",
    });
  }
  return null;
}

export function rewardChecks(network, { payouts = null, payoutsError = null } = {}) {
  const chainId = network.chainId;
  const name = chainName(chainId);
  if (!payouts) {
    return [makeCheck({ id: `rewards:${chainId}:read`, module: "rewards", chainId, status: "attention", title: `${name}: payouts could not be checked`, detail: payoutsError, action: "Reload in a minute. If it stays, check the API logs for [api/admin/finance/payouts]." })];
  }
  const checks = (payouts.types || []).map((type) => payoutCoverageCheck(network, type)).filter(Boolean);
  if (checks.length === 0) {
    const owing = (payouts.types || []).filter((t) => t.coverage?.status === "covered").length;
    checks.push(makeCheck({ id: `rewards:${chainId}:ok`, module: "rewards", chainId, status: "ok", title: `${name}: every vault holds what it owes`, detail: owing ? `${owing} payout type${owing === 1 ? "" : "s"} with money owed, all covered.` : "Nothing is owed right now." }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Reconciliation: live wiring against the deployment records, fee-routing
// alerts and payout warnings.

// Already shown by another check: a wiring mismatch (wiring checks) and a
// short vault (rewards checks).
const DUPLICATE_ALERT = /reads .* on chain; the deployment record says|the vault is short by/;

/** First sentence as the title, the rest as the detail. */
export function splitSentence(message) {
  const full = String(message || "").trim();
  const m = full.match(/^(.{20,200}?[.!?])\s+(.+)$/s);
  if (m) return { title: m[1], detail: m[2] };
  if (full.length <= 200) return { title: full, detail: null };
  // One long sentence: a short title cut at a word, the whole message as the detail.
  const cut = full.slice(0, 180);
  return { title: `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120))}…`, detail: full };
}

export function reconciliationChecks(network, { feeRouting = null, payouts = null } = {}) {
  const chainId = network.chainId;
  const name = chainName(chainId);
  const checks = [];
  if (!feeRouting) {
    checks.push(makeCheck({ id: `recon:${chainId}:read`, module: "reconciliation", chainId, status: "blocked", title: `${name}: the fee routing map could not be read`, action: "Reload in a minute. If it stays, check the API logs." }));
    return checks;
  }
  let matched = 0;
  for (const w of feeRouting.wiring || []) {
    if (w.status === "match") { matched += 1; continue; }
    checks.push(makeCheck({
      id: `recon:${chainId}:wiring:${w.id}`, module: "reconciliation", chainId, status: "attention",
      title: w.status === "mismatch" ? `${name}: ${w.label} reads ${w.actual} on chain, the record says ${w.expected}` : `${name}: ${w.label} could not be read`,
      detail: w.error || w.source || null,
      action: w.status === "mismatch" ? "If the change was intended, update the deployment record; if not, a multisig must point it back." : "Reload in a minute; this is a live chain read.",
    }));
  }
  const seen = new Set();
  const pushAlert = (alert, source) => {
    const level = String(alert?.level || "info");
    if (level === "info") return;
    const message = String(alert?.message || "").trim();
    if (!message || seen.has(message) || DUPLICATE_ALERT.test(message)) return;
    seen.add(message);
    const { title, detail } = splitSentence(message);
    checks.push(makeCheck({
      id: `recon:${chainId}:${source}:${seen.size}`, module: "reconciliation", chainId,
      status: level === "critical" ? "blocked" : "attention",
      title: `${name}: ${title}`,
      detail,
      action: source === "payouts" ? "Details on the Payouts page." : "Details on the Fee Routing page.",
    }));
  };
  for (const alert of feeRouting.alerts || []) pushAlert(alert, "fees");
  for (const alert of payouts?.warnings || []) pushAlert(alert, "payouts");
  for (const type of payouts?.types || []) for (const alert of type.warnings || []) pushAlert(alert, "payouts");
  if (checks.length === 0) {
    checks.push(makeCheck({ id: `recon:${chainId}:ok`, module: "reconciliation", chainId, status: "ok", title: `${name}: wiring matches the deployment records`, detail: `${matched} live pointer${matched === 1 ? "" : "s"} checked; no fee-routing or payout warnings.` }));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Accounting (one set for all chains).

export function accountingChecks({ tablesMissing = false, migration = null, costCount = 0, taxIsDefault = true, openMonths = [], activeMonths = 0, distribution = null, readError = null } = {}) {
  if (tablesMissing || readError) {
    const detail = tablesMissing ? `Apply ${migration || "the finance accounting migration"} to the database.` : readError;
    return ACCOUNTING_MODULES.map((module) => makeCheck({ id: `accounting:${module}:read`, module, status: "blocked", title: tablesMissing ? "The accounting tables are not installed" : "The accounting tables could not be read", detail, action: tablesMissing ? detail : "Check the API logs for [api/admin/finance accounting]." }));
  }
  const checks = [];
  checks.push(costCount > 0
    ? makeCheck({ id: "accounting:costs", module: "costs", status: "ok", title: `${costCount} cost${costCount === 1 ? "" : "s"} entered` })
    : makeCheck({ id: "accounting:costs", module: "costs", status: "attention", title: "No costs are entered yet", detail: "Profit, the tax reserve and the distributable amount assume zero costs until costs are added.", action: "Add servers, RPC, salaries and other costs on the Costs page (needs finance.manage)." }));
  checks.push(taxIsDefault
    ? makeCheck({ id: "accounting:tax", module: "taxReserves", status: "attention", title: "Researched Dutch tax rules in use", detail: "Corporate tax 19% up to EUR 200,000 and 25.8% above (2025 and 2026), dividend tax exemptions and VAT per revenue lane, each with its source, checked 2026-10-05. The VAT rules are low confidence and marked needs confirmation.", action: "Check the rules marked needs confirmation on Tax & Reserves; change any value there if needed (needs finance.manage)." })
    : makeCheck({ id: "accounting:tax", module: "taxReserves", status: "ok", title: "Tax brackets saved" }));
  if (openMonths.length > 0) {
    checks.push(makeCheck({ id: "accounting:close", module: "close", status: "attention", title: `Not closed yet: ${openMonths.map(monthName).join(", ")}`, detail: "A closed month freezes its revenue, costs, prices and tax reserve.", action: `Close ${monthName(openMonths[0])} first on the Close page (needs finance.manage).` }));
  } else {
    checks.push(makeCheck({ id: "accounting:close", module: "close", status: "ok", title: activeMonths > 0 ? "Every past month with activity is closed" : "No past month to close yet" }));
  }
  const shares = distribution?.shares || [];
  const missing = shares.map((s) => ({ name: s.name, gaps: [!s.evmAddress && "EVM", !s.solanaAddress && "Solana"].filter(Boolean) })).filter((s) => s.gaps.length);
  if (missing.length > 0) {
    checks.push(makeCheck({ id: "accounting:distributions", module: "distributions", status: "attention", title: "Payout addresses missing", detail: missing.map((s) => `${s.name}: ${s.gaps.join(" and ")}`).join("; "), action: "Add them on Distributions, Shareholders and payout addresses (needs finance.manage). No proposal file can be built until every shareholder has an address." }));
  } else if (distribution?.isDefault) {
    checks.push(makeCheck({ id: "accounting:distributions", module: "distributions", status: "attention", title: "Shareholder settings are not saved yet", action: "Check and save them on Distributions (needs finance.manage)." }));
  } else {
    checks.push(makeCheck({ id: "accounting:distributions", module: "distributions", status: "ok", title: "Every shareholder has payout addresses" }));
  }
  return checks;
}

// ---------------------------------------------------------------------------

/** One module tile per key: worst status of its checks, blockers / warnings counted. */
export function modulesFromChecks(checks, keys, lastUpdatedAt) {
  return keys.map((key) => {
    const own = checks.filter((c) => c.module === key);
    const blockerCount = own.filter((c) => c.status === "blocked").length;
    const warningCount = own.filter((c) => c.status === "attention").length;
    return { key, status: blockerCount ? "blocked" : warningCount ? "attention" : "ready", blockerCount, warningCount, ...(lastUpdatedAt ? { lastUpdatedAt } : {}) };
  });
}

/** Past months (before `currentMonth`) with activity that are not closed, oldest first. */
export function openPastMonths(activeMonths, closedMonths, currentMonth) {
  const closed = new Set(closedMonths);
  return [...new Set(activeMonths)].filter((m) => m < currentMonth && !closed.has(m)).sort();
}
