// Distribution proposals. Proposal only: this module computes numbers and
// builds an UNSIGNED Safe Transaction Builder batch (EVM) or a Squads proposal
// description (Solana) as files to download. Nothing here signs, submits or
// moves funds, and no key is loaded.
//
// Founder decision 2026-10-04: protocol revenue fills the operator wallet up
// to the $10,000 cap and the rest overflows to the multisig (Solana Squads
// vault, EVM Safe). The operator wallet is the treasury buffer and is never
// distributed. Only what the multisig holds can be distributed:
//
//   distributable = max(0, multisig balance (all chains, native, at spot)
//                          - tax reserve (this year to date) - open costs)
//
// Each share gets distributable * bps / 10000, rounded down to the cent; the
// rounding remainder stays in the multisig. Dividend withholding per
// shareholder comes from the researched rules and the shareholder's entity
// type (financeTaxRules.withholdingFor: Dutch holding BV and US corporation
// with at least 5% are exempt under art. 4 Wet op de dividendbelasting 1965);
// a per-shareholder override is possible. The withheld part is held back from
// that share and stays in the multisig until it is paid to the Belastingdienst. Per chain, a share is paid from that
// chain's part of the multisig balance (pro rata to its USD value), converted
// to the native asset at the spot price shown, rounded down to 1e-9, and never
// more than the multisig holds on that chain.

import { ethers } from "ethers";
import { FinanceInputError, roundUsd } from "./financeAccountingCosts.js";
import { ENTITY_TYPES, ENTITY_TYPE_LABELS, inferEntityType } from "./financeTaxRules.js";

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SAFE_BATCH_CHAINS = Object.freeze({
  56: { chain: "bnb", asset: "BNB", decimals: 18, label: "BNB Chain" },
  4663: { chain: "robinhood", asset: "ETH", decimals: 18, label: "Robinhood Chain" },
});
export const OPERATOR_CAP_USD = 10000;
export const BUFFER_LABEL = "Buffer: operator wallet, capped at $10,000 (not distributed)";
export const DIVIDEND_NOTE = "A distribution is a dividend from MemeWarzone BV to its shareholders. Each one needs a shareholder resolution and the board's approval after the balance and liquidity test (art. 2:216 BW). Withholding follows the rules on Tax & Reserves (art. 4 Wet op de dividendbelasting 1965: the Dutch holdings and the US corporation with at least 5% are exempt; the US exemption needs a notification within 1 month). The batch generated here is a proposal only.";

// Shareholders (founder 2026-10-04): partners hold their shares through these
// entities. Payout addresses start empty and must be entered before a batch
// can be built. Withholding comes from the rules for the entity type unless
// withholdingOverride is set.
export const DEFAULT_DISTRIBUTION_SETTINGS = Object.freeze({
  shares: Object.freeze([
    Object.freeze({ id: "a", name: "Patrick", entity: "Dutch personal holding (BV)", entityType: "dutch_holding_bv", bps: 5000, withholdingPct: 0, withholdingOverride: false, evmAddress: "", solanaAddress: "" }),
    Object.freeze({ id: "b", name: "Sven", entity: "Dutch personal holding (BV)", entityType: "dutch_holding_bv", bps: 3000, withholdingPct: 0, withholdingOverride: false, evmAddress: "", solanaAddress: "" }),
    Object.freeze({ id: "c", name: "Dough", entity: "US corporation", entityType: "us_corporation", bps: 2000, withholdingPct: 0, withholdingOverride: false, evmAddress: "", solanaAddress: "" }),
  ]),
});

function evmAddress(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!ethers.isAddress(raw)) throw new FinanceInputError(`${field} is not an EVM address.`, field);
  if (/^0x0{40}$/i.test(raw)) throw new FinanceInputError(`${field} is the zero address.`, field);
  return ethers.getAddress(raw);
}

function solanaAddress(value, field) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!SOLANA_ADDRESS.test(raw)) throw new FinanceInputError(`${field} is not a Solana address.`, field);
  return raw;
}

