// Treasury: the BV's accounts and the movements between them, and what the
// movements do to the books. Pure functions; the handler
// (admin/financeAccounting.js) reads and writes the tables.
//
// Accounts: multisig and operator wallet per chain, exchange accounts, bank
// accounts (masked IBAN only), other wallets. Each has a main currency.
//
// Movements (finance_treasury_movements): an out leg leaves from_account, an
// in leg arrives at to_account, a fee is paid by from_account (or by
// to_account when there is no from). Kinds:
//   opening_balance     what an account held on a date, with its EUR cost
//   transfer_internal   between our own accounts (same asset; not a sale)
//   conversion          crypto -> fiat or crypto -> crypto (a sale)
//   bank_payment        a cost paid from the bank (linked to finance_costs)
//   bank_receipt        fiat received (with a revenue lane when it is revenue)
//   owner_contribution  money put in by a shareholder (equity, not profit)
//   owner_loan          a loan from a shareholder (to = received, from = repaid)
//   fee                 an exchange or network fee on its own
//   crypto_payment      a cost paid in crypto from one of our wallets (linked
//                       to finance_costs; e.g. a support buy booked as marketing)
//
// Tokens: besides the core assets (EUR, USD, SOL, BNB, ETH, USDC, USDT) one leg
// of a movement may be any other token (SPL or ERC-20, e.g. K88), kept as its
// symbol plus its mint / contract address (assetAddress). Its lots are kept per
// token address, so two coins with the same symbol never mix.
//
// Gains and losses: every non-EUR asset is held in lots (per asset, across all
// accounts). A lot comes in with its EUR cost: fee revenue at its EUR value on
// the day it was earned (the revenue lanes, event-hour price, ECB rate of the
// day), an opening balance at the cost entered, the in leg of a conversion at
// the conversion's EUR value. A disposal (conversion out leg, a fee paid in
// crypto, a crypto cost or crypto payment, a distribution paid in crypto, an
// owner loan repaid in crypto) takes units out by the rule's method (FIFO by default):
//   realized gain = proceeds EUR - cost EUR of the units taken
// Units disposed beyond the known lots have no cost on record: they are counted
// at their proceeds (no gain, no loss) and reported, so missing opening balances
// never invent a gain.
//
// Profit effect per day (EUR) = realized gains - fees + revenue received in
// fiat (bank receipts with a revenue lane) - the VAT in it. A bank payment
// linked to a cost is not a cost again (the cost is already in finance_costs);
// it only moves cash. A crypto payment linked to a cost is the same, plus the
// realized gain or loss on the crypto spent (cost EUR = its market value at the
// time, the units leave at their FIFO cost); the cost's own crypto disposal is
// then not counted a second time. Transfers, opening balances and owner money never touch
// profit.

import { FinanceInputError, isValidDate, round2, roundUsd } from "./financeAccountingCosts.js";
import { priceAssetFor } from "./financePrices.js";
import { VAT_LANES, vatFraction, vatLaneOf } from "./financeTaxRules.js";

export const ACCOUNT_KINDS = Object.freeze(["multisig", "operator_wallet", "exchange", "bank", "wallet_other"]);
export const ACCOUNT_KIND_LABELS = Object.freeze({ multisig: "Multisig", operator_wallet: "Operator wallet (buffer)", exchange: "Exchange account", bank: "Bank account", wallet_other: "Other wallet" });
export const TREASURY_ASSETS = Object.freeze(["EUR", "USD", "SOL", "BNB", "ETH", "USDC", "USDT"]);
export const FIAT = Object.freeze(["EUR", "USD"]);
export const MOVEMENT_KINDS = Object.freeze(["opening_balance", "transfer_internal", "conversion", "bank_payment", "bank_receipt", "owner_contribution", "owner_loan", "fee", "crypto_payment"]);
export const MOVEMENT_KIND_LABELS = Object.freeze({
  opening_balance: "Opening balance",
  transfer_internal: "Transfer between our accounts",
  conversion: "Conversion (sale)",
  bank_payment: "Cost paid from the bank",
  bank_receipt: "Money received in the bank",
  owner_contribution: "Owner contribution",
  owner_loan: "Owner loan",
  fee: "Fee",
  crypto_payment: "Cost paid in crypto",
});
/** A token leg: a symbol outside the core assets, with its mint / contract address. */
export const TOKEN_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._$-]{0,19}$/;
export const WALLET_KINDS = Object.freeze(["multisig", "operator_wallet", "wallet_other"]);
export const CHAINS = Object.freeze({ 101: "Solana", 56: "BNB Chain", 4663: "Robinhood Chain" });
export const LOT_METHODS = Object.freeze(["fifo", "lifo", "average"]);

const AMOUNT = /^\d{1,20}(\.\d{1,18})?$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const MIN_DATE = "2024-01-01";
const EPS = 1e-12;
const NATIVE_DECIMALS = Object.freeze({ SOL: 9, BNB: 18, ETH: 18 });

