# Import ownership claims

A claim sets `project_owner_wallet` on `arena_token_imports`; that wallet gets the 0.50% import creator fee
(see payouts-and-rewards.md). Treat every change here as a money path.

## Who counts as the owner (verified 2026-10-29)

- EVM (BNB 56, Robinhood 4663), `projectImportEvmCreator.js`, used by both resolvers and the claim dialog:
  1. live `owner()`/`getOwner()` wins (wallet or contract), except four.meme TokenManager V2 `0x5c952063…`, which only
     holds ownership while a coin bonds (graduated four.meme coins have a renounced owner);
  2. the token's own `deployer()`/`creator()` when it is a wallet (founder 2026-10-09; that change sat uncommitted in
     the main checkout until 2026-10-29). EIP-7702 EOAs (code `0xef0100` + address) count as wallets;
  3. a known launchpad's creation record, verified on chain (founder 2026-10-29 "automate BNB and Robinhood"):
     - four.meme: API `four.meme/meme-api/v1/private/token/get/v2` gives `userAddress` + `createDate` as a pointer;
       proof = successful tx from that wallet to TokenManager V2 with a TokenManager `TokenCreate` naming this token and
       creator == tx.from. Mainnet 2026-10-29: creation lands 2-30 s after createDate; scan window -10 s..+120 s,
       max 240 blocks; 4-7 s uncached. BSC public RPCs refuse getLogs, hence the block scan.
     - Robinhood launchpad router `0x6319141D…`: first mint tx sent to the router, router log topic0 `0x01937e4c…`,
       topic1 = creator = tx.from, data word 0 = token.deployer(). First mint found with getLogs in 10M-block spans.
  Not automated (X / manual review): Uniswap-style launcher `0x0000FffF…` (no creator event), Safe-deployed coins
  (THC: Safe 3 owners threshold 1), BNB coins with a renounced owner outside four.meme. Blockscout is behind a
  Cloudflare challenge, so explorer APIs are not used. A mismatch with a creator source may go to manual review.
- Solana: Pump curve creator -> live on-curve mint authority -> **Meteora DBC pool creator** (`virtualPool.creator`)
  -> **mint creator** (founder 2026-10-29: "if the wallet that is connected created the mint it should auto approve").
  Mint creator = fee payer (signer, on-curve, not the mint) of the mint's oldest successful transaction, which must
  contain exactly one `initializeMint`/`initializeMint2` for this mint (top-level or inner) that set **that same wallet
  as the initial mint authority**. That excludes relayer-paid, launchpad-CPI and multisig creations (security review
  2026-10-29). Only when the mint authority is revoked; a PDA mint authority gets no mint-creator fallback. History is
  read 5 x 1000 signatures at most (`MINT_CREATOR_MAX_PAGES`), longer stays manual. Positive results cached per process.
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
