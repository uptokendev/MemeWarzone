/**
 * Form validation constants and schemas
 */

import { z } from "zod";

/**
 * Metaplex caps an on-chain token name at 32 bytes and a symbol at 10, and the
 * launchpad clips anything longer before writing it. Clipping is the right
 * behaviour there — a creator who has already paid for the create transaction
 * should not end up with an unnamed token over a display detail — but it means
 * a name accepted here that does not fit on chain leaves the site showing one
 * name and every wallet showing another.
 *
 * So the form refuses what the chain cannot hold rather than letting it through
 * to be silently shortened. 100 was a round number from before any of this
 * touched Solana; no campaign on any chain has ever used more than 26 bytes
 * except the one that exposed the mismatch.
 */
export const TOKEN_VALIDATION_LIMITS = {
  NAME_MAX_LENGTH: 32,
  TICKER_MAX_LENGTH: 10,
  DESCRIPTION_MAX_LENGTH: 1000,
} as const;

/**
 * The chain limit is bytes, not characters, and an input's `maxLength` counts
 * UTF-16 code units. An emoji is one or two of those and four bytes, so a name
 * that looks short enough in the field can still be too long on chain. Measure
 * the same way the encoder does.
 */
export function tokenNameByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

const socialInput = z.string().trim().max(500, "Social link must be less than 500 characters").optional().or(z.literal(""));

export const tokenSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Token name is required")
    .max(TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH, `Token name must be ${TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH} characters or fewer`)
    .refine(
      (value) => tokenNameByteLength(value) <= TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH,
      `Token name must be ${TOKEN_VALIDATION_LIMITS.NAME_MAX_LENGTH} bytes or fewer. Emoji and accented characters count for more than one.`,
    ),
  ticker: z
    .string()
    .trim()
    .min(1, "Ticker is required")
    .max(TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH, `Ticker must be ${TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH} characters or fewer`)
    .refine(
      (value) => tokenNameByteLength(value) <= TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH,
      `Ticker must be ${TOKEN_VALIDATION_LIMITS.TICKER_MAX_LENGTH} bytes or fewer. Emoji and accented characters count for more than one.`,
    ),
  description: z
    .string()
    .max(TOKEN_VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH, `Description must be less than ${TOKEN_VALIDATION_LIMITS.DESCRIPTION_MAX_LENGTH} characters`)
    .optional(),
  website: socialInput,
  twitter: socialInput,
  otherLink: socialInput,
});
