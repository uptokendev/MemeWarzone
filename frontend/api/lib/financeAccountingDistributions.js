// Distribution proposals. Proposal only: this module computes numbers and
// builds an UNSIGNED Safe Transaction Builder batch (EVM) or a Squads proposal
// description (Solana) as files to download. Nothing here signs, submits or
// moves funds, and no key is loaded.
//
//   distributable = max(0, Ours - buffer - tax reserve - open costs)
//
// Ours is the fee-routing "Ours" total (protocol-owned balances, at spot).
// Each share gets distributable * bps / 10000, rounded down to the cent; the
// rounding remainder stays in the treasury. Per chain, a share is paid from
// that chain's part of Ours (pro rata to its USD value), converted to the
// native asset at the spot price shown, rounded down to 1e-9.

import { ethers } from "ethers";
import { FinanceInputError, roundUsd } from "./financeAccountingCosts.js";
import { EVM_SAFE } from "./financeFeeRoutingEvm.js";

// The Safe that owns the BNB 56 and Robinhood 4663 contracts (same address on
// both chains, docs/claude/evm-deployments.md) and the Solana Squads multisig
// (CLAUDE.md). Editable in settings. Share names follow the 50/30/20 split
// already written in the dashboard's distribution page copy; payout
// addresses start empty and must be entered before a batch can be built.
const DEFAULT_EVM_SAFE = EVM_SAFE;
const DEFAULT_SQUADS_MULTISIG = "fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv";
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SAFE_BATCH_CHAINS = Object.freeze({
  56: { chain: "bnb", asset: "BNB", decimals: 18, label: "BNB Chain" },
  4663: { chain: "robinhood", asset: "ETH", decimals: 18, label: "Robinhood Chain" },
});