// ------------------------------------------------------------------ small helpers

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function text(value, field, { max, min = 0 } = {}) {
  const out = value == null ? "" : String(value).trim();
  if (out.length < min) throw new FinanceInputError(`${field} is required.`, field);
  if (out.length > max) throw new FinanceInputError(`${field} is longer than ${max} characters.`, field);
  return out;
}

function enumOf(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) throw new FinanceInputError(`${field} must be one of: ${allowed.join(", ")}.`, field);
  return value;
}

function amountOf(value, field) {
  const out = String(value ?? "").trim();
  if (!AMOUNT.test(out) || !(Number(out) > 0)) throw new FinanceInputError(`${field} must be a positive number (up to 18 decimals).`, field);
  return out;
}

function eurOf(value, field) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new FinanceInputError(`${field} must be an amount in EUR of 0 or more.`, field);
  return round2(n);
}

function idOf(value, field) {
  if (value == null || value === "") return null;
  const out = String(value);
  if (!/^[1-9]\d{0,17}$/.test(out)) throw new FinanceInputError(`${field} must be an id.`, field);
  return out;
}

export function isCrypto(asset) {
  return Boolean(asset) && asset !== "EUR";
}

export function isCoreAsset(asset) {
  return TREASURY_ASSETS.includes(asset);
}

/** "K88@4VPt..." for a token leg, the asset itself otherwise: the key cash and lots are kept under. */
export function assetKey(leg) {
  if (!leg) return null;
  return leg.address ? `${leg.asset}@${leg.address}` : leg.asset;
}

/** Splits an assetKey back into symbol and address. */
export function splitAssetKey(key) {
  const text = String(key || "");
  const at = text.indexOf("@");
  return at < 0 ? { asset: text, address: null } : { asset: text.slice(0, at), address: text.slice(at + 1) };
}

/** The lot key of a leg: a token by its address, a core asset as lotAsset(). */
export function legLot(leg) {
  if (!leg) return null;
  return leg.address ? assetKey(leg) : lotAsset(leg.asset);
}

/** The asset the lots are kept in: WSOL counts as SOL and so on; EUR has no lots. */
export function lotAsset(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s === "EUR") return null;
  if (s === "USDC" || s === "USDT" || s === "USD") return s;
  const p = priceAssetFor(s);
  return p && p !== "USD" ? p : null;
}

/** "NL91ABNA0417164300" -> "NL** **** **** 4300". The full IBAN is never kept. */
export function maskIban(raw) {
  const iban = String(raw || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new FinanceInputError("iban must be an IBAN (country code, 2 check digits, account).", "iban");
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of rearranged) rest = (rest * 10 + Number(digit)) % 97;
  if (rest !== 1) throw new FinanceInputError("That IBAN's check digits do not match.", "iban");
  const groups = Math.max(1, Math.ceil((iban.length - 8) / 4));
  return `${iban.slice(0, 2)}**${" ****".repeat(groups)} ${iban.slice(-4)}`;
}

// ------------------------------------------------------------------ accounts

const ACCOUNT_FIELDS = ["name", "kind", "chainId", "address", "iban", "currency", "note", "archived"];

/**
 * Validates an account create (partial = false) or update (partial = true).
 * The address of a wallet and its chain cannot change after creation.
 */
export function validateAccountInput(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the account as a JSON object.");
  const unknown = Object.keys(body).filter((k) => !ACCOUNT_FIELDS.includes(k));
  if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
  const out = {};
  if (!partial || has(body, "name")) out.name = text(body.name, "name", { max: 80, min: 1 });
  if (!partial || has(body, "currency")) out.currency = enumOf(body.currency ?? (partial ? undefined : "EUR"), TREASURY_ASSETS, "currency");
  if (!partial || has(body, "note")) out.note = text(body.note, "note", { max: 500 });
  if (partial) {
    for (const key of ["kind", "chainId", "address"]) if (has(body, key)) throw new FinanceInputError(`${key} cannot change; archive the account and add a new one.`, key);
    if (has(body, "iban")) out.ibanMasked = body.iban == null || body.iban === "" ? null : maskIban(body.iban);
    if (has(body, "archived")) out.archived = body.archived === true;
    if (!Object.keys(out).length) throw new FinanceInputError("Nothing to change.");
    return out;
  }
  out.kind = enumOf(body.kind, ACCOUNT_KINDS, "kind");
  const wallet = out.kind === "multisig" || out.kind === "operator_wallet" || out.kind === "wallet_other";
  out.chainId = null;
  out.address = null;
  out.ibanMasked = null;
  if (wallet) {
    const chainId = Number(body.chainId);
    if (!CHAINS[chainId]) throw new FinanceInputError("chainId must be 101 (Solana), 56 (BNB Chain) or 4663 (Robinhood Chain).", "chainId");
    const address = String(body.address || "").trim();
    if (chainId === 101 ? !SOLANA_ADDRESS.test(address) : !EVM_ADDRESS.test(address)) throw new FinanceInputError(`That is not a ${CHAINS[chainId]} address.`, "address");
    out.chainId = chainId;
    out.address = address;
  } else {
    if (body.chainId != null && body.chainId !== "") throw new FinanceInputError("chainId is only for wallets.", "chainId");
    if (body.address != null && body.address !== "") throw new FinanceInputError("address is only for wallets.", "address");
  }
  if (out.kind === "bank") out.ibanMasked = body.iban == null || body.iban === "" ? null : maskIban(body.iban);
  else if (body.iban != null && body.iban !== "") throw new FinanceInputError("iban is only for bank accounts.", "iban");
  return out;
}

