# Import review v1: release and operator contract

Source base: MemeWarzone main `c0ce2e9ba4eac69fe3d8b5f6395a3a86f47e7b7e`.
Production release branch: `release/live-import-20260910`.

## Release order

1. Review/test the exact release head against current `main`.
2. Apply the additive `20260909213428_project_import_review_evidence.sql` migration.
3. Apply the additive `20260910175500_project_import_pump_challenges.sql` migration.
4. Deploy compatible API first, then frontend, then dashboard.
5. Smoke-test real BNB and Solana import flows and confirm existing launchpad behavior is unchanged.

Both import migrations are additive. Rollback of application code may leave the evidence/challenge tables in place; do not delete evidence as a rollback mechanism.

## Separate authorities

Token identity, launch stage, project ownership and token safety are independent. Project ownership verification never grants Arena admission, trading, graduation, claims or financial authority.

Only a matching/proven project authority plus an eligible supported post-grad market plus passing safety checks permits automatic registration. Known external bonding blocks a new import. Unknown/unsupported market or safety evidence remains held for review rather than being guessed safe.

Manual ownership approval requires authenticated admin access, a current row version, fresh evidence, required image, and independently reviewable project-authorization evidence where automatic authority remains unresolved. REQUEST MORE INFORMATION and ESCALATE are audit actions; they do not approve or publish a project.

## Pump.fun ownership proof

Pump.fun can expose a creator wallet that differs from the wallet a user normally connects to MemeWarzone. A known Pump creator mismatch is therefore not treated as automatic project ownership, but it has a dedicated proof path.

MemeWarzone may issue a one-time 15-minute SOL transfer challenge bound server-side to the exact token, independently resolved Pump creator wallet, currently connected claimant wallet, exact lamport amount and expiry. The proof succeeds only when a finalized Solana transaction after challenge creation transfers the exact amount from the detected creator wallet to the connected claimant wallet. Used transaction signatures are unique and cannot be replayed.

This verifies control linkage between the Pump creator wallet and the connected claimant wallet. It does not certify token safety, liquidity, trading execution or Arena eligibility. MemeWarzone never receives the SOL; the transfer is from the user's Pump creator wallet to the user's connected wallet.

If the creator wallet can be connected directly, a signed wallet action remains the strongest automatic path. If neither direct signing nor the transfer challenge can be completed, manual review may use a fresh one-time project code posted from an established official project channel. Funding transfers, fee-share records, holders, arbitrary payers, screenshots alone, familiar names and social login are not ownership proof.

Never request, collect, log or store private keys or recovery phrases. Wallet-import help must direct users only to the original Pump.fun account and official wallet applications.

## Market and safety coverage

Solana coverage includes canonical Pump bonding curves and supported SOL-quoted PumpSwap pools. Actual funded reserves and virtual pricing reserves are kept separate. Virtual reserves are not counted as funded liquidity. Unsupported Pump modes, quotes or venues remain technical review.

BNB coverage authenticates supported Four.meme launch state and canonical PancakeSwap market identity. A recognized still-bonding token is rejected before independent pool discovery can create a false graduation signal. Direct-DEX/unknown-origin markets can require independent launch-history review rather than being auto-cleared.

Security evidence is fail-closed. Missing provider liquidity data is recorded as unavailable, not fabricated as zero. Known market custody can be excluded from holder concentration only when its identity is authenticated. Missing/failed checks never become a safety PASS.

## Evidence and admin review

Import evidence is stored in append-only `project_import_review_evidence`; rescans append snapshots and do not overwrite historical evidence or Arena scan state. The review dashboard must show enough evidence and a clear operator checklist so a non-developer reviewer can establish token identity, launch state, claimant authority, official project presence and unresolved safety signals before approving project-page ownership.

Legacy records with empty evidence are not reconstructed or silently approved. A claimant must refresh/sign a new observation when required.

## Product boundary

This is the Emergency Import-Only release. Imported project pages may expose project identity/profile/follow/share functionality where already supported, but Battles, Tournaments, MWL, Quarterly, Boost, Arena claims, imported-token trading, graduation and competition eligibility remain independently locked.

The release must support `PROJECT IMPORTS = ON` while `ARENA = OFF`.

## Authority

Reviewed against the current live repository, the MemeWarzone Master Build & Launch Plan — 8 Sep 2026, the Master Subsystem Reference — 8 Sep 2026, the Live Launch State — 8 Sep 2026, `emergencyimportonly.md`, and the latest explicit founder decisions in the launch-control chat. Repository runtime remains implementation truth; old SHAs and historical green runs are evidence only.