export const DEFAULT_DISTRIBUTION_SETTINGS = Object.freeze({
  shares: Object.freeze([
    Object.freeze({ id: "a", name: "Patrick", bps: 5000, evmAddress: "", solanaAddress: "" }),
    Object.freeze({ id: "b", name: "Sven", bps: 3000, evmAddress: "", solanaAddress: "" }),
    Object.freeze({ id: "c", name: "Dough", bps: 2000, evmAddress: "", solanaAddress: "" }),
  ]),
  bufferUsd: 10000,
  evmSafes: Object.freeze({ 56: DEFAULT_EVM_SAFE, 4663: DEFAULT_EVM_SAFE }),
  squadsMultisig: DEFAULT_SQUADS_MULTISIG,
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

export function validateDistributionSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the distribution settings as a JSON object.");
  if (!Array.isArray(body.shares) || body.shares.length < 1 || body.shares.length > 10) throw new FinanceInputError("shares must list 1 to 10 shareholders.", "shares");
  const ids = new Set();
  const shares = body.shares.map((share, index) => {
    const n = index + 1;
    const name = typeof share?.name === "string" ? share.name.trim() : "";
    if (!name || name.length > 80) throw new FinanceInputError(`Share ${n}: name is required (at most 80 characters).`, "shares");
    const bps = Number(share?.bps);
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new FinanceInputError(`Share ${n}: bps must be a whole number from 1 to 10000 (5000 = 50%).`, "shares");
    const id = String(share?.id || `s${n}`).trim().slice(0, 32) || `s${n}`;
    if (ids.has(id)) throw new FinanceInputError(`Share ${n}: id is used twice.`, "shares");
    ids.add(id);
    return { id, name, bps, evmAddress: evmAddress(share?.evmAddress, `Share ${n} EVM address`), solanaAddress: solanaAddress(share?.solanaAddress, `Share ${n} Solana address`) };
  });
  const total = shares.reduce((s, x) => s + x.bps, 0);
  if (total !== 10000) throw new FinanceInputError(`Shares add up to ${total / 100}%, they must add up to 100%.`, "shares");
  const bufferUsd = Number(body.bufferUsd);
  if (!Number.isFinite(bufferUsd) || bufferUsd < 0 || bufferUsd > 1e10) throw new FinanceInputError("bufferUsd must be zero or more.", "bufferUsd");
  const evmSafes = {};
  for (const chainId of Object.keys(SAFE_BATCH_CHAINS)) {
    evmSafes[chainId] = evmAddress(body.evmSafes?.[chainId], `Safe address for chain ${chainId}`);
  }
  return { shares, bufferUsd: roundUsd(bufferUsd), evmSafes, squadsMultisig: solanaAddress(body.squadsMultisig, "Squads multisig") };
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
 * @param {number|null} input.oursUsd
 * @param {Array<{chainId:number, chain:string, asset:string, decimals:number, oursUsd:number|null, priceUsd:number|null}>} input.chains
 * @param {number|null} input.taxReserveUsd
 * @param {number|null} input.openCostsUsd
 * @param {object} input.settings  effective distribution settings
 */
export function computeDistribution({ oursUsd, chains = [], taxReserveUsd, openCostsUsd, settings }) {
  const blockers = [];
  if (oursUsd == null) blockers.push("Ours could not be valued in USD (a balance or price read failed).");
  if (taxReserveUsd == null) blockers.push("The tax reserve could not be computed.");
  if (openCostsUsd == null) blockers.push("Open costs could not be read.");
  const deductions = {
    bufferUsd: settings.bufferUsd,
    taxReserveUsd: taxReserveUsd == null ? null : Math.max(0, taxReserveUsd),
    openCostsUsd,
  };
  if (blockers.length) return { oursUsd, deductions, distributableUsd: null, retainedUsd: null, shares: [], blockers };

  const raw = oursUsd - deductions.bufferUsd - deductions.taxReserveUsd - deductions.openCostsUsd;
  const distributableUsd = raw > 0 ? floorCents(raw) : 0;
  const pricedChains = chains.filter((c) => c.oursUsd != null && c.oursUsd > 0 && c.priceUsd > 0);
  const pricedTotal = pricedChains.reduce((s, c) => s + c.oursUsd, 0);
  const shares = settings.shares.map((share) => {
    const amountUsd = floorCents((distributableUsd * share.bps) / 10000);
    const perChain = pricedChains.map((c) => {
      const usd = pricedTotal > 0 ? (amountUsd * c.oursUsd) / pricedTotal : 0;
      const units = usdToNativeUnits(usd, c.priceUsd, c.decimals);
      return { chainId: c.chainId, chain: c.chain, asset: c.asset, amountUsd: floorCents(usd), units: units.toString(), amountNative: unitsToDecimal(units, c.decimals), priceUsd: c.priceUsd };
    });
    return { ...share, percent: share.bps / 100, amountUsd, perChain };
  });
  const paid = shares.reduce((s, x) => s + x.amountUsd, 0);
  return {
    oursUsd: roundUsd(oursUsd),
    deductions,
    distributableUsd,
    shortfallUsd: raw < 0 ? roundUsd(-raw) : 0,
    retainedUsd: roundUsd(oursUsd - paid),
    shares,
    blockers,
  };
}

/**
 * Unsigned Safe Transaction Builder batch: one native transfer per share, from
 * the Safe. Import it in the Safe app (Transaction Builder) to review; the
 * Safe owners decide whether to sign. Throws when a share has no EVM address
 * or the chain has no Safe set, so no shareholder is left out silently.
 */
export function buildSafeBatch({ chainId, distribution, settings, createdAtMs = Date.now() }) {
  const chain = SAFE_BATCH_CHAINS[chainId];
  if (!chain) throw new FinanceInputError("Safe batches cover BNB 56 and Robinhood 4663.", "chainId");
  const safe = settings.evmSafes?.[chainId];
  if (!safe) throw new FinanceInputError(`No Safe address is set for chain ${chainId}.`, "evmSafes");
  if (distribution.distributableUsd == null) throw new FinanceInputError("Nothing to propose: the distributable amount could not be computed.");
  const missing = distribution.shares.filter((s) => !s.evmAddress).map((s) => s.name);
  if (missing.length) throw new FinanceInputError(`No EVM payout address for: ${missing.join(", ")}. Set it in the distribution settings first.`, "shares");
  const transactions = [];
  const lines = [];
  for (const share of distribution.shares) {
    const part = share.perChain.find((p) => p.chainId === Number(chainId));
    if (!part || part.units === "0") continue;
    transactions.push({ to: share.evmAddress, value: part.units, data: "0x", contractMethod: null, contractInputsValues: null });
    lines.push(`${share.name} ${share.percent}%: ${part.amountNative} ${chain.asset} (~$${part.amountUsd.toFixed(2)})`);
  }
  if (!transactions.length) throw new FinanceInputError(`Nothing to pay on chain ${chainId}: its share of Ours is zero.`);
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: createdAtMs,
    meta: {
      name: `MWZ distribution proposal ${new Date(createdAtMs).toISOString().slice(0, 10)} (${chain.label})`,
      description: `Proposal only, generated unsigned by the Command Center. Native ${chain.asset} transfers from Safe ${safe}. ${lines.join("; ")}. The Safe pays from its own balance. Check every amount and address before anyone signs.`,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
    },
    transactions,
  };
}

/** Text for a Squads vault transaction proposal (Solana). Nothing is created on chain. */
export function buildSquadsProposal({ distribution, settings, createdAtMs = Date.now() }) {
  if (distribution.distributableUsd == null) throw new FinanceInputError("Nothing to propose: the distributable amount could not be computed.");
  if (!settings.squadsMultisig) throw new FinanceInputError("No Squads multisig is set.", "squadsMultisig");
  const missing = distribution.shares.filter((s) => !s.solanaAddress).map((s) => s.name);
  if (missing.length) throw new FinanceInputError(`No Solana payout address for: ${missing.join(", ")}. Set it in the distribution settings first.`, "shares");
  const rows = distribution.shares
    .map((share) => ({ share, part: share.perChain.find((p) => p.chainId === 101) }))
    .filter(({ part }) => part && part.units !== "0");
  if (!rows.length) throw new FinanceInputError("Nothing to pay on Solana: its share of Ours is zero.");
  const lines = [
    `MWZ distribution proposal ${new Date(createdAtMs).toISOString().slice(0, 10)} (Solana)`,
    "",
    "PROPOSAL ONLY. Generated unsigned by the Command Center. Nothing was created, signed or sent.",
    `Squads multisig: ${settings.squadsMultisig}`,
    "Create one vault transaction with a SOL transfer (System Program) per line below, from the multisig vault.",
    "",
    ...rows.map(({ share, part }) => `${share.name} (${share.percent}%): ${part.amountNative} SOL = ${part.units} lamports to ${share.solanaAddress} (~$${part.amountUsd.toFixed(2)} at $${part.priceUsd} per SOL)`),
    "",
    `Distributable now: $${distribution.distributableUsd.toFixed(2)} = Ours $${distribution.oursUsd.toFixed(2)} - buffer $${distribution.deductions.bufferUsd.toFixed(2)} - tax reserve $${distribution.deductions.taxReserveUsd.toFixed(2)} - open costs $${distribution.deductions.openCostsUsd.toFixed(2)}.`,
    "Check every amount and address before anyone approves.",
  ];
  return lines.join("\n");
}