// ------------------------------------------------------------------ movements

const MOVEMENT_FIELDS = ["occurredAt", "kind", "fromAccountId", "toAccountId", "assetOut", "amountOut", "assetIn", "amountIn", "assetAddress", "valueEur", "feeAsset", "feeAmount", "feeEur", "costId", "revenueLane", "txHash", "reference", "note"];

function occurredAtOf(value, nowMs) {
  const raw = String(value ?? "").trim();
  let iso;
  if (isValidDate(raw)) iso = `${raw}T12:00:00.000Z`;
  else {
    const ms = Date.parse(raw);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(ms)) throw new FinanceInputError("occurredAt must be a date (YYYY-MM-DD) or a date and time (ISO 8601).", "occurredAt");
    iso = new Date(ms).toISOString();
  }
  if (iso.slice(0, 10) < MIN_DATE) throw new FinanceInputError(`occurredAt is before ${MIN_DATE}.`, "occurredAt");
  if (Date.parse(iso) > nowMs + 60_000) throw new FinanceInputError("occurredAt is in the future.", "occurredAt");
  return iso;
}

function legOf(body, assetField, amountField, { tokenAddress = null } = {}) {
  const asset = body[assetField];
  const amount = body[amountField];
  const none = (v) => v == null || v === "";
  if (none(asset) && none(amount)) return null;
  if (none(asset) || none(amount)) throw new FinanceInputError(`${assetField} and ${amountField} go together.`, none(asset) ? assetField : amountField);
  const upper = String(asset).trim().toUpperCase();
  if (TREASURY_ASSETS.includes(upper)) return { asset: upper, amount: amountOf(amount, amountField) };
  if (!tokenAddress) throw new FinanceInputError(`${assetField} must be one of: ${TREASURY_ASSETS.join(", ")}, or a token symbol with its address (assetAddress).`, assetField);
  if (!TOKEN_SYMBOL.test(upper)) throw new FinanceInputError(`${assetField}: a token symbol has letters, digits and . _ $ - only (up to 20).`, assetField);
  return { asset: upper, amount: amountOf(amount, amountField), address: tokenAddress };
}

function tokenAddressOf(value) {
  if (value == null || value === "") return null;
  const out = String(value).trim();
  if (!SOLANA_ADDRESS.test(out) && !EVM_ADDRESS.test(out)) throw new FinanceInputError("assetAddress must be a Solana mint or an EVM token contract address.", "assetAddress");
  return out;
}

/**
 * Validates the movement as typed (shape and the rules of its kind). The
 * accounts' kinds are checked by checkMovementAccounts once they are loaded.
 * @returns normalized movement (valueEur / feeEur may still be null: priced by the handler)
 */
