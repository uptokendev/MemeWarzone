# ASK, Everglen and Legacy: read-only authority comparison

## Evidence source and limits

Read-only Solana mainnet comparison started `2026-09-09T20:51:28.865Z` (22:51 Amsterdam, 9 September 2026). All three account snapshots returned slot `445706122` and mainnet genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.

Run: https://github.com/uptokendev/MemeWarzone/actions/runs/34403513860
Job: `102640857750`.
Artifact: `10124396607` (`import-three-token-authority-readonly`).
Artifact ZIP SHA-256: `ebbcda13814a559178916cb41f630543011baa8e08524cb577f8b3a39b0a1ba0`.
MemeWarzone source inspected: `c0ce2e9ba4eac69fe3d8b5f6395a3a86f47e7b7e`.
Official Pump Fees IDL blob: `900a99fbaa528ea98ffa327cf25ff0359f5361c5`, Git blob SHA verified before decoding.

For each token the diagnostic derived its canonical Pump bonding-curve PDA, checked owning program, executable flag, discriminator and basic layout. For fee-sharing records it separately derived the canonical per-mint Pump Fees sharing-config PDA, checked its program owner, and decoded its SharingConfig discriminator/layout with the pinned official IDL.

No production database mutation, application change, signing, transaction, approval or deployment was performed. Diagnostic workflow/report changes exist only on the diagnostic branch. Original creation transactions, authority-change history, personal identity and wallet software/login history were NOT inspected. A fee recipient or revoked admin is not automatically a current project owner.

## ASK

Mint: `7AVB9viRcpmr8gRMTCAYSmhP7gbuBMpBR51DMjwcpump`.
Connected wallet from the reported incident: `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H`.
Curve: `6Bizh2PkwgfZGhJPQYvwqAMRfE6JjgEZB6YhzQAr4jdH`.
Curve complete: **true** (bonding completed; this flag alone does not certify migration or a current external pool).
Current curve creator field: `3cG2kAQ4NQfy4zN1g7pTYUUHSiCCMmECenBssYddBrS3`.
Creator address is on-curve; current resolver accepts it as a signing-wallet candidate.
Reported connected wallet does not match.
Canonical sharing config `3GzJCdZz8neZWSVjh6exfMHtPpEBS3mS6nJ4S22AigDK` was not found.

This explains the specific-wallet mismatch route. These observations do NOT establish whether 3cG2...BrS3 is accessed through an embedded Pump wallet, Phantom, Solflare or another client, or whether both wallets belong to the same person.

## Everglen / Glen

Mint: `FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump`.
Claimant: `3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD`.
Curve: `GDVdT3mgSdei4DhSqSmNpGXYe3kWgwPb2cSLXK6hJs5m`.
Curve complete: **false**. The token was still in its Pump bonding phase at this observation.
Current curve creator field: `B6FvqcmKR1Bzf4b4Nuf9WtViSu5VS3LQe73JEFMycVaN`.
This exactly matches the canonical per-mint Pump Fees sharing-config PDA. Account exists, is owned by `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`, has 1024 bytes, and decodes as an active version-2 SharingConfig for the exact mint.

Decoded relevant fields:
- admin: `3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD`.
- admin_revoked: **true**.
- shareholder 1: `3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD`, share_bps **8000**.
- shareholder 2: `G8nLmsiy7ExEkoAy9uLCmDzCVpT1w4saZLJk9cDSFUND`, share_bps **2000**.

Therefore the claimant has a proven on-chain association: stored fee-sharing admin (with admin permission revoked) and an 80% recipient of this creator-fee distribution. The 80% is NOT token supply or project equity. It is supporting ownership-review evidence, not proof of who signed original token creation and not an automatic current project-management grant.

Current resolver stops at the non-signable sharing-config address and returns project_creator_requires_manual_review. It does not follow/decode this fee-sharing record. The manual path is caused by unavailable ordinary-wallet authority, not by a successful claimant match.

## Legacy Coin

Mint: `2XnP5fdNbeBbBUX1sh4gKTJCM7zD1SoKX2QhEHudpump`.
Claimant: `2wsYUHLBo8Y7voFjLkwXFZFn7iayUmaXARtQTZkrNhYB`.
Curve: `BfgHLpQgcz15NXFQJ1cGCQ5XCFE2jUWupshNTn4jUzwF`.
Curve complete: **true** (bonding completed; pool migration not certified here).
Current curve creator field: `6AWAeVsT2VKUyFsBp1v1Eeo3AidUVHK3YyrMdco2hUu2`.
This exactly matches the canonical per-mint Pump Fees sharing-config PDA. Program owner, account discriminator/layout and decoded mint match. Account is an active version-2 SharingConfig.

Decoded relevant fields:
- admin: `Dgf92DhxENQsfbetPA2NhXUJr7RFJKHsPvyvGPjuacaX`.
- admin_revoked: **true**.
- sole shareholder: `GctpVwZB9dfm1KJdRWHitpswYGpMWXgmLKRMpDpbJVzL`, share_bps **10000**.

The claimant does not equal the stored admin or the listed recipient. This check therefore does not establish an association for that claimant. It is not a finding of fraud: other legitimate authorization/team/transfer evidence may exist and was not inspected.

The current resolver returns manual review because the creator field is a non-signable sharing-config PDA, not because the claimant passed ownership verification.

## Meaning and proposed next checks

All three tokens have authenticated Pump curve accounts. Being a Pump token does not require identical import outcomes. The decisive present distinction is a signing-wallet creator record versus a fee-sharing program account; bonding completion is a separate field.

Pump's official fee-sharing documentation describes replacing bonding_curve.creator with sharing_config. Its program documentation also distinguishes the token creation transaction user/signer from the assigned creator in some creation flows. Neither a fee recipient, a funder, nor an arbitrary transaction payer should silently become a verified MemeWarzone manager.

References:
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md
- https://solana.com/docs/core/pda

Recommended admin evidence: market phase, raw authority address and type, validated fee-sharing details, original creation evidence when available, current/ historical authority distinction, connected claimant, match/unavailable/mismatch reason, independent token-risk status, timestamp/slot, and signed project-management authorization when needed. Preserve original claim snapshots and operator audit; label fresh rescans as new evidence.

Scope references: Emergency Import-Only directive, Master Build & Launch Plan, Master Subsystem Reference, Live Launch State. Any ownership-model extension needs explicit product policy and focused tests; no automatic Pump-wide safety exemption or Arena/financial activation.