/** Validates the settings form. Fields from older versions (bufferUsd, evmSafes, squadsMultisig) are ignored. */
export function validateDistributionSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the distribution settings as a JSON object.");
  if (!Array.isArray(body.shares) || body.shares.length < 1 || body.shares.length > 10) throw new FinanceInputError("shares must list 1 to 10 shareholders.", "shares");
  const ids = new Set();
  const shares = body.shares.map((share, index) => {
    const n = index + 1;
    const name = typeof share?.name === "string" ? share.name.trim() : "";
    if (!name || name.length > 80) throw new FinanceInputError(`Share ${n}: name is required (at most 80 characters).`, "shares");
    const entity = typeof share?.entity === "string" ? share.entity.trim() : "";
    if (entity.length > 120) throw new FinanceInputError(`Share ${n}: legal entity is longer than 120 characters.`, "shares");
    const bps = Number(share?.bps);
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new FinanceInputError(`Share ${n}: bps must be a whole number from 1 to 10000 (5000 = 50%).`, "shares");
    const withholdingPct = share?.withholdingPct == null || share?.withholdingPct === "" ? 0 : Number(share.withholdingPct);
    if (!Number.isFinite(withholdingPct) || withholdingPct < 0 || withholdingPct > 100 || Math.round(withholdingPct * 100) !== withholdingPct * 100) {
      throw new FinanceInputError(`Share ${n}: withholding % must be 0 to 100 with at most two decimals.`, "shares");
    }
    const entityType = share?.entityType == null || share?.entityType === "" ? inferEntityType(entity) : String(share.entityType);
    if (!ENTITY_TYPES.includes(entityType)) throw new FinanceInputError(`Share ${n}: entity type must be one of ${ENTITY_TYPES.join(", ")}.`, "shares");
    const withholdingOverride = share?.withholdingOverride === true;
    const id = String(share?.id || `s${n}`).trim().slice(0, 32) || `s${n}`;
    if (ids.has(id)) throw new FinanceInputError(`Share ${n}: id is used twice.`, "shares");
    ids.add(id);
    return { id, name, entity, entityType, bps, withholdingPct, withholdingOverride, evmAddress: evmAddress(share?.evmAddress, `Share ${n} EVM address`), solanaAddress: solanaAddress(share?.solanaAddress, `Share ${n} Solana address`) };
  });
  const total = shares.reduce((s, x) => s + x.bps, 0);
  if (total !== 10000) throw new FinanceInputError(`Shares add up to ${total / 100}%, they must add up to 100%.`, "shares");
  return { shares };
}

/**
 * What changed between two saved distribution settings, in plain lines
 * ("Patrick EVM payout address: not set -> 0x..."). `before` null = the
 * defaults were in use.
 */
export function describeDistributionChange(before, after) {
  const prev = new Map(((before && Array.isArray(before.shares) ? before.shares : DEFAULT_DISTRIBUTION_SETTINGS.shares) || []).map((s) => [s.id, s]));
  const next = new Map(((after && Array.isArray(after.shares) ? after.shares : []) || []).map((s) => [s.id, s]));
  const lines = [];
  const show = (v) => (v === "" || v == null ? "not set" : String(v));
  for (const [id, share] of next) {
    const old = prev.get(id);
    if (!old) { lines.push(`${share.name} added: ${share.bps / 100}%`); continue; }
    if (old.name !== share.name) lines.push(`${show(old.name)} renamed to ${show(share.name)}`);
    if (old.bps !== share.bps) lines.push(`${share.name} share: ${old.bps / 100}% -> ${share.bps / 100}%`);
    if ((old.entity || "") !== (share.entity || "")) lines.push(`${share.name} legal entity: ${show(old.entity)} -> ${show(share.entity)}`);
    const oldType = old.entityType || inferEntityType(old.entity);
    if (oldType !== share.entityType) lines.push(`${share.name} entity type: ${ENTITY_TYPE_LABELS[oldType] || oldType} -> ${ENTITY_TYPE_LABELS[share.entityType] || share.entityType}`);
    const wText = (s) => (s.withholdingOverride ? `${s.withholdingPct || 0}% (set by hand)` : "from the rules");
    if (wText(old) !== wText(share)) lines.push(`${share.name} withholding: ${wText(old)} -> ${wText(share)}`);
    if ((old.evmAddress || "") !== (share.evmAddress || "")) lines.push(`${share.name} EVM payout address: ${show(old.evmAddress)} -> ${show(share.evmAddress)}`);
    if ((old.solanaAddress || "") !== (share.solanaAddress || "")) lines.push(`${share.name} Solana payout address: ${show(old.solanaAddress)} -> ${show(share.solanaAddress)}`);
  }
  for (const [id, share] of prev) if (!next.has(id)) lines.push(`${share.name} removed`);
  return lines.length ? lines : ["Saved without changes"];
}

export function effectiveDistributionSettings(stored) {
  if (stored && typeof stored === "object") {
    try {
      return { ...validateDistributionSettings(stored), isDefault: false };
    } catch {
      return { ...structuredClone(DEFAULT_DISTRIBUTION_SETTINGS), isDefault: true, storedInvalid: true };
    }
  }
  return { ...structuredClone(DEFAULT_DISTRIBUTION_SETTINGS), isDefault: true };
}