export function validateMovementInput(body, { nowMs = Date.now() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the movement as a JSON object.");
  const unknown = Object.keys(body).filter((k) => !MOVEMENT_FIELDS.includes(k));
  if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
  const kind = enumOf(body.kind, MOVEMENT_KINDS, "kind");
  const tokenAddress = tokenAddressOf(body.assetAddress);
  const out = {
    occurredAt: occurredAtOf(body.occurredAt, nowMs),
    kind,
    fromAccountId: idOf(body.fromAccountId, "fromAccountId"),
    toAccountId: idOf(body.toAccountId, "toAccountId"),
    out: legOf(body, "assetOut", "amountOut", { tokenAddress }),
    in: legOf(body, "assetIn", "amountIn", { tokenAddress }),
    valueEur: eurOf(body.valueEur, "valueEur"),
    fee: legOf(body, "feeAsset", "feeAmount"),
    feeEur: eurOf(body.feeEur, "feeEur"),
    costId: idOf(body.costId, "costId"),
    revenueLane: body.revenueLane == null || body.revenueLane === "" ? null : enumOf(body.revenueLane, VAT_LANES, "revenueLane"),
    txHash: body.txHash == null || body.txHash === "" ? null : String(body.txHash).trim(),
    reference: text(body.reference, "reference", { max: 120 }),
    note: text(body.note, "note", { max: 1000 }),
  };
  const tokenLegs = [out.out, out.in].filter((l) => l?.address).length;
  if (tokenAddress && tokenLegs !== 1) throw new FinanceInputError("assetAddress is the address of the one token leg: exactly one of assetOut / assetIn is that token.", "assetAddress");
  if (out.txHash && !SOLANA_TX.test(out.txHash) && !EVM_TX.test(out.txHash)) throw new FinanceInputError("txHash must be a Solana signature or an EVM transaction hash.", "txHash");
  if (out.feeEur != null && !out.fee) throw new FinanceInputError("feeEur needs feeAsset and feeAmount.", "feeEur");
  const need = (cond, message, field) => { if (!cond) throw new FinanceInputError(message, field); };
  const from = out.fromAccountId;
  const to = out.toAccountId;
  switch (kind) {
    case "opening_balance":
      need(to && !from, "An opening balance has a to account only.", "toAccountId");
      need(out.in && !out.out, "An opening balance has an in leg (assetIn, amountIn) only.", "assetIn");
      need(!out.fee, "An opening balance has no fee.", "feeAsset");
      break;
    case "transfer_internal":
      need(from && to && from !== to, "A transfer needs two different accounts.", "toAccountId");
      need(out.out && out.in, "A transfer has an out and an in leg.", "assetIn");
      need(out.out.asset === out.in.asset, "A transfer keeps the asset; a change of asset is a conversion.", "assetIn");
      need(Number(out.in.amount) <= Number(out.out.amount), "A transfer cannot arrive with more than was sent.", "amountIn");
      break;
    case "conversion":
      need(from && to, "A conversion needs the account sold from and the account received in (may be the same).", "fromAccountId");
      need(out.out && out.in, "A conversion has an out and an in leg.", "assetIn");
      need(out.out.asset !== out.in.asset, "A conversion changes the asset.", "assetIn");
      break;
    case "bank_payment":
      need(from && !to, "A bank payment has a from account only.", "fromAccountId");
      need(out.out && !out.in, "A bank payment has an out leg only.", "assetOut");
      need(FIAT.includes(out.out.asset), "A bank payment is in EUR or USD.", "assetOut");
      break;
    case "bank_receipt":
      need(to && !from, "A bank receipt has a to account only.", "toAccountId");
      need(out.in && !out.out, "A bank receipt has an in leg only.", "assetIn");
      need(FIAT.includes(out.in.asset), "A bank receipt is in EUR or USD.", "assetIn");
      break;
    case "owner_contribution":
      need(to && !from, "An owner contribution has a to account only.", "toAccountId");
      need(out.in && !out.out, "An owner contribution has an in leg only.", "assetIn");
      break;
    case "owner_loan":
      need(Boolean(from) !== Boolean(to), "An owner loan has a to account (received) or a from account (repaid), not both.", "toAccountId");
      need(to ? out.in && !out.out : out.out && !out.in, to ? "A loan received has an in leg only." : "A loan repaid has an out leg only.", to ? "assetIn" : "assetOut");
      break;
    case "fee":
      need(from && !to, "A fee has a from account only.", "fromAccountId");
      need(out.out && !out.in, "A fee is the out leg (assetOut, amountOut).", "assetOut");
      need(!out.fee, "A fee movement is the fee itself; leave feeAsset empty.", "feeAsset");
      need(!out.out.address, "A fee is paid in a core asset.", "assetOut");
      break;
    case "crypto_payment":
      need(from && !to, "A crypto payment has a from account only (the wallet it left).", "fromAccountId");
      need(out.out && !out.in, "A crypto payment has an out leg only (assetOut, amountOut).", "assetOut");
      need(!FIAT.includes(out.out.asset), "A crypto payment is in crypto; a cost paid in EUR or USD is a bank payment.", "assetOut");
      need(out.costId, "A crypto payment pays a cost: link it (costId).", "costId");
      break;
    default:
      break;
  }
  if (out.costId && kind !== "bank_payment" && kind !== "crypto_payment") throw new FinanceInputError("costId is only for a bank payment or a crypto payment.", "costId");
  for (const [leg, field] of [[out.out, "assetOut"], [out.in, "assetIn"]]) {
    if (leg?.address && (kind === "bank_payment" || kind === "bank_receipt")) throw new FinanceInputError("A bank movement is in EUR or USD.", field);
  }
  if (out.revenueLane && kind !== "bank_receipt") throw new FinanceInputError("revenueLane is only for a bank receipt.", "revenueLane");
  return out;
}

/** Checks the accounts a movement uses: they exist, are live, and fit the kind. */
export function checkMovementAccounts(m, accountsById, { allowArchived = false } = {}) {
  const pick = (id, field) => {
    if (!id) return null;
    const a = accountsById.get(String(id));
    if (!a) throw new FinanceInputError(`${field}: no such account.`, field);
    if (a.archivedAt && !allowArchived) throw new FinanceInputError(`${field}: ${a.name} is archived.`, field);
    return a;
  };
  const from = pick(m.fromAccountId, "fromAccountId");
  const to = pick(m.toAccountId, "toAccountId");
  if (m.kind === "bank_payment" && from.kind !== "bank") throw new FinanceInputError("A bank payment is paid from a bank account.", "fromAccountId");
  if (m.kind === "bank_receipt" && to.kind !== "bank") throw new FinanceInputError("A bank receipt arrives in a bank account.", "toAccountId");
  if (m.kind === "crypto_payment" && !WALLET_KINDS.includes(from.kind)) throw new FinanceInputError("A crypto payment leaves one of our wallets (multisig, operator or other wallet).", "fromAccountId");
  const onChain = (a) => a && WALLET_KINDS.includes(a.kind);
  for (const [a, leg, field] of [[from, m.out, "assetOut"], [to, m.in, "assetIn"]]) {
    if (onChain(a) && leg && FIAT.includes(leg.asset)) throw new FinanceInputError(`${a.name} is a wallet; it cannot hold ${leg.asset}.`, field);
    if (a && leg?.address) {
      if (a.kind === "bank") throw new FinanceInputError(`${a.name} is a bank account; it cannot hold ${leg.asset}.`, field);
      if (a.chainId != null && (a.chainId === 101) !== SOLANA_ADDRESS.test(leg.address)) throw new FinanceInputError(`${leg.asset}: that address is not a ${CHAINS[a.chainId]} token, but ${a.name} is on ${CHAINS[a.chainId]}.`, "assetAddress");
    }
  }
  return { from, to };
}

// ------------------------------------------------------------------ valuation

/**
 * EUR value of an amount of an asset at a time, with its source. EUR: itself.
 * USD: at the ECB rate of the day. USDC/USDT: $1 at the ECB rate. SOL/BNB/ETH:
 * Binance 1h close of that hour (spot when the hour has no close yet).
 */
export async function valueInEur({ asset, amount, at, prices, fx, address = null, chainId = null, tokenPrice = null }) {
  const n = Number(amount);
  if (asset === "EUR") return { eur: round2(n), usdPerEur: null, priceUsd: null, source: "EUR amount" };
  const day = String(at).slice(0, 10);
  const rate = await fx.rate(day).catch(() => null);
  if (!rate?.usdPerEur) throw new FinanceInputError(`No USD/EUR rate for ${day}. Enter the EUR value by hand (valueEur).`, "valueEur");
  let priceUsd;
  let priceSource;
  if (address) {
    // A token: the curve price of the last trade before that time (times the
    // native coin's hourly close), or the market price when it is now.
    const p = typeof tokenPrice === "function" ? await tokenPrice({ chainId, address, at }).catch(() => null) : null;
    if (!p?.priceUsd) throw new FinanceInputError(`No ${asset} price for ${day} in our market data. Enter the EUR value by hand (valueEur).`, "valueEur");
    priceUsd = p.priceUsd;
    priceSource = p.source;
  } else if (asset === "USD" || asset === "USDC" || asset === "USDT") {
    priceUsd = 1;
    priceSource = asset === "USD" ? "USD amount" : `${asset} counted as $1`;
  } else {
    const hour = Math.floor(Date.parse(at) / 3_600_000) * 3_600_000;
    const closes = typeof prices.hourly === "function" ? await prices.hourly(asset, [hour]).catch(() => new Map()) : new Map();
    if (closes.get(hour)) {
      priceUsd = closes.get(hour);
      priceSource = `Binance ${asset}USDT 1h close ${new Date(hour).toISOString().slice(0, 13)}:00 UTC`;
    } else {
      const spot = await prices.spot(asset).catch(() => null);
      if (!spot?.priceUsd) throw new FinanceInputError(`No ${asset} price for ${day}. Enter the EUR value by hand (valueEur).`, "valueEur");
      priceUsd = spot.priceUsd;
      priceSource = `${spot.source} (no close for that hour yet)`;
    }
  }
  return { eur: round2((n * priceUsd) / rate.usdPerEur), usdPerEur: rate.usdPerEur, priceUsd, source: `${priceSource}; ${rate.source}` };
}

/**
 * The leg that sets a movement's EUR value: the in leg of a conversion (the
 * proceeds), but the out leg when the in leg is a token (a buy of a token is
 * valued at what was paid for it); else the out leg, else the in leg.
 */
export function valuationLeg(m) {
  if (m.kind === "conversion") {
    if (m.in.asset === "EUR") return m.in;
    if (m.out.asset === "EUR") return m.out;
    return m.in.address && !m.out.address ? m.out : m.in;
  }
  return m.out || m.in;
}

/** The chain a token leg lives on: the chain of the account it leaves or arrives in. */
export function tokenChainOf(m, accountsById) {
  const leg = [m.out, m.in].find((l) => l?.address);
  if (!leg) return null;
  const account = accountsById.get(String(leg === m.out ? m.fromAccountId : m.toAccountId));
  if (account?.chainId) return account.chainId;
  return SOLANA_ADDRESS.test(leg.address) ? 101 : null;
}

// ------------------------------------------------------------------ cash per account

/**
 * Balance per account and asset from the movements (and tax items paid from or
 * refunded to an account): sum of in legs - out legs - fees paid.
 * @returns Map accountId -> Map asset -> number
 */
export function cashPerAccount(movements, taxItems = []) {
  const out = new Map();
  const add = (accountId, asset, delta) => {
    if (!accountId || !asset || !delta) return;
    const id = String(accountId);
    const per = out.get(id) || new Map();
    per.set(asset, (per.get(asset) || 0) + delta);
    out.set(id, per);
  };
  for (const m of movements) {
    if (m.deletedAt) continue;
    if (m.out) add(m.fromAccountId, assetKey(m.out), -Number(m.out.amount));
    if (m.in) add(m.toAccountId, assetKey(m.in), Number(m.in.amount));
    if (m.fee) add(m.fromAccountId || m.toAccountId, m.fee.asset, -Number(m.fee.amount));
  }
  for (const t of taxItems) {
    if (t.deletedAt || !t.accountId) continue;
    if (t.kind === "payment") add(t.accountId, "EUR", -Number(t.amountEur));
    if (t.kind === "refund") add(t.accountId, "EUR", Number(t.amountEur));
  }
  return out;
}

// ------------------------------------------------------------------ lots

/**
 * Lots in and units out, run through the rule's method per asset.
 * @param {object} input
 * @param {Array<{date:string, at?:string, asset:string, amount:number, eur:number, source:string}>} input.acquisitions
 * @param {Array<{date:string, at?:string, asset:string, amount:number, proceedsEur:number, kind:string, ref:string}>} input.disposals
 * @param {'fifo'|'lifo'|'average'} [input.method]
 * @returns {{disposals: object[], holdings: Record<string,{amount:number, costEur:number}>, uncovered: object[]}}
 */
export function runLots({ acquisitions = [], disposals = [], method = "fifo" }) {
  const events = [
    ...acquisitions.filter((a) => a.amount > 0).map((a) => ({ ...a, type: "in", key: a.at || `${a.date}T00:00:00.000Z` })),
    ...disposals.filter((d) => d.amount > 0).map((d) => ({ ...d, type: "out", key: d.at || `${d.date}T23:59:59.999Z` })),
  ];
  // Same instant: what comes in first is available to what goes out.
  events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.type === b.type ? 0 : a.type === "in" ? -1 : 1));
  const pools = new Map();
  const results = [];
  const uncovered = [];
  for (const e of events) {
    const lots = pools.get(e.asset) || [];
    pools.set(e.asset, lots);
    if (e.type === "in") {
      if (method === "average" && lots.length) {
        lots[0].amount += e.amount;
        lots[0].costEur += e.eur;
      } else lots.push({ amount: e.amount, costEur: e.eur, date: e.date });
      continue;
    }
    let need = e.amount;
    let cost = 0;
    while (need > EPS && lots.length) {
      const lot = method === "lifo" ? lots[lots.length - 1] : lots[0];
      const take = Math.min(need, lot.amount);
      const part = lot.amount > 0 ? lot.costEur * (take / lot.amount) : 0;
      cost += part;
      lot.amount -= take;
      lot.costEur -= part;
      need -= take;
      if (lot.amount <= EPS) {
        if (method === "lifo") lots.pop();
        else lots.shift();
      }
    }
    const coveredShare = e.amount > 0 ? (e.amount - Math.max(0, need)) / e.amount : 1;
    const uncoveredProceeds = e.proceedsEur * (1 - coveredShare);
    if (need > EPS) uncovered.push({ date: e.date, asset: e.asset, amount: need, kind: e.kind, ref: e.ref });
    // Units without a recorded cost count at their proceeds: no gain, no loss.
    const costEur = cost + uncoveredProceeds;
    results.push({ ...e, type: undefined, key: undefined, costEur, gainEur: e.proceedsEur - costEur, uncoveredAmount: Math.max(0, need) });
  }
  const holdings = {};
  for (const [asset, lots] of pools) {
    const amount = lots.reduce((s, l) => s + l.amount, 0);
    if (amount <= EPS) continue;
    // openLots (not enumerable in JSON output): what is left of each lot, oldest first, for the year-end lot schedule.
    holdings[asset] = { amount, costEur: lots.reduce((s, l) => s + l.costEur, 0) };
    Object.defineProperty(holdings[asset], "openLots", { value: lots.filter((l) => l.amount > EPS).map((l) => ({ date: l.date, amount: l.amount, costEur: l.costEur })), enumerable: false });
  }
  return { disposals: results, holdings, uncovered };
}

