/**
 * Strict EVM wallet parsing for gen-8 create paths (audit B-02).
 *
 * ethers.isAddress / ethers.getAddress also accept bare 40-hex (no 0x) and ICAP (XE...) forms. If one layer checks
 * a wallet with the strict 0x form and another layer accepts the loose forms, a request can skip the first check
 * (the go-live create canary was skipped that way). Every gen-8 create path parses the wallet here, once, and uses
 * only the returned checksummed address afterwards.
 *
 * Rules: the raw value must be a string of exactly "0x" + 40 hex digits, with no surrounding whitespace. Mixed case
 * must carry a valid EIP-55 checksum (ethers.getAddress runs only after the regex). Anything else is refused.
 */
import { ethers } from "ethers";

export const STRICT_EVM_WALLET = /^0x[0-9a-fA-F]{40}$/;

/**
 * strictEvmWallet(raw) -> { ok: true, address } | { ok: false, empty, reason }
 *   address: EIP-55 checksummed. empty: true when nothing was sent (undefined, null or "").
 */
export function strictEvmWallet(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: false, empty: true, reason: "walletAddress is missing" };
  if (typeof raw !== "string" || !STRICT_EVM_WALLET.test(raw)) {
    return { ok: false, empty: false, reason: "walletAddress must be 0x followed by 40 hex characters" };
  }
  try {
    return { ok: true, address: ethers.getAddress(raw) };
  } catch {
    return { ok: false, empty: false, reason: "walletAddress has an invalid checksum" };
  }
}
