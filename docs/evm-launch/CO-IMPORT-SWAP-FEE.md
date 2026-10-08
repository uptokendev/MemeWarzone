# Change order CO-IMP: 1% fee on imported-coin swaps, half to the creator (BNB + Robinhood)

Issued 2026-10-08 (founder decisions of the same day). **Revision 2, same evening, read this first.** Revision 1
said Robinhood imports pay no fee and asked for a new fee-router contract on every venue. That was read from an old
branch. On the live branch (`build/cross-chain-stabilization-rh-base`) BNB and Robinhood already take the import fee
inside the swap (Kyber on BNB, Uniswap's Universal Router on Robinhood), so **the main BNB and Robinhood paths need no
new contract.** The router already written under revision 1 (`contracts/integrations/ImportSwapFeeRouter.sol`, audit
in A.1) is kept for the venues that have no fee-taking router: BNB Topaz-only imports (CI4) and possibly DogeOS.
Applies to `build/evm-gen7`; wire it before step 4 (testnets 97 / 46630). DogeOS:
`docs/build_plans/DogeOS/DOGEOS_FULL_INTEGRATION_PLAN.md` C-D11 / P9.

Imports are a separate path from the launchpad. **Nothing in CREATE / BUY / SELL, `LaunchCampaign*`, the factories or
the launchpad adapters changes.**

## 1. Decisions (founder, 2026-10-08)

| # | Decision |
|---|---|
| I1 | Every import swap pays **1%** of the native side, split **50/50**: 0.50% to the protocol wallet (`ProtocolRevenueVault`), 0.50% to the coin's creator |
| I2 | The whole 1% is taken in the swap to **one receiver** and **split afterwards**, never inside the trader's transaction (same model on every chain, Solana included) |
| I3 | The creator's half accrues for **every** import, claimed or not. Claimed = `arena_token_imports.ownership_status = 'ownership_verified'` with `project_owner_wallet` |
| I4 | Each accrual waits **90 days** (rolling, per trade); older accruals expire **to the protocol wallet** |
| I5 | Paid **automatically** to the verified owner once the claim is **7 days** old and the balance is above about **$5**; native coin; no manual check at any size |
| I6 | No widget bonus: widget swaps split 50/50 like the rest |
| I7 | Unclaimed coins show on the coin page what the creator has earned, with the existing claim button |
| I8 | The 1% lands in a new **`ImportFeeVault`** per chain = the **unchanged `RecruiterRewardsVault` bytecode** (admin = Safe). It holds both halves until the split. A **new dedicated payout operator key** (not `0xdcf0…`) moves money out with the capped `payout(to, amount)`; the Safe only sets operator and caps |

## 2. Facts (live branch, checked 2026-10-08)

- BNB 56: `frontend/api/importSwap.js` builds KyberSwap routes (PancakeSwap pools only) with `extraFee` 50 bps in BNB to
  `ProtocolRevenueVault 0xc2d4E6f8…` (`IMPORT_SWAP_FEE_BPS`, `IMPORT_SWAP_FEE_RECEIVER_56`).
- **BNB fallback without a fee:** when Kyber has no route (`IMPORT_SWAP_NO_ROUTE`), `ImportedTradePanel.tsx` trades the
  coin's Topaz pair directly through `arenaImportedTopaz.ts`, with no platform fee.
- Robinhood 4663: `frontend/src/lib/robinhoodImportSwap.mjs` runs Uniswap's Universal Router `0x88767899…` with
  `PAY_PORTION(ETH, IMPORT_SWAP_FEE_RECEIVER_4663, 50)` to `ProtocolRevenueVault 0x632061cA…` (buy: before the swap,
  sell: after the unwrap). Testnet 46630 keeps the fee-less adapter route.
- Every fee transfer is already read from the chain into `public.finance_import_swap_fees` (one row per transfer,
  with `token_address`, `wallet`, `side`) by `frontend/api/lib/financeImportSwapFees.js` every 5 minutes
  (cron:finance-snapshots). EVM rows are `Deposit` events on the receiver with `from` = the router.

## 3. Shared parts, built on the live branch (`feat/import-creator-fees`), not by this change order

Build on these; do not build a second ledger:
- Migration `db/migrations/20261008_000020_import_creator_fees.sql`: `finance_import_swap_fees.creator_raw` (the
  creator's half of a row; 0 for rows paid to the old 0.5% receivers), `import_creator_fees` (one row per creator
  accrual: `waiting` / `paying` / `paid` / `expired`, `expires_at`), `import_fee_transfers` (every payout and
  protocol sweep: sign, store, send, resolve).
- The revenue lane counts only `fee_raw - creator_raw`.
- `importSwapFeeSources()` takes several receivers per chain, each marked `split` (the new 1% receiver) or not (the
  old 0.5% receiver, 100% protocol).
- API `GET /api/imports/creator-fees` and the coin-page notice for all chains.
- Solana: the 1% collector key and the worker that splits, expires and pays.

## 4. This change order (BNB + Robinhood)

| # | Change | Notes |
|---|---|---|
| CI1 | Deploy `ImportFeeVault` on 56, 4663, 97, 46630: `RecruiterRewardsVault` bytecode, `admin` = the chain's Safe (testnets: as today). Safe batch: `setOperator(<new import payout operator>)`, `setPayoutCaps(perTx, daily)`, `setPayoutsPaused(false)` | No new bytecode. Caps sized so normal days never queue; they only bound a stolen operator key (I5). A monitor alerts when a cap was hit so the Safe raises it as volume grows |
| CI2 | BNB: Kyber `feeAmount` 100 bps, one receiver = `ImportFeeVault` (`IMPORT_SWAP_FEE_BPS_56=100`, `IMPORT_SWAP_FEE_RECEIVER_56=<vault>`). `assertBscRouteTerms` keeps checking every fee field | Prove on a BSC fork: a buy and a sell pay exactly 1% to the vault |
| CI3 | Robinhood: `robinhoodImportSwap.mjs` `PAY_PORTION` 100 bps to `ImportFeeVault` (bps and receiver from one place; the app and `scripts/rehearse-robinhood-import-swap.mjs` share the module) | Command list unchanged, only bps and receiver. Re-run the fork rehearsal: 1% to the vault, min-out still checked after the fee |
| CI4 | BNB Topaz-only imports: **no import swap without the fee.** Route the Topaz fallback through `ImportSwapFeeRouter` (A.1) with its fee going to `ImportFeeVault`; until that router is audited and deployed, show "No PancakeSwap route for this coin" instead of the fee-free Topaz trade | Router adaptation for revision 2: one receiver (`ImportFeeVault`) at 100 bps, or both receivers set to the vault; the ledger reads its vault `Deposit`s (from = router) like Kyber's |
| CI5 | `financeImportSwapFees.js` sources: add `ImportFeeVault` as a `split` receiver on 56 / 4663 with payers Kyber router, Universal Router and (CI4) `ImportSwapFeeRouter`; keep the old `ProtocolRevenueVault` receiver for history | Old rows stay 100% protocol |
| CI6 | EVM payout worker (mirror of the Solana worker, same tables): every minute resolve sends; pay verified owners whose `waiting` rows sum >= minimum and whose claim is >= 7 days old, in chunks <= `maxPayoutPerTx`, the rest past `dailyPayoutCap` queued to the next UTC day; mark rows `paying` with the transfer id **before** sending; daily, mark rows past 90 days `expired` and send the protocol half plus expired creator fees to `ProtocolRevenueVault` with `payout(vault, amount)`. Key `IMPORT_FEE_PAYOUT_OPERATOR_PK_<chainId>` | Idempotent: before re-sending, read the vault `Payout` events for that transfer. Dry run until `IMPORT_FEE_PAYOUT_SEND=true` |
| CI7 | Fee chip shows the fee from the quote (`feeBps`), not a hard-coded label | Shared with Solana (`importSwap.ts`, done on the live branch) |

Open: Robinhood v4 pools (most new Robinhood pools are v4; imports support v3 only today), out of scope.

## 5. Steps (each needs a founder go)

1. CI1 on testnets 97 / 46630; CI2, CI3 and CI5 as fork tests (Kyber and the Universal Router are mainnet only); CI6.
2. With gen-7 step 4: testnet run of the vault, ledger rows with `creator_raw` = half, a payout to a test owner after
   the hold, an expiry sweep.
3. Mainnet: vault deploy + Safe batch, then the env switch (bps 100 + receiver) in the same release window.
4. CI4 router: finish tests and audit (A.1), then deploy; until then the Topaz fallback is off.

## Appendix A: `ImportSwapFeeRouter` (written under revision 1)

Needed only where no aggregator or router takes the fee: BNB Topaz-only imports (CI4) and DogeOS if MuchFi has no
Universal Router with `PAY_PORTION`. Revision-1 shape: two immutable receivers with `protocolBps` / `creatorBps`. Under
revision 2 both halves go to `ImportFeeVault`; either simplify to one receiver (smaller audit) or deploy with both
receivers = the vault (two `Deposit`s per swap, both read by CI5).

### A.1 Internal audit of the router as written under revision 1 (kept unchanged) (contract written 2026-10-08, `contracts/integrations/ImportSwapFeeRouter.sol`)

New file; no existing contract changes. 7,193 bytes deployed. solc 0.8.24, same profile as the launchpad.

Facts read from mainnet bytecode before writing (read-only `eth_getCode`, selector search):
- Topaz router `0x1E98c822…` (BNB) is Solidly-style: routes are `(from, to, stable, factory)`; it has
  `swapExactETHForTokensSupportingFeeOnTransferTokens` (0x3da5acba) and
  `swapExactTokensForETHSupportingFeeOnTransferTokens` (0x12bc3aca), `weth()`, `defaultFactory()`.
- Robinhood SwapRouter02 `0xCaf681a6…` has the 7-field `exactInputSingle` (0x04e45aaf, no deadline in the struct),
  the same one `RobinhoodV3NativeSwapAdapter` calls.

Deviations from section 3, each deliberate:
1. **V2 = Topaz's Solidly routes**, not Uniswap V2 paths. The factory is fixed at deploy (`v2Router.defaultFactory()`,
   so a caller cannot route through a factory of their choosing); `stable` is a call argument (`buyV2(token, stable, ...)`,
   `sellV2(token, stable, ...)`). The constructor checks `v2Router.weth() == wrappedNative`.
