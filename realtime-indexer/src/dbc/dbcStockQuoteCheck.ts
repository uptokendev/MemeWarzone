/**
 * Step 7b: before a stock-bound coin migrates, re-read the quote mint. The launch was checked when it
 * was authorized; an issuer can pause the token or switch on a transfer hook or fee afterwards, and
 * DBC/DAMM v2 cannot carry any of them. Same rules as frontend/api/lib/dbc/dbcStockQuote.mjs.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getExtensionData,
  getMint,
  getTransferFeeConfig,
  getTransferHook,
} from "@solana/spl-token";

export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

/**
 * PausableConfig is extension type 26: authority (32) then paused (bool). spl-token 0.4.9 here
 * predates it, so it is read by type number (0.4.15's PausableConfigLayout, 33 bytes).
 */
const PAUSABLE_CONFIG_EXTENSION = 26;

export function mintPaused(tlvData: Buffer): boolean {
  const data = getExtensionData(PAUSABLE_CONFIG_EXTENSION as any, tlvData);
  return Boolean(data && data.length >= 33 && data[32] === 1);
}

export type StockQuoteRefusal = { code: string; reason: string };

/** null when the Token-2022 quote can still graduate; the refusal otherwise. Classic SPL mints pass. */
export async function stockQuoteRefusal(connection: any, quoteMint: string, quoteProgram: PublicKey): Promise<StockQuoteRefusal | null> {
  if (!quoteProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const mint = new PublicKey(quoteMint);
  const info = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (mintPaused(info.tlvData)) return { code: "paused", reason: "quote token paused by its issuer" };
  const hook = getTransferHook(info);
  if (hook && !hook.programId.equals(PublicKey.default)) {
    return { code: "hook", reason: `quote token transfer hook set to ${hook.programId.toBase58()}` };
  }
  const fee = getTransferFeeConfig(info);
  if (fee && (Number(fee.olderTransferFee.transferFeeBasisPoints) > 0 || Number(fee.newerTransferFee.transferFeeBasisPoints) > 0)) {
    return { code: "transfer-fee", reason: "quote token charges a transfer fee" };
  }
  const badge = PublicKey.findProgramAddressSync([Buffer.from("token_badge"), mint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
  const badgeInfo = await connection.getAccountInfo(badge, "confirmed");
  if (!badgeInfo || !badgeInfo.owner.equals(DAMM_V2_PROGRAM_ID)) {
    return { code: "no-damm-badge", reason: "Meteora has no DAMM v2 badge for the quote token" };
  }
  return null;
}