/**
 * Lots in from fee revenue: one per day, lane and asset, at the day's EUR value.
 * @param {Record<string,{lanes:object[]}>} days   dailyRevenue().days
 * @param {(date:string)=>number|null} usdPerEur
 */
export function revenueAcquisitions(days, usdPerEur) {
  const out = [];
  for (const [date, day] of Object.entries(days || {})) {
    const rate = usdPerEur(date);
    for (const lane of day.lanes || []) {
      const asset = lotAsset(lane.asset);
      const amount = Number(lane.nativeAmount);
      // A lane counted in USD off-chain (Home placements) is not a USD holding.
      if (!asset || asset === "USD" || !(amount > 0) || lane.amountUsd == null || !(rate > 0)) continue;
      out.push({ date, asset, amount, eur: lane.amountUsd / rate, source: `revenue ${lane.laneId}` });
    }
  }
  return out;
}

/**
 * Lots in and units out from the movements, the crypto costs and the
 * distributions paid in crypto.
 */
export function treasuryLotEvents({ movements = [], costs = [], distributions = [] }) {
  const acquisitions = [];
  const disposals = [];
  for (const m of movements) {
    if (m.deletedAt) continue;
    const date = m.occurredAt.slice(0, 10);
    const inAsset = legLot(m.in);
    const outAsset = legLot(m.out);
    const value = Number(m.valueEur);
    if (m.kind === "transfer_internal") {
      // Same units moving: not a sale. What did not arrive was spent as a fee.
      const lost = Number(m.out.amount) - Number(m.in.amount);
      if (outAsset && lost > 0) disposals.push({ date, at: m.occurredAt, asset: outAsset, amount: lost, proceedsEur: Number(m.out.amount) > 0 ? (value * lost) / Number(m.out.amount) : 0, kind: "transfer_shortfall", ref: `movement ${m.id}` });
    } else if (m.kind === "conversion") {
      if (outAsset) disposals.push({ date, at: m.occurredAt, asset: outAsset, amount: Number(m.out.amount), proceedsEur: value, kind: "conversion", ref: `movement ${m.id}` });
      if (inAsset) acquisitions.push({ date, at: m.occurredAt, asset: inAsset, amount: Number(m.in.amount), eur: value, source: `movement ${m.id}` });
    } else if (m.kind === "fee" || (m.kind === "owner_loan" && m.out) || m.kind === "bank_payment" || m.kind === "crypto_payment") {
      if (outAsset) disposals.push({ date, at: m.occurredAt, asset: outAsset, amount: Number(m.out.amount), proceedsEur: value, kind: m.kind, ref: `movement ${m.id}` });
    } else if (m.in && inAsset) {
      // opening_balance, bank_receipt (USD), owner_contribution, owner_loan received
      acquisitions.push({ date, at: m.occurredAt, asset: inAsset, amount: Number(m.in.amount), eur: value, source: `movement ${m.id}` });
    }
    if (m.fee) {
      const feeAsset = lotAsset(m.fee.asset);
      if (feeAsset) disposals.push({ date, at: m.occurredAt, asset: feeAsset, amount: Number(m.fee.amount), proceedsEur: Number(m.feeEur || 0), kind: "fee", ref: `movement ${m.id} fee` });
    }
  }
  for (const c of costs) {
    const asset = lotAsset(c.currency);
    if (!asset || asset === "USD" || !(c.eurUsdRate > 0)) continue;
    // Paid by a crypto payment: that movement takes the units out (at its own time).
    if (paidOccurrence(c, movements, ["crypto_payment"])) continue;
    disposals.push({ date: c.date, asset, amount: Number(c.amount), proceedsEur: c.amountUsd / c.eurUsdRate, kind: "cost", ref: `cost ${c.costId}` });
  }
  for (const d of distributions) {
    if (d.status !== "paid" || !(d.usdPerEur > 0)) continue;
    for (const p of d.perChain || []) {
      const asset = lotAsset(p.asset);
      const decimals = p.decimals ?? NATIVE_DECIMALS[asset];
      const amount = p.amountNative != null ? Number(p.amountNative) : p.units != null && decimals != null ? Number(p.units) / 10 ** decimals : NaN;
      if (!asset || !(amount > 0)) continue;
      disposals.push({ date: d.availableOn, asset, amount, proceedsEur: Number(p.amountUsd) / d.usdPerEur, kind: "distribution", ref: `distribution ${d.week}` });
    }
  }
  return { acquisitions, disposals };
}