const floorCents = (usd) => Math.floor(usd * 100 + 1e-6) / 100;

/** Native units (BigInt) for a USD amount at a price, rounded down to 1e-9. */
export function usdToNativeUnits(usd, priceUsd, decimals) {
  if (!(usd > 0) || !(priceUsd > 0)) return 0n;
  const nano = BigInt(Math.floor((usd / priceUsd) * 1e9));
  return decimals >= 9 ? nano * 10n ** BigInt(decimals - 9) : nano / 10n ** BigInt(9 - decimals);
}

export function unitsToDecimal(units, decimals) {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const fraction = s.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * @param {object} input
 * @param {Array<{chainId:number, chain:string, asset:string, decimals:number, multisigAddress:string|null,
 *   multisigUsd:number|null, multisigRaw:string|null, priceUsd:number|null}>} input.chains
 * @param {number|null} input.taxReserveUsd
 * @param {number|null} input.openCostsUsd
 * @param {object} input.settings  effective distribution settings (withholdingPct already resolved)
 * @param {number|null} [input.distributableUsdOverride]  weekly view: the amount to divide
 */
export function computeDistribution({ chains = [], taxReserveUsd, openCostsUsd, settings, distributableUsdOverride = null }) {
  const blockers = [];
  for (const c of chains) {
    if (c.multisigUsd == null || c.multisigRaw == null) blockers.push(`The multisig balance on chain ${c.chainId} could not be read or valued.`);
  }
  if (!chains.length) blockers.push("No multisig balances were read.");
  if (taxReserveUsd == null) blockers.push("The tax reserve could not be computed.");
  if (openCostsUsd == null) blockers.push("Open costs could not be read.");
  const multisigUsd = blockers.length ? null : roundUsd(chains.reduce((s, c) => s + c.multisigUsd, 0));
  const deductions = { taxReserveUsd: taxReserveUsd == null ? null : Math.max(0, taxReserveUsd), openCostsUsd };
  if (blockers.length) return { multisigUsd, deductions, distributableUsd: null, retainedUsd: null, shares: [], blockers };

  // The weekly view passes its own amount (already capped by cash); otherwise
  // what the multisig holds minus the reserve and open costs.
  const raw = distributableUsdOverride != null ? Math.min(distributableUsdOverride, multisigUsd) : multisigUsd - deductions.taxReserveUsd - deductions.openCostsUsd;
  const distributableUsd = raw > 0 ? floorCents(raw) : 0;
  const priced = chains.filter((c) => c.multisigUsd > 0 && c.priceUsd > 0);
  const pricedTotal = priced.reduce((s, c) => s + c.multisigUsd, 0);
  const remaining = new Map(priced.map((c) => [c.chainId, BigInt(c.multisigRaw)]));
  const shares = settings.shares.map((share) => {
    const grossUsd = floorCents((distributableUsd * share.bps) / 10000);
    const withholdingUsd = floorCents((grossUsd * (share.withholdingPct || 0)) / 100);
    const netUsd = roundUsd(grossUsd - withholdingUsd);
    const perChain = priced.map((c) => {
      const usd = pricedTotal > 0 ? (netUsd * c.multisigUsd) / pricedTotal : 0;
      let units = usdToNativeUnits(usd, c.priceUsd, c.decimals);
      const left = remaining.get(c.chainId);
      if (units > left) units = left;
      remaining.set(c.chainId, left - units);
      return { chainId: c.chainId, chain: c.chain, asset: c.asset, amountUsd: floorCents(usd), units: units.toString(), amountNative: unitsToDecimal(units, c.decimals), priceUsd: c.priceUsd };
    });
    return { ...share, percent: share.bps / 100, amountUsd: grossUsd, withholdingUsd, netUsd, perChain };
  });
  const paid = shares.reduce((s, x) => s + x.netUsd, 0);
  return {
    multisigUsd,
    deductions,
    distributableUsd,
    shortfallUsd: raw < 0 ? roundUsd(-raw) : 0,
    retainedUsd: roundUsd(multisigUsd - paid),
    shares,
    blockers,
  };
}

/**
 * Unsigned Safe Transaction Builder batch: one native transfer per share (net
 * of withholding), from the Safe whose balance was read. Import it in the Safe
 * app (Transaction Builder) to review; the Safe owners decide whether to sign.
 * Throws when a share has no EVM address, so no shareholder is left out.
 */
export function buildSafeBatch({ chainId, distribution, chains, createdAtMs = Date.now(), week = null }) {
  const meta = SAFE_BATCH_CHAINS[chainId];
  if (!meta) throw new FinanceInputError("Safe batches cover BNB 56 and Robinhood 4663.", "chainId");
  const safe = chains.find((c) => c.chainId === Number(chainId))?.multisigAddress;
  if (!safe) throw new FinanceInputError(`No Safe is known for chain ${chainId}.`, "chainId");
  if (distribution.distributableUsd == null) throw new FinanceInputError("Nothing to propose: the distributable amount could not be computed.");
  const missing = distribution.shares.filter((s) => !s.evmAddress).map((s) => s.name);
  if (missing.length) throw new FinanceInputError(`No EVM payout address for: ${missing.join(", ")}. Set it in the distribution settings first.`, "shares");
  const transactions = [];
  const lines = [];
  for (const share of distribution.shares) {
    const part = share.perChain.find((p) => p.chainId === Number(chainId));
    if (!part || part.units === "0") continue;
    transactions.push({ to: share.evmAddress, value: part.units, data: "0x", contractMethod: null, contractInputsValues: null });
    lines.push(`${share.name} (${share.entity || "entity not set"}) ${share.percent}%${share.withholdingPct ? `, ${share.withholdingPct}% withheld` : ""}: ${part.amountNative} ${meta.asset} (~$${part.amountUsd.toFixed(2)})`);
  }
  if (!transactions.length) throw new FinanceInputError(`Nothing to pay on chain ${chainId}: the Safe holds nothing distributable there.`);
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: createdAtMs,
    meta: {
      name: `MWZ distribution proposal ${week ? `${week} ` : ""}${new Date(createdAtMs).toISOString().slice(0, 10)} (${meta.label})`,
      description: `Proposal only, generated unsigned by the Command Center. Dividend from MemeWarzone BV${week ? ` for week ${week}` : ""}; needs the shareholder resolution and the board's approval after the distribution test (art. 2:216 BW) before anyone signs. Native ${meta.asset} transfers from Safe ${safe}: ${lines.join("; ")}. Check every amount and address.`,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
    },
    transactions,
  };
}

