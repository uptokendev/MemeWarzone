/**
 * Go-live canary for coin creation.
 *
 * CREATE_CANARY_WALLETS (comma-separated) limits every create path to the listed creator wallets
 * while the launch team creates one canary coin per chain. EVM addresses compare case-insensitively,
 * Solana base58 addresses compare exactly. Unset or empty: no effect at all.
 *
 * The gate only refuses to sign, authorize or prepare a create. Saving a draft is never gated.
 */
import { json } from "../../server/http.js";

export const CREATE_CANARY_CODE = "CREATE_CANARY_ONLY";
export const CREATE_CANARY_MESSAGE = "Launches open soon. Creation is limited to the launch team for a short test.";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function normalizeWallet(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return EVM_ADDRESS.test(raw) ? raw.toLowerCase() : raw;
}

export function createCanaryWallets(env = process.env) {
  const raw = String(env?.CREATE_CANARY_WALLETS ?? "");
  return new Set(raw.split(",").map(normalizeWallet).filter(Boolean));
}

export function isCreateCanaryActive(env = process.env) {
  return createCanaryWallets(env).size > 0;
}

/** True when creation is open to this wallet: canary off, or the wallet is on the list. */
export function isCreateAllowedForWallet(wallet, env = process.env) {
  const list = createCanaryWallets(env);
  if (list.size === 0) return true;
  const normalized = normalizeWallet(wallet);
  return Boolean(normalized) && list.has(normalized);
}

export function createCanaryRefusalBody() {
  return { ok: false, error: CREATE_CANARY_MESSAGE, code: CREATE_CANARY_CODE };
}

export class CreateCanaryError extends Error {
  constructor() {
    super(CREATE_CANARY_MESSAGE);
    this.name = "CreateCanaryError";
    this.code = CREATE_CANARY_CODE;
    this.httpStatus = 403;
  }
}

/** Throws CreateCanaryError when the canary is on and the wallet is not listed. */
export function assertCreateAllowedForWallet(wallet, env = process.env) {
  if (!isCreateAllowedForWallet(wallet, env)) throw new CreateCanaryError();
}

/** Writes the 403 and returns true when the wallet is refused; returns false otherwise. */
export function refuseCreateIfCanaryBlocked(res, wallet, env = process.env) {
  if (isCreateAllowedForWallet(wallet, env)) return false;
  json(res, 403, createCanaryRefusalBody());
  return true;
}
