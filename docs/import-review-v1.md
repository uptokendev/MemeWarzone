# Import review v1: release and operator contract

Source base: MemeWarzone main c0ce2e9ba4eac69fe3d8b5f6395a3a86f47e7b7e.
Companion: uptokendev/web-dashboard, base 593829411ea8a0d9544b5219b8846edd3586007b.

## Release order (not applied by this PR)

1. Independently review and test this exact head and the companion dashboard head.
2. Apply `supabase/migrations/20260909213428_project_import_review_evidence.sql` through the approved deployment/migration process. It was generated with Supabase CLI migration-new and is additive; no existing row or Arena state is rewritten. The API database role needs access; public/anon/authenticated Data API clients intentionally do not.
3. Deploy the API, then frontend, then dashboard. A new dashboard requires the new API/evidence schema. Missing evidence is not an approval. Rollback to previous application code can leave the additive evidence table intact; never delete evidence to roll back.
4. Complete real-wallet, image storage and admin acceptance. CI wallet transports and image endpoints are mocked; PostgreSQL is disposable. No live approvals or transfers are performed by tests.

## Separate decisions

Token identity, launch stage, project authority and token safety are independent. Every saved snapshot identifies exact token/chain, claimant, source, policy, timestamp, optional slot and signature receipt. It is generated on the server after existing nonce/signature checks, never supplied by the client. Admin rescans append observations and retain the original signature receipt; they cannot invent missing legacy signatures.

Only a matching signable authority plus a verified supported funded post-grad market plus passing security permits automatic new registration. Known bonding is rejected before new registration or manual claim. Unknown launch stages/pools and failed technical checks remain held; the standard reviewer cannot waive them. Confirmed critical risks cannot be waived through VERIFY PROJECT OWNER. Review warnings remain separate from ownership evidence.

The server authenticates admin requests, locks the current project row, requires expected row version and exact evidence id, rejects stale checks, retains the image requirement and writes an audit atomically with approval. Unresolved ownership additionally requires a reference to independently reviewed project-management authorization. An operator typing a reference is an audited human decision, not a new cryptographic proof; operators must actually inspect the referenced evidence.

REQUEST MORE INFORMATION and ESCALATE record audit follow-ups. They do not send email, chat, or in-app notifications. Operators use existing support channels. Neither action changes ownership or publishes the project.

## Initial coverage and deliberate limits

- Existing BNB and Solana token validity and signature checks are preserved.
- On-chain market-stage/custody verification in this release supports canonical Pump bonding curves and standard SOL-quoted, non-mayhem/non-boost PumpSwap index-zero pools. Curve completion alone never verifies a pool or swap execution.
- Other launch platforms, BNB market-stage adapters, older alternative venues, non-SOL quotes and unsupported Pump modes remain **technical review / no automatic clearance**. This is intentionally conservative; review this coverage impact before deployment. Do not describe the release as universal market support. New adapters require independent source evidence and tests.
- Fee-sharing records are authenticated against exact mint-derived PDA, owner program, discriminator, version, mint and allocation. Recorded admins (including revoked admins) and recipients are displayed as relationships, never automatically used as project managers.
- Original creation/authority-transfer history and third-party embedded-wallet authentication are not added here. Funding wallets, holders, arbitrary payers and social login are not ownership proof. Micro-transfer linking is not implemented.
- Public imported pages remain inert. No trading, Battles, claims, graduation or Arena admission is enabled. Rechecking stage at actual Battle admission remains an explicit integration requirement for the future full release; ownership verification must never be used as an admission flag.

## Everglen exception

Keep existing project de2321a6-3314-45e5-8114-48cedbd50213, Solana mint FcBb7avR9LgmgwFxRcVJDiroZxZfgvtnUJrRKQ7kpump, image and existing approved owner unchanged. The UI identifies it only if that exact existing row is already verified. It is a page-only exception, never a fresh-import or Battle/trading exemption. No production database update is part of this PR.

## Evidence and scanner corrections

GoPlus default_account_state: 0=uninitialized/review, 1=initialized, 2=frozen/blocked. Missing values are unknown. Custody exclusions require exact mint, token account and owner authenticated on chain. Other holder concentration remains evaluated; accounts are not assumed independently controlled. Missing DEX fields mean unavailable provider data, not zero liquidity. Security failure/unknown never becomes PASS.

Dedicated append-only evidence does not use or overwrite Arena scan_json. UPDATE/DELETE are rejected by a trigger. RLS is enabled with no public policies. Legacy `{}` is explicitly missing; rescanning does not rewrite historical audits. Preserve all existing decisions.

## Pump.fun help and key safety

Guides are optional; use the original Pump account and official wallet apps. Never collect, convert, log, upload or request private keys/recovery phrases in MemeWarzone. Compare full public wallet addresses. Signing with the imported creator wallet proves control of that address, not fee-sharing authority, token safety or Battle eligibility. A program-controlled sharing account has no importable key.

Official sources checked 9 September 2026:
- https://github.com/pump-fun/pump-public-docs (layouts/seeds pinned to 9c82f61cb711b044a17f770ab8ce9f9bdf78f333)
- https://docs.gopluslabs.io/reference/response-detail-1
- https://docs.gopluslabs.io/reference/response-details
- https://help.phantom.com/articles/how-to-import-a-privy-wallet-into-phantom-41408635409683
- https://intercom.help/pumpfun-web/en/articles/13644291-how-to-export-seed-phrase-or-private-key-on-the-mobile-app
- https://help.solflare.com/en/articles/6462529-how-to-import-a-wallet-using-a-private-key-on-solflare-mobile

## Project authorities and preserved changes

Reviewed against Emergency Import-Only, Master Build & Launch Plan (8 September), Master Subsystem Reference (8 September), and Live Launch State (8 September). Latest founder decisions restrict new external bonding imports and retain Everglen page-only. Historical outage logs are not new runtime evidence. CORS, connection settings, economics, contracts and integration branch are out of scope.

Open PR #274 overlaps the import UI/feedback/browser tests. Its image-only recovery and invalid-address improvements are incorporated here and retested; do not replay that older UI patch blindly. This PR does not merge/close #274 automatically.