/**
 * Profit effects per UTC day (EUR) from the lot results and the movements.
 * @returns Map date -> {realizedGainEur, feesEur, otherRevenueEur, otherVatEur, otherRevenueUsd}
 */
export function treasuryByDay({ lotDisposals = [], movements = [], rules, usdPerEur }) {
  const out = new Map();
  const get = (date) => {
    let d = out.get(date);
    if (!d) out.set(date, (d = { realizedGainEur: 0, feesEur: 0, otherRevenueEur: 0, otherVatEur: 0, otherRevenueUsd: 0 }));
    return d;
  };
  for (const d of lotDisposals) get(d.date).realizedGainEur += d.gainEur;
  for (const m of movements) {
    if (m.deletedAt) continue;
    const date = m.occurredAt.slice(0, 10);
    // Fees are an expense at their EUR value; a crypto fee's gain or loss is in realizedGainEur.
    if (m.kind === "fee") get(date).feesEur += Number(m.valueEur);
    if (m.fee) get(date).feesEur += Number(m.feeEur || 0);
    if (m.kind === "transfer_internal" && Number(m.out.amount) > Number(m.in.amount)) {
      get(date).feesEur += (Number(m.valueEur) * (Number(m.out.amount) - Number(m.in.amount))) / Number(m.out.amount);
    }
    if (m.kind === "bank_receipt" && m.revenueLane) {
      const r = rules.vat.lanes[m.revenueLane] || rules.vat.lanes.other;
      const eur = Number(m.valueEur);
      const vat = eur * vatFraction(r);
      const day = get(date);
      day.otherRevenueEur += eur;
      day.otherVatEur += vat;
      const rate = usdPerEur(date);
      if (rate) day.otherRevenueUsd += eur * rate;
    }
  }
  return out;
}

