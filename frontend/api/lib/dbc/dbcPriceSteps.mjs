/**
 * Geometric SOL-price steps of 2% (D9).
 *
 * index = round(ln(solUsd) / ln(1.02))
 * stepUsd = 1.02^index
 *
 * Integer micros, deterministic: Number.log of a SOL price in [1, 100000] has
 * more than enough mantissa, and the result is rounded to the nearest micro.
 */
import { DBC_SOL_PRICE_STEP_RATIO, DBC_USD_MICROS } from "../../../shared/dbcEconomics.mjs";

const LN_STEP = Math.log(DBC_SOL_PRICE_STEP_RATIO);

export function solPriceStepIndex(solUsdMicros) {
  const micros = BigInt(solUsdMicros);
  if (micros <= 0n) throw new Error("SOL/USD micros must be positive");
  const solUsd = Number(micros) / Number(DBC_USD_MICROS);
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error("SOL/USD micros must be a finite positive price");
  return Math.round(Math.log(solUsd) / LN_STEP);
}

export function stepUsdMicrosFromIndex(index) {
  const n = Number(index);
  if (!Number.isInteger(n)) throw new Error("step index must be an integer");
  const micros = Math.round(Math.exp(n * LN_STEP) * Number(DBC_USD_MICROS));
  if (!Number.isFinite(micros) || micros <= 0) throw new Error("step price overflow");
  return BigInt(micros);
}

export function solPriceStep(solUsdMicros) {
  const stepIndex = solPriceStepIndex(solUsdMicros);
  const stepUsdMicros = stepUsdMicrosFromIndex(stepIndex);
  return { stepIndex, stepUsdMicros };
}
