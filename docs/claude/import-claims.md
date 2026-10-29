# Import ownership claims

A claim sets `project_owner_wallet` on `arena_token_imports`; that wallet gets the 0.50% import creator fee
(see payouts-and-rewards.md). Treat every change here as a money path.

## Who counts as the owner (verified 2026-10-29)

- EVM (BNB 56, Robinhood 4663), `projectImportEvmCreator.js`, used by both resolvers and the claim dialog:
  1. live `owner()`/`getOwner()` wins (wallet or contract), except four.meme TokenManager V2 `0x5c952063…` and the
     flap.sh portal `0xe2cE6a…`, which own a coin only while it bonds. Only a revert (`CALL_EXCEPTION`/`BAD_DATA`)
     means "no such method"; any other RPC error stops the check (review 2026-10-29: an RPC blip must never skip a live owner);
  2. the token's own `deployer()`/`creator()` when it is a wallet (founder 2026-10-09; it sat uncommitted in the main
     checkout until 2026-10-29) or a Safe (`evm_safe_deployer`). EIP-7702 EOAs (`0xef0100` + address) are wallets;
  3. the signing wallet that CREATE-deployed the token (nonce search, cap 20k, `evm_contract_deployer`);
  4. a creator proven by the token's creation tx (`verifyCreationTx`): direct deploy (receipt.contractAddress),
     four.meme `TokenCreate`, flap.sh `TokenCreated(ts, creator, nonce, token, …)` from the portal, Robinhood router
     `0x6319141D…` event, Robinhood launcher `0x0000FffF…` (createToken/multicall, full fixed supply minted in that tx).
     The creator must equal tx.from and be a wallet. Sources: pasted by the claimant (`evm_creation_tx`; the dialog
     links BscScan / Blockscout "Creator"), or automatic: four.meme via its API pointer (`getLogs`, else header-bloom
     scan, max 2 concurrent), Robinhood via the token's first mint (`getLogs` 10M spans, 4 in parallel, ~2 s).
  Transfer check (`projectImportEvmTransfer.js`, founder "yes with solid proof"): any authority above, including a live
  owner or a Safe, sends an exact 0.00001-0.0001 BNB/ETH to the claimant; the claimant pastes the tx hash. Stateless
  HMAC challenge (PROJECT_IMPORT_CHALLENGE_SECRET, else the X OAuth state secret), 30 min window, no table. A Safe is
  accepted via `execTransaction(to=claimant, value, data=0x, operation=0)` + `ExecutionSuccess`.
  `/authority` (unsigned) is rate-limited to 20/min per IP.
- A mismatch with a creator-type authority (Pump creator, DBC pool creator, mint creator) may still request manual review
  and may use the SOL transfer check (creator wallet sends an exact amount to the claimant). A live owner/mint authority
  mismatch may not.
- First case: HODL `6roVXGp6…nLeEp` (Clashpad, Token-2022, 3% transfer fee). Claimant `Hkh8Keb…hkdT` signed creation tx
  `5q24b3v1…DnNfUb` (initializeMint2 + mintTo + setAuthority revoke in one tx). Fixture: `frontend/api/lib/fixtures/hodl-mint-creation-tx.json`.

## X sign-in

- Official X: Solana reads Pump.fun metadata first, then the DexScreener profile (any launchpad). BNB/Robinhood: DexScreener only.
  X Community links are not accounts and do not count.
- Solana only: a DexScreener-sourced match verifies only if no on-chain creator is known or the claimant is that creator.
  Otherwise it is recorded as contact (`matchedListedX`, `onchainCreator`) and the claim goes to manual review
  (paid profiles and community takeovers can set DexScreener links).
- Every completed sign-in is written to `wm_admin_audit_log` (`target_type='project_ownership_claim'`, actions
  `x_signin_verified|x_signin_mismatch|x_signin_contact`, `after` holds wallet, X id, handle, expected handle). A repeat of
  the same wallet + X id + outcome within 10 minutes is skipped. The operator audit query excludes `x_signin_*` rows;
  `getProjectXSignins` reads them (50 newest).
- Manual review requires a mismatch/contact sign-in by the same wallet in the last 60 minutes; the note gets
  `Proven X: @handle (X id …)`. Older notes say `User: Contact X: …`: typed, not proven.

## Holder check and Meteora