/** Text for a Squads vault transaction proposal (Solana). Nothing is created on chain. */
export function buildSquadsProposal({ distribution, chains, createdAtMs = Date.now(), week = null, summary = null }) {
  if (distribution.distributableUsd == null) throw new FinanceInputError("Nothing to propose: the distributable amount could not be computed.");
  const vault = chains.find((c) => c.chainId === 101)?.multisigAddress;
  if (!vault) throw new FinanceInputError("No Squads vault is known.", "chainId");
  const missing = distribution.shares.filter((s) => !s.solanaAddress).map((s) => s.name);
  if (missing.length) throw new FinanceInputError(`No Solana payout address for: ${missing.join(", ")}. Set it in the distribution settings first.`, "shares");
  const rows = distribution.shares
    .map((share) => ({ share, part: share.perChain.find((p) => p.chainId === 101) }))
    .filter(({ part }) => part && part.units !== "0");
  if (!rows.length) throw new FinanceInputError("Nothing to pay on Solana: the Squads vault holds nothing distributable.");
  const lines = [
    `MWZ distribution proposal ${week ? `${week} ` : ""}${new Date(createdAtMs).toISOString().slice(0, 10)} (Solana)`,
    "",
    "PROPOSAL ONLY. Generated unsigned by the Command Center. Nothing was created, signed or sent.",
    DIVIDEND_NOTE,
    `Squads vault: ${vault}`,
    "Create one vault transaction with a SOL transfer (System Program) per line below, from the Squads vault.",
    "",
    ...rows.map(({ share, part }) => `${share.name} (${share.entity || "entity not set"}, ${share.percent}%${share.withholdingPct ? `, ${share.withholdingPct}% withheld` : ""}): ${part.amountNative} SOL = ${part.units} lamports to ${share.solanaAddress} (~$${part.amountUsd.toFixed(2)} at $${part.priceUsd} per SOL)`),
    "",
    summary || `Distributable now: $${distribution.distributableUsd.toFixed(2)} = multisig $${distribution.multisigUsd.toFixed(2)} - tax reserve $${distribution.deductions.taxReserveUsd.toFixed(2)} - open costs $${distribution.deductions.openCostsUsd.toFixed(2)}. The operator wallet (buffer, capped at $10,000) is not distributed.`,
    "Check every amount and address before anyone approves.",
  ];
  return lines.join("\n");
}