2. **Balance deltas, not "zero left over".** Every amount is a delta and the end-of-call checks compare with the
   balance at the start of the call. The exact-zero checks of `RobinhoodV3NativeSwapAdapter`
   (`token.balanceOf(this) == 0`, `address(this).balance == 0`) let anyone brick sells of a token forever with a
   1-unit donation (no rescue path). Here a donation is ignored and stays where it is.
3. Router-level `amountOutMinimum` is 0; the minimum is enforced by this contract on the recipient's delta (buys) and
   on the native after fee (sells), which is the stricter check the change order asks for.

Per function (reentrancy, CEI, reachable states, over/underflow, griefing):

| Function | Guard | Order | Notes |
|---|---|---|---|
| `buyV3` / `buyV2` | `nonReentrant` | validate (deadline, value, min, token, recipient) -> fee split -> swap `msg.value - fee` to the recipient -> leftover check (wrapped / native back to the start level plus the fee) -> min-out on the recipient's token delta -> pay protocol, then creator -> event | `fee > 0` required (dust cannot trade fee-free). A reverting fee receiver reverts the trade (receivers are ours). A malicious token can re-enter only through the guard (reverts) or lie in `balanceOf` (only harms that token's own traders; the fee is still paid on `msg.value`) |
| `sellV3` / `sellV2` | `nonReentrant` | validate -> pull `amountIn`, `received` = delta -> exact approve -> swap `received` to this -> approve 0 -> `gross` = wrapped delta (unwrapped) / native delta -> token balance back to the pre-pull level -> fee on `gross` -> min-out on `gross - fee` -> pay recipient -> pay fees -> event | Recipient paid before the fees; a recipient that re-enters hits the guard; one that reverts only fails its own trade. Native accepted only from `wrappedNative` and `v2Router` (`receive`) |
| `feeSplit` | view | - | `fee = x*(p+c)/1e4`, `creator = x*c/1e4`, `protocol = fee - creator` (rounding to protocol). `x*100` cannot overflow for any native amount |
| constructor | - | - | non-zero wrapped and receivers, `p + c` in `(0, 100]`, at least one venue, `chainid` recorded. No owner, no setter, no rescue |

State: none between calls. Stuck funds: only donations (by design, no admin). Attribution: `ImportSwap` is the
only on-chain source for the creator ledger (CI4); `nativeGross` is `msg.value` on buys and the swap's native out on
sells, `tokenAmount` is the recipient's delta on buys and the tokens that actually arrived on sells.

**Finding on a live contract (not changed here):** `RobinhoodV3NativeSwapAdapter` (live, used for imports and
post-graduation trading on Robinhood) ends every sell with `require(token.balanceOf(this) == 0)` and
`require(address(this).balance == 0)`. One unit of a token sent to it makes every later sell of that token revert;
forced native (selfdestruct) bricks every sell. No rescue path exists. Mitigation: a new adapter instance; the app
can point at it by env.