- Holder concentration > 50% is critical (blocks import), 20-50% is review. Pool inventory is excluded only when it is
  verified on-chain custody. Pump curve / PumpSwap custody comes from the Pump evidence reader; for other Solana tokens
  the largest accounts owned by the Meteora pool authorities are custody:
  DBC `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` (program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`),
  DAMM v2 `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` (program `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, read
  on mainnet 2026-10-29; HODL's pool vault holds ~27% under it).
- BNB: a coin whose `owner()` is the flap.sh portal is `bonding` (platform `flapsh`), like four.meme (5 coins read 2026-10-29).
  Not detected yet (importable while bonding, market "unknown"): other Solana launchpads (LaunchLab/LetsBonk, Moonshot…),
  every Robinhood launchpad (`import_only` market). Founder asked 2026-10-29; recommended detecting per launchpad.
- A DBC pool for the mint that has not migrated (`isMigrated` 0) makes the market `bonding` (platform `meteora_dbc`), so
  the "return after graduation" rule applies like Pump.fun/Four.meme. Pool lookup: SDK `getPoolByBaseMint` (gPA, base
  mint at offset 136, checked on DAZILLA's pool). If it fails while a DBC vault holds supply, the check is retryable.

## Review tooling

- Command Center review page shows the on-chain creator + creation tx, the claimant's X sign-ins and the live
  official-X sources (`GET /api/project-imports/admin/ownership-claims/:id/sources`).
- Normal VERIFY needs a verified market; non-Pump Solana coins have `launch_platform_unverified`, so only Master Override
  can approve those by hand. With the mint-creator rule most of them no longer reach manual review.
- `.github/workflows/import-review-integration.yml` has failed on every PR since at least 2026-10-09; the server-mount
  script needs tables (`token_metadata_registry`, arena columns) its schema step does not create.

## Graduation hard rule (founder 2026-10-29)

"The whole battle system is designed for graduated tokens. So no tokens in bonding phase can be imported."
Default-deny for NEW projects (`requireProvenGraduation` in `projectImports.js`: POST /, `systemImportProject`, and
`/manual-claim` when it would create the project). Existing projects and claims on them are not affected.
`resolveProjectToken` carries `graduationProof` { proven, method | reason, retryable }.
- Solana Pump.fun: the curve's `complete` byte (offset 48, every layout incl. old 49-byte curves).
- Solana other (`readMeteoraImportEvidence` → `readSolanaPoolHoldings` + `verifySolanaPools` + `solanaGraduationProof`),
  hardened after review 2026-10-29 (owner fields are free, so "held by an AMM authority" alone proved nothing):
  refuse when bonding vaults (DBC unless migrated, LaunchLab `WLHv2UAZ…`) or any program-controlled holder we do not
  know (off-curve PDA, or owned by an unknown program; Streamflow/Jupiter Lock/Meteora vault are neutral) hold >= 1%.
  Proven only by a real pool: per-pool vaults (PumpSwap/Orca/CLMM/DLMM) whose owner pool account (owned by that
  program) records the vault and the mint; authority vaults (CPMM seeds ["pool_vault", pool, mint], DAMM v2
  ["token_vault", mint, pool], checked on SOAP/HODL) of a DexScreener-pointed pool that records both. Vault >= 0.1% of
  supply and the quote vault >= 1 SOL / 150 USDC|USDT|USD1. Raydium AMM v4 vaults never prove on their own.
  Pump branch only when the curve PDA is owned by Pump.fun (a lamport-funded PDA must not turn a token into "Pump").
- BNB: `bnbGraduationProof` (async). `postgrad` (four.meme registry) is proven. `dex_market` needs pool base reserve
  >= 0.1% of supply, WBNB >= 0.5 / USDT|USDC >= 150 on the quote side, and no owner()/deployer()/creator() contract
  (not a Safe or pool) holding >= 1%.
- Robinhood: refuse when a contract that is deployer()/creator() OR received minted supply (first 10 mints) still
  holds >= 1% (not the launcher, PoolManager, a Safe or a pool), or when ANY v4 pool with an unknown hook has
  liquidity. Proven by a v3 pool with liquidity, >= 0.1% of supply and >= 0.05 WETH / 150 USDG (`0x5fc5360D…`, 6 dp),
  or a hook-less / known-hook v4 pool with liquidity while the PoolManager holds >= 0.1%. Pool events are searched
  from the first mint on; v4 liquidity read in parallel: 3-8 s on the public RPC.
- Refusals are cached 5 min (Robinhood); POST / and /manual-claim are limited to 20/min per IP; a resolver or market
  outage answers "retry", never "not graduated". `isRevertError`: BAD_DATA counts only with value "0x".
- Known limits: a launchpad we do not list, whose curve sits in a wallet-like address, plus a funded side pool, still
  passes. Non-Pump Solana coins without a DexScreener pool pointer (e.g. NOISE's CPMM vault) cannot be proven.
- Audit 2026-10-29 of the 22 visible imports (`frontend/scripts/audit-import-graduation.mjs`): 21 graduated;
  Glen `FcBb7avR…pump` (the retained "Everglen" page) is still bonding on Pump.fun (17.78 SOL in the curve). Left as is.
