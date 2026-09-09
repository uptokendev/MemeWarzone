# Everglen import review: observed evidence and required corrections

Investigation only. No application source, production row, approval, Arena state or integration branch changed by this investigation.

## Exact sources

- MemeWarzone main inspected: `c0ce2e9ba4eac69fe3d8b5f6395a3a86f47e7b7e`.
- web-dashboard main inspected: `593829411ea8a0d9544b5219b8846edd3586007b`.
- Token: `FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump` (Everglen / Glen).
- Project: `de2321a6-3314-45e5-8114-48cedbd50213`.
- Claimant/registrar: `3ZMWQiR7YauYYmdHPs8Qr1bLZZbtvnPeobhDvjR7VbkD`.
- Read-only public evidence run: https://github.com/uptokendev/MemeWarzone/actions/runs/34402090248 . Job `102636173711`, artifact `10123867410` (`everglen-read-only-import-evidence`).
- Artifact ZIP SHA-256: `9906861d3c2d1cc8d48bbb202cbbeb62dba6cfab528beea2ce9794378239abb7`.
- Public scan started `2026-09-09T20:37:26.657Z`. This is a NEW observation, not a reconstruction of the original request's full evidence.

## 1. Default account state is incorrectly classified

Live GoPlus result: `default_account_state: "1"`, `freezable.status: "0"`, `mintable.status: "0"`.

Solana account read at slot `445703487`: canonical Token-2022 program, initialized mint, mintAuthority null, freezeAuthority null. Parsed extensions: metadataPointer and tokenMetadata. No defaultAccountState extension in the returned parsed list.

Official GoPlus documentation https://docs.gopluslabs.io/reference/response-detail-1 defines state 0 = uninitialized, 1 = initialized, 2 = frozen.

Current `frontend/api/lib/projectImportRiskSecurity.js` checks `=== "1"` for `default_frozen`. Executing the actual classifier reproduces state 1 -> BLOCKED and state 2 -> PASS in a fixture with no other risk flags. This both falsely flags initialized tokens and misses frozen state in this specific check. Correct the enum and add behavioral tests; unknown data must not be interpreted as a security clearance.

## 2. The flagged top holder is authenticated Pump curve custody

GoPlus top holder:
- account `GDVdT3mgSdei4DhSqSmNpGXYe3kWgwPb2cSLXK6hJs5m`
- token_account `8h5hUHuTo3wtw3BtyMs6Ank5EUMyNy4CSVe72inom4gd`
- percent `0.4056` (40.56%)
- balance `405593860.088722`

The first account exactly equals the mint-derived canonical Pump bonding-curve PDA. Its owner program is the canonical Pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; its discriminator/layout validates. The token account read confirms the requested mint, its owner is that curve PDA, and state is initialized.

Current concentration code takes `holders[0].percent` without differentiating authenticated market custody from wallet holdings. Thus this specific 40.56% is curve inventory, not evidence that the claimant controls 40.56%. GoPlus reports the claimant separately at 1.44%; the next listed non-curve account is 19.32% (its ultimate controller was not investigated).

Separate authenticated curve/pool custody from holder concentration, then evaluate the remaining holders. Never exempt accounts based solely on a tag, address suffix or user assertion. These observations are not an overall safety verdict or an independence assessment of other holders.

## 3. Missing DEX data is being presented as no liquidity

The successful GoPlus response for this exact token contains no `dex` or `lp_holders` property. Current code converts missing `dex` into an empty array and emits `no_dex_liquidity`.

The mint-derived Pump curve exists and reports complete byte 0 (not graduated). Dexscreener independently returned a `pumpfun` market with the same exact curve/pair address and requested mint, plus 24-hour buys and sells, but no liquidity value in this response.

This proves the present label is not a verified zero-liquidity finding. Distinguish unavailable provider data, a verified pre-graduation bonding market, and a verified empty/absent graduated pool. No executable liquidity capacity or slippage/sell simulation was certified here.

## 4. Ownership manual review is separate from those false/misleading risk labels

Current curve creator bytes decode to `B6FvqcmKR1Bzf4b4Nuf9WtViSu5VS3LQe73JEFMycVaN`, but `decodePumpProjectCreator` returns null. The validated layout passes the length/discriminator/owner/complete-byte checks; the resolver excludes creators that are not ordinary on-curve signing keys. The actual resolver returns:

```json
{
  "currentAuthority": null,
  "authoritySource": null,
  "authorityEvidenceAccount": "GDVdT3mgSdei4DhSqSmNpGXYe3kWgwPb2cSLXK6hJs5m",
  "ownershipReason": "project_creator_requires_manual_review"
}
```

The account's exact higher-level purpose, any fee-sharing arrangement, original creator history and authorization from that history were not independently established. Do not replace this result with a guessed owner, funding wallet or fee recipient. Keep ownership review independent of risk-label correction.

## 5. Review evidence is not saved into the field read by the dashboard

`frontend/api/lib/projectOwnershipReview.js` maps `ownershipEvidence` from `row.scan_json`, an Arena scanner field. `frontend/api/projectImports.js` records a short `manual_claim_note` but does not persist the complete `{resolved, security}` response there or in a separate import-evidence field.

The live project and original ownership-decision audit both have `{}` for that evidence. The dashboard renders any truthy `ownershipEvidence`, including `{}`, so the intended no-evidence explanatory message is skipped.

Required correction: a dedicated server-generated, versioned, timestamped import/claim evidence snapshot, bound to project identity and claimant, including authority source/result/reason, raw relevant provider values, interpreted risks and market context. Return it through the admin API, render useful fields with a raw-data expansion, and show an explicit missing-snapshot state for legacy records. Preserve audit history; a new rescan must not masquerade as the missing historical snapshot. Do not repurpose or overwrite Arena scan_json.

## 6. Current persisted state and normal fields

Read-only project query at `2026-09-09 20:34:21.673934+00` found ownership_verified and an image_url. The existing operator audit shows verify_owner at `2026-09-09 20:32:39.767636+00` (22:32:39 Amsterdam), assigning the claimant as the verified project-page owner. This approval was not performed by this investigation.

The prior audit snapshot preserves the original note: `System: automatic ownership unavailable, security:default_frozen, security:holder_concentration_high, security:no_dex_liquidity.` The original evidence snapshot remains `{}`.

Before approval, the same claimant/registrar and a blank verified owner are normal. `Current verified owner` is the MemeWarzone project-page owner, not necessarily the chain's creator record. Arena status remains `scanning`, which is a separate stored value and not proof of an active import-security scan. Ownership verification does not establish token safety, Arena admission, trading approval or graduation eligibility.

## Scope

References: Emergency Import-Only directive; Master Build & Launch Plan (8 September 2026); Master Subsystem Reference (8 September 2026); Live Launch State (8 September 2026). Current repository/runtime evidence controls exact implementation state; old SHAs and outage logs are historical. Preserve manual review, image retention, signed authorization, audited operator decisions, and isolation from Arena/trading/economics. No blanket Pump.fun safety exemption.
