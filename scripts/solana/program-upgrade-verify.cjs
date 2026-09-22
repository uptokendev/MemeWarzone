"use strict";
/**
 * Shared post-upgrade verification for the Solana program upgraders.
 *
 * This lives in one place because the mistake it prevents shipped twice: both
 * the devnet and mainnet upgraders compared `solana program dump` output to the
 * candidate with Buffer.equals, and a deployed program occupies the whole
 * ProgramData allocation -- the binary followed by zero padding. That check can
 * only pass when the allocation happens to equal the binary size, so it
 * reported DEPLOYMENT VERIFICATION FAILED on upgrades that had in fact
 * succeeded.
 */

/**
 * The invariant: the allocation starts with the candidate and every remaining
 * byte is zero. Each way it can fail is named, because "verification failed" on
 * a live upgrade is the moment you least want an ambiguous message.
 */
function deployedMatchesCandidate(deployed, candidate) {
  if (deployed.length < candidate.length) {
    return { ok: false, reason: "allocation-smaller-than-candidate" };
  }
  if (!deployed.subarray(0, candidate.length).equals(candidate)) {
    return { ok: false, reason: "candidate-bytes-differ" };
  }
  const padding = deployed.subarray(candidate.length);
  if (padding.length && !padding.every((byte) => byte === 0)) {
    return { ok: false, reason: "trailing-bytes-not-zero" };
  }
  return { ok: true, reason: "byte-identical-with-zero-padding", paddingBytes: padding.length };
}

module.exports = { deployedMatchesCandidate };