/** Net profit effect of a day entry (EUR). */
export function dayNetEur(d) {
  return d ? d.realizedGainEur - d.feesEur + d.otherRevenueEur - d.otherVatEur : 0;
}

/** Sums treasuryByDay entries per month (YYYY-MM). */
export function treasuryByMonth(byDay) {
  const out = new Map();
  for (const [date, d] of byDay) {
    const month = date.slice(0, 7);
    const m = out.get(month) || { realizedGainEur: 0, feesEur: 0, otherRevenueEur: 0, otherVatEur: 0, otherRevenueUsd: 0, netEur: 0 };
    for (const k of ["realizedGainEur", "feesEur", "otherRevenueEur", "otherVatEur", "otherRevenueUsd"]) m[k] += d[k];
    m.netEur += dayNetEur(d);
    out.set(month, m);
  }
  return out;
}

/**
 * Cost occurrences already paid: a bank payment or a crypto payment linked to
 * the cost, in the occurrence's month for a recurring cost, any time for a
 * one-off. These are not "open costs" for the multisig any more.
 */
export function paidOccurrence(occurrence, movements, kinds = ["bank_payment", "crypto_payment"]) {
  return movements.some((m) => !m.deletedAt && kinds.includes(m.kind) && m.costId && String(m.costId) === String(occurrence.costId)
    && (occurrence.recurring === "none" || m.occurredAt.slice(0, 7) === occurrence.month));
}

/** Kept for callers of the earlier name: paid from the bank or in crypto. */
export const bankPaidOccurrence = (occurrence, movements) => paidOccurrence(occurrence, movements);

/**
 * Off-chain cash in EUR: fiat and stablecoins on bank and exchange accounts
 * (crypto on an exchange is left out: its price moves). This cash pays taxes
 * and costs, so the multisig does not have to hold for that part.
 */
export function offChainCashEur(accounts, balances, usdPerEurNow) {
  let eur = 0;
  const lines = [];
  for (const a of accounts) {
    if (a.archivedAt || (a.kind !== "bank" && a.kind !== "exchange")) continue;
    for (const [asset, amount] of balances.get(String(a.id)) || []) {
      let v = null;
      if (asset === "EUR") v = amount;
      else if ((asset === "USD" || asset === "USDC" || asset === "USDT") && usdPerEurNow > 0) v = amount / usdPerEurNow;
      if (v == null || Math.abs(v) < 0.005) continue;
      eur += v;
      lines.push({ accountId: String(a.id), account: a.name, asset, amount: roundUsd(amount), eur: round2(v) });
    }
  }
  return { eur: round2(Math.max(0, eur)), lines };
}

export const TREASURY_METHOD = "Cash per account = opening balances + money in - money out - fees, from the recorded movements (and tax paid from or refunded to the account). Wallets also show the balance read from the chain now. Realized gain = EUR proceeds - EUR cost of the units taken out (method from the tax rules, FIFO by default, per asset across all accounts). Cost of fee revenue = its EUR value on the day it was earned. Profit includes realized gains, minus fees, plus revenue received in the bank minus its VAT. A bank payment or crypto payment linked to a cost is not counted again; a crypto payment adds the gain or loss on the crypto spent (the cost at its market value at the time, the units at their FIFO cost). Tokens (e.g. a platform coin bought as a conversion) are held at cost or lower market value, priced from our market data (last curve trade or market stats) or by hand.";

export { vatLaneOf };
