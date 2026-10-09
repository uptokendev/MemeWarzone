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
can point at it by env. Built as `RobinhoodV3NativeSwapAdapterV2` (A.2).

### A.2 `RobinhoodV3NativeSwapAdapterV2`: audit of the diff against the live adapter (written 2026-10-08, before tests)

Founder go 2026-10-08. New file `contracts/integrations/RobinhoodV3NativeSwapAdapterV2.sol`; the live
`RobinhoodV3NativeSwapAdapter.sol` is not touched (its two interfaces are imported from it, so they are not declared
twice). ABI byte-identical to the old artifact (same functions, arguments, returns, events, `receive`), so the app only
swaps the address. 4,655 bytes deployed (old: 3,421). solc 0.8.24, the repo profile (viaIR, runs 1). Constructor
`(swapRouter, wrappedNative)`, both read from the live adapter by the deploy script.

Live instances it replaces (read-only `eth_call`, 2026-10-08): 4663 `0xDfd381EC…3296` (gen 6, the one the gen-7 scripts
reuse) and `0xffF3aFBC…C1DF` (gen 4), both `swapRouter = 0xCaf681a6…5cb2` (SwapRouter02), `wrappedNative =
0x0Bd7D308…AD73`; 46630 `0x116f9Bfe…7069` (gen 6b), router `0xDfd381EC…` (testnet SwapRouter, same address by nonce),
WETH `0x52A47A33…9670`. The older 46630 adapter `0x1BE64fC0…` predates the deadline argument (it has the 4/5-argument
selectors `0x60a79ac9` / `0x49f421fb`, not `0x1da7d616` / `0xbb592133`), so the current app ABI cannot call it at all.

The diff, line by line:

| # | Old | New | Why |
|---|---|---|---|
| D1 | buy: `require(WETH.balanceOf(this) == 0, "wrapped dust")` | `wrappedBefore` read before `deposit`; end check `== wrappedBefore` | 1 wei of WETH sent to the old adapter makes every buy revert. The check still proves the router spent the whole `msg.value` (a V3 swap that stops on a price limit leaves input behind; that still reverts) |
| D2 | sell: three exact-zero checks after the native send | `tokenBefore`, `wrappedBefore`, `nativeBefore` read before the pull; `token == tokenBefore` and `WETH == wrappedBefore` checked **before** the native send, `native == nativeBefore + amountOut` after the unwrap and before the send | One token unit sent to the old adapter bricks every sell of that token; forced native bricks every sell. Moving the checks ahead of the only untrusted external call is also stricter CEI |
| D3 | sell: `amountOut` = router's return value, unwrapped and paid | `amountOut` = WETH balance delta of the swap, `>= amountOutMinimum` checked on it ("insufficient output"); router return ignored | Pays exactly what arrived, measured by us. Equal to the router value for SwapRouter02 + WETH9 (the fork proof checks that) |
| D4 | sell: router swaps `amountIn` after `safeTransferFrom` | adds `require(balance delta == amountIn, "token in mismatch")` | With a donation sitting in the adapter, a fee-on-transfer token would otherwise let the router spend donated units. V3 pools reject fee-on-transfer input anyway (callback balance check), so no working sell is lost |
| D5 | - | buy and sell: `require(recipient != address(this), "invalid recipient")` | Old: a buy to the adapter strands the tokens there, which then bricks sells of that token (the D2 bug, self-inflicted). New: refused up front |

Unchanged: `nonReentrant` on both entry points; deadline, zero input, zero minimum out, `token != 0 && != WETH`, zero
recipient, zero fee checks with the same revert strings; router-level `amountOutMinimum` (kept, so a failing minimum
still reverts inside the router exactly as before); `forceApprove(router, exact)` then `forceApprove(router, 0)`;
`receive()` only from WETH; buy `amountOut` = router return (the pool's transfer, as the old event reported);
events and their field order; no owner, setter, rescue or upgrade.

Per function:

| Function | Guard | Order (CEI) | Reachable states | Over/underflow | Griefing |
|---|---|---|---|---|---|
| `buyExactNativeIn` | `nonReentrant` | checks -> read `wrappedBefore` -> `deposit` (WETH9, trusted) -> exact approve -> router swap (pool pays `recipient`; token transfer hooks run here) -> approve 0 -> `WETH == wrappedBefore` -> event | Any WETH / token / native already held (donations) is never read into an amount and never moved: the router's allowance is exactly `msg.value` and reset to 0 | none: no subtraction; `msg.value` deposit cannot overflow WETH | A donation no longer blocks anything. A malicious `tokenOut` can re-enter only into the guard (reverts) or call the router itself (the router pulls from its own `msg.sender`, never from the adapter). Partial fill reverts the caller's own trade |
| `sellExactTokenIn` | `nonReentrant` | checks -> read three start balances -> `safeTransferFrom(caller)` -> exact-amount check -> exact approve -> router swap to `this` -> approve 0 -> token back at start -> `amountOut` = WETH delta, `>= min` -> `withdraw(amountOut)` -> WETH back at start, native = start + `amountOut` -> pay `recipient` (the only untrusted call, last) -> event | Donated token / WETH / native are excluded from every amount and stay; `withdraw` unwraps only the delta | `balance - before` (token and WETH): balances can only fall below `before` if the adapter's own tokens leave, which needs an allowance it never grants on that asset in this call (token allowance = `amountIn`, consumed by the router; WETH allowance 0 during a sell); checked arithmetic reverts if a hostile token lies. `nativeBefore + amountOut` cannot overflow (bounded by WETH supply) | A recipient that reverts or re-enters only fails its own trade (re-entry hits the guard). A recipient that force-sends native during the payout changes nothing (no check after the send). A token whose `balanceOf` lies harms only its own traders. A donation no longer blocks anything |
| `receive` | - | - | accepts only WETH9 (the unwrap) | - | forced native (selfdestruct, coinbase) bypasses it: harmless now, it is never counted |
| constructor | - | - | non-zero router and WETH, immutable | - | - |

Informational (accepted, same as the old adapter): the event is emitted after the recipient call (both functions are
`nonReentrant`, so no re-entered state can be logged out of order); buy `amountOut` for a fee-on-transfer `tokenOut`
is the pool's output, not the recipient's receipt (the app quotes and sets the minimum on the pool output too).

Stuck funds: only donations and forced native, by design (no admin, as the old adapter). The adapter holds nothing of
any trader between calls. Residual trust: the immutable SwapRouter02 and WETH9, as before. Migration note: a trader's
token allowance is per adapter, so the first sell through V2 asks for a new approval (`ensureRobinhoodV3SellAllowance`
already checks the allowance against the route's adapter address).

## Results 2026-10-08 (CI1 script, CI2 / CI3 / CI4 fork proofs)

Nothing was sent to any public network. Forks are local anvil forks (BNB 56 at block 126453702, Robinhood 4663 at
83362798, BSC testnet 97 at 135601505) or the in-process hardhat fork (46630); the deployer `0x77F96A7d` and the Safe
`0x1edcEdf5` are impersonated; traders are throwaway wallets funded on the fork. Kyber was called read-only (quote +
build over HTTP); the built transactions ran only on the fork.

### CI1: `scripts/deploy-import-fee-vault.ts`

Deploys `RecruiterRewardsVault(admin)` as `ImportFeeVault`, records it, and sets operator + caps + unpause:
- 56 / 4663: admin = Safe; writes Safe batch IF1 `deployments/<bnb|robinhood>/mainnet.IF1-import-fee-vault.safe-batch.json`
  (`setOperator`, `setPayoutCaps`, `setPayoutsPaused(false)`; the first two simulated as the Safe, the third needs them)
  and the record `deployments/<dir>/mainnet.import-fee-vault.json`. Needs `CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_MAINNET`
  and an interactive terminal. The new vault's runtime code is checked byte for byte against the live recruiter vault
  (`0x40ac5cD7` on 56, `0xBd7EB35d` on 4663, both admin = Safe): **identical** on both forks (2,190 bytes).
- 97 / 46630: admin = the deployer (must be `0x77F96A7d`, as the gen-6 / gen-7 testnet records); the three calls are
  sent by the deployer and read back; `CONFIRM_IMPORT_FEE_VAULT=I_UNDERSTAND_TESTNET`.
- Operator: `IMPORT_FEE_PAYOUT_OPERATOR_<chainId>` is required; the existing payout operator
  `0xdcf07EB07e6D6722c246161e7530dc905F9eaA50`, the Safe, a contract and (mainnet) the deployer are refused.
- Caps (ether units): `IMPORT_FEE_MAX_PAYOUT_PER_TX_<chainId>` / `IMPORT_FEE_DAILY_PAYOUT_CAP_<chainId>`, defaults
  56: 2 / 10 BNB, 4663: 0.5 / 3 ETH (= the live recruiter vault's P1 caps), testnets 0.5 / 2. The protocol sweep also
  goes through `payout()`, so the daily cap must cover a full day of import fees. Measured volume: Robinhood
  `ProtocolRevenueVault` received **zero** `Deposit(from = Universal Router)` in blocks 77787156..83350031 (6.56 days);
  BNB could not be measured with free public RPCs (archive `eth_getLogs` refused); `finance_import_swap_fees` has the
  numbers. Revisit the BNB cap with that table before the mainnet batch.
- `IMPORT_FEE_DEPLOY_TOPAZ_ROUTER=1` (56 / 97) also deploys the unchanged `ImportSwapFeeRouter(wrapped = Topaz.weth(),
  vault, vault, 100, 0, v3 = 0, v2 = Topaz)` and reads every immutable back. 97 rehearsal: router on Topaz
  `0xa241AEd1` (30 bps, from `testnet.gen6.json`), factory `0xb9F2b64D`, mock WBNB `0xcd2c3492`.
- Rehearsal: `scripts/rehearse-import-fee-vault-fork.ts` (97 anvil fork and 46630 in-process fork both ran clean:
  vault open, operator and caps read back).
- `test/ImportFeeVault.spec.ts` (11): paused at deploy; Deposit from an EOA and from a contract; admin-only setters;
  unpause needs operator and both caps; operator-only payout; per-tx and daily caps inclusive; daily reset on the next
  UTC day; reverting receiver spends nothing; sweep to a `ProtocolRevenueVault` lands as its `Deposit(from = vault)`;
  admin withdraw; script refusals; IF1 encoding; local deploy + resume without a second vault.

### CI2: BNB Kyber (`test/importFeeVault.bnb-kyber.fork.spec.ts`)

Quote and build through `importSwap.js`'s own handlers with `IMPORT_SWAP_FEE_BPS=100` and
`IMPORT_SWAP_FEE_RECEIVER_56 = <fork vault>` set in-process. `assertBscRouteTerms` accepts the 100 bps / vault terms
(explicit and env defaults) and refuses 50 bps.

| Coin (route) | Side | Amount | Vault `Deposit` (from = Kyber router `0x6131B5fa`) | Check |
|---|---|---|---|---|
| TST `0x86Bb94Dd` (pancake) | buy | 0.1 BNB in | 1,000,000,000,000,000 wei | = 1% of the input, exactly one Deposit |
| TST | sell | 2,099,192,418,686,193,719,623 tokens | 491,680,893,088,786 wei | gross 49,168,089,308,878,676 = wallet 48,676,408,415,789,890 + fee; fee = gross * 100 / 10,000 |
| Mubarak `0x5C85D6C6` (pancake-v3) | buy | 0.1 BNB in | 1,000,000,000,000,000 wei | = 1% |
| Mubarak | sell | 521,847,726,949,246,644,392 tokens | 489,891,089,812,257 wei | gross 48,989,108,981,225,777; fee = gross * 100 / 10,000 |

Then the operator swept half the vault to the real `ProtocolRevenueVault 0xc2d4E6f8` with `payout()`: one
`Deposit(from = ImportFeeVault)` of exactly that amount.

### CI3: Robinhood Universal Router (`test/importFeeVault.rh-ur.fork.spec.ts`)

`robinhoodImportSwap.mjs` hard-codes 50 bps, so the 100 bps call is built from its exported pieces; the test proves it
equals the module's own `encodeImportBuy` / `encodeImportSell` output (feeReceiver = vault) except the PAY_PORTION bps
word and, on sells, the SWEEP minimum derived from it. Token HOODFUN `0xfbeD2D06` (1% WETH V3 pool `0x4FbA3580`):

| Side | Amount | Vault `Deposit` (from = UR `0x88767899`) | Check |
|---|---|---|---|
| buy | 0.01 ETH | 100,000,000,000,000 wei (1%) | tokens 7,787,668,178,826,216,118,046,671 = QuoterV2(0.0099 ETH); that minimum passes, + 1 reverts `V3TooLittleReceived` |
| sell | 3,893,834,089,413,108,059,023,335 tokens | 48,714,200,579,085 wei | gross 4,871,420,057,908,597 = QuoterV2; wallet 4,822,705,857,329,512 = gross - fee; SWEEP min = that passes, + 1 reverts `InsufficientETH` (min-out checked after the fee) |

SPY `0x117cc213` (the live rehearsal's stand-in) passes the same proof (buy fee 100,000,000,000,000; sell gross
4,945,054,796,289,333, fee 49,450,547,962,893). Sweep to the real `ProtocolRevenueVault 0x632061cA` with `payout()`
lands as one `Deposit(from = ImportFeeVault)`. The Universal Router held 0 ETH before and after each swap.

### CI4: `ImportSwapFeeRouter` on Topaz (`test/ImportSwapFeeRouter.bnb-topaz.fork.spec.ts`)

Router deployed by the CI1 script unchanged (100 / 0 bps, both receivers = vault, v3 off). Each side compared with a
direct Topaz swap from the same EVM snapshot:

| Pool | Side | Amount | Vault `Deposit` (from = router) | Recipient |
|---|---|---|---|---|
| Airo `0x019078cA` / WBNB `0x01D7023d` | buyV2 | 0.05 BNB | 500,000,000,000,000 | 4,306,109,699,848,024,373,017,220 tokens = direct Topaz swap of 0.0495 BNB |
| Airo | sellV2 | 2,153,054,849,924,012,186,508,610 tokens | 247,439,125,182,894 | 24,496,473,393,106,586 wei = gross 24,743,912,518,289,480 (direct Topaz) - fee |
| TOPAZ `0xdf002282` / WBNB `0x29EFe69c` (deepest) | buyV2 | 0.05 BNB | 500,000,000,000,000 | 23,984,949,276,820,194,714,785 tokens = direct of 0.0495 BNB |
| TOPAZ | sellV2 | 11,992,474,638,410,097,357,392 tokens | 240,923,894,915,735 | 23,851,465,596,657,773 wei = gross 24,092,389,491,573,508 - fee |

Exactly one Deposit per swap (creatorBps 0 sends nothing to the second receiver); `ImportSwap` fields as listed in
A.1 (venue 2, feeCreator 0); minimum = the exact output passes, + 1 reverts `InsufficientOutput`; router holds no BNB,
token or WBNB after; `buyV3` reverts `VenueNotConfigured`.

### Regression

`npx hardhat test test/ImportSwapFeeRouter.spec.ts $(ls test/evmgen7-*.spec.ts | grep -v fork) test/ImportFeeVault.spec.ts`
plus the three fork specs without a fork network: 151 passing (22 + 118 + 11), 10 pending (the fork specs skip).

Run the fork proofs:

    anvil --fork-url https://bsc-mainnet.public.blastapi.io --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
    npx hardhat test test/importFeeVault.bnb-kyber.fork.spec.ts test/ImportSwapFeeRouter.bnb-topaz.fork.spec.ts --network bscForkRehearsal
    anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8646 --accounts 0 --no-rate-limit
    npx hardhat test test/importFeeVault.rh-ur.fork.spec.ts --network robinhoodForkRehearsal

## Results 2026-10-08: `RobinhoodV3NativeSwapAdapterV2` (A.2)

Nothing was sent to any public network; the live adapter source file is unchanged.

Unit tests `test/RobinhoodV3NativeSwapAdapterV2.spec.ts` (13, on `MockImportV3Router` + `MockWETH9`, plus one parity case
on the Uniswap-V3 math mock of the old spec): ABI byte-identical to the old artifact; buy / sell exact amounts and
events; min-out exact passes, + 1 reverts (buy and sell); deadline second passes, + 1 reverts; zero input / minimum,
token 0 or WETH, zero or self recipient, zero fee refused; `receive()` only from WETH; 1 token unit + 1 wei WETH + 1 wei
selfdestruct-forced native do not brick two rounds of buys and sells and stay untouched; **regression: the old adapter
under the same donations reverts "token dust" (sell), "native dust" (sell), "wrapped dust" (buy)**; re-entry through a
token hook on buy and on sell hits the guard and the outer trade completes; a reverting recipient fails only its trade;
a fee-on-transfer sell reverts "token in mismatch" and the parked donation is untouched; old vs new on the V3 math mock
return the same buy and sell amounts.

Fork proof `test/RobinhoodV3NativeSwapAdapterV2.rh.fork.spec.ts` (3; in-process fork of 4663 at block 83530593, V2
deployed by the script below from the live adapter's immutables). Each pair from the same EVM snapshot:

| Coin | Pool | Side | Live `0xDfd381EC` | V2 |
|---|---|---|---|---|
| HOODFUN `0xfbeD2D06` (import) | `0x4FbA3580`, 1% | buy 0.01 ETH | 7,865,687,985,461,411,824,609,708 tokens | same |
| HOODFUN | | sell all of it | 9,801,801,840,205,701 wei | same (WETH delta == router return) |
| MWZRH `0x3765d716` (gen 6, graduated on the fork: factory impersonated for `setRequireAuthorizedTrading(false)`, one buy to the 6.1375 ETH target, `graduate()`) | `0x8589E849`, 0.3% | buy 0.05 ETH | 459,330,763,200,050,210,138,336 tokens | same |
| MWZRH | | sell all of it | 49,701,838,463,854,776 wei | same |

Then 1 token unit donated to both adapters: live sell reverts "token dust" on both coins; V2 sells (HOODFUN
1,966,421,996,365,352,956,152,426 tokens -> 2,465,426,811,122,418 wei; MWZRH 114,832,690,800,012,552,534,583 tokens ->
12,512,587,375,747,857 wei) and keeps the unit. HOODFUN also: + 1 wei WETH -> live buy reverts "wrapped dust", V2 buys;
+ 1 wei forced native -> live sell reverts "native dust" (separate case without a token donation), V2 sells; V2 ends
holding exactly the three donations. No gen-6 coin has graduated on 4663 yet (the gen-6 factory has one campaign), so
MWZRH graduated on the fork is the only real gen-6 pool available.

Deploy `scripts/deploy-robinhood-swap-adapter-v2.ts`: constructor args read from the live adapter (4663 `0xDfd381EC`,
46630 the gen-6b record's `0x116f9Bfe`, `RH_SWAP_ADAPTER_V2_SOURCE` overrides), which must carry the deadline selectors
(`0x1BE64fC0` on 46630 is refused: "has no buyExactNativeIn with a deadline"). 4663 needs
`CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_MAINNET` and an interactive terminal; 46630 `I_UNDERSTAND_TESTNET` and the
deployer `0x77F96A7d`. Record `deployments/robinhood/<mainnet|testnet>.native-swap-adapter-v2.json` (rehearsals under
`deployments/fork-rehearsal/`); a re-run resumes. Rehearsed on the in-process 4663 fork (inside the fork spec) and
46630 fork (`hardhat.rh-gen7-testnet-fork.config.ts`: router `0xDfd381EC`, WETH `0x52A47A33`, 4,655 bytes).

    CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_TESTNET npx hardhat run scripts/deploy-robinhood-swap-adapter-v2.ts --network robinhoodTestnet
    CONFIRM_RH_SWAP_ADAPTER_V2=I_UNDERSTAND_MAINNET npx hardhat run scripts/deploy-robinhood-swap-adapter-v2.ts --network robinhoodMainnet
    npx hardhat --config hardhat.rh-fork.config.ts test test/RobinhoodV3NativeSwapAdapterV2.rh.fork.spec.ts

App switch: `VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_<chainId>` on the APP service (build-time). Set: the
direct-native Robinhood V3 path (`robinhoodV3Trade.ts` `resolveRobinhoodV3Route`, used by RobinhoodWarRoomTradePanel,
and `arenaImportedRobinhood.ts`, used by ImportedTradePanel's adapter path) trades through V2; unset or empty: today's
`VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS[_<chainId>]`, looked up exactly as before
(`frontend/src/lib/robinhoodNativeSwapAdapterEnv.mjs`). Chain-suffixed only. The app still checks the adapter's
`swapRouter()` / `wrappedNative()` against the market route; a trader's first V2 sell asks for a new token approval.
The 4663 imported-coin default path (Universal Router, `robinhoodImportSwap.mjs`) is not affected.

## Every BNB venue (founder 2026-10-08: "if it can't be traded on Topaz, it should be traded on Pancake or anywhere else it has its pool")

Facts (2026-10-08): KyberSwap lists 185 BNB sources (`ks-setting.kyberswap.com/api/v1/dexes?chain=bsc`), including
`topazdex-v2` / `topazdex-v3` (Topaz router `0x1E98c822` uses canonical WBNB `0xbb4CdB9C`), `uniswap` / `uniswapv3` /
`uniswap-v4*`, `thena*`, `biswap`, `babydogeswap`. The old Kyber request named the five PancakeSwap ids only, so a
Topaz-only coin (Airo `0x019078cA`) got `route not found` although Kyber routes it. The restriction (commit `5628a348`)
gave no reason beyond "PancakeSwap-only hops"; its intent, every hop a public on-chain pool, is kept by
`KYBER_BSC_POOL_SOURCES` in `frontend/api/importSwap.js`: an explicit allow-list of AMM pool ids (exact match per hop in
`assertBscRouteTerms`), no RFQ / PMM / prop-AMM / order book / limit order / lending-backed / stable / wrapper / bridge
sources. The fee checks are unchanged (bps, `isInBps`, charge side, receiver = the vault, router pinned).

Also fixed: Kyber answers "no route" with HTTP 400 code 4008 / 40011, which reached the app as a plain 422 without
`IMPORT_SWAP_NO_ROUTE`, so the Topaz fee-router fallback (CI4) never ran on 56. Those two codes now map to
`IMPORT_SWAP_NO_ROUTE`; an outage or a bad request does not.

Fork proof (`test/importFeeVault.bnb-kyber-venues.fork.spec.ts`, anvil fork of 56 at 126495251, importSwap.js's own
handlers, 1% to a fork ImportFeeVault, one `Deposit` from the Kyber router per swap, buy = 1% of the BNB in, sell = 1%
of the gross BNB out): Topaz V2 (Airo, the API's own source list), Topaz V3 (TOPAZ), Uniswap V2 (CAKE), Uniswap V3
(TST), Uniswap V4 (TST), THENA (THE), Biswap (BSW), BabyDogeSwap (CAKE), BabyDoge (own list, routed via PancakeSwap):
9 passing. Finding: the BabyDoge token's sell on its BabyDogeSwap pair reverts through Kyber ("Call failed"; the buy
passes); token-specific, CAKE on BabyDogeSwap passes both ways.

Not covered: coins still on a launchpad bonding curve. Four.meme is not a Kyber source; `flap`, `genius-fun`,
`loong-fun`, `printr` are listed but Kyber answered 40011 for every probe. Project imports refuse bonding coins
(`PROJECT_IMPORT_STILL_BONDING`), so this only matters for arena imports of a coin that has not graduated.

## Import payout operators (founder, 2026-10-08)

New dedicated keys, one per chain, set as `IMPORT_FEE_PAYOUT_OPERATOR_<chainId>` for `scripts/deploy-import-fee-vault.ts`
(they become `setOperator(...)` in Safe batch IF1). Read on chain 2026-10-08: plain wallets (no code), nonce 0, not
`0xdcf0…`, funded for gas.

| Chain | Operator | Gas at check |
|---|---|---|
| BNB 56 | `0xCB83b1297E4198e37bBf050eE9Cb6E87E8252aD1` | 0.008 BNB |
| Robinhood 4663 | `0x03F9deC9961033c0CaA7a66373B004D36D375e83` | 0.002 ETH |

Their private keys go only into Coolify (indexer: `IMPORT_FEE_PAYOUT_OPERATOR_PK_56` / `_4663`). Caps: the defaults
(BNB 2 per payout / 10 per day, ETH 0.5 / 3), founder-approved 2026-10-08.

## Swap-widget partners on BNB / Robinhood (founder, 2026-10-09)

Swaps through a partner's swap widget split the 1% as 0.50% creator / 0.25% partner / 0.25% protocol. No
contract change and no second vault: every fee, partner swap or not, still lands in the chain's one
`IMPORT_FEE_VAULT_<chainId>`. The finance cron attributes a fee row to a partner (`partner_id`, `partner_raw`
on `finance_import_swap_fees`) from the build-time fingerprint of the swap transaction (other session).

The EVM payout worker (`realtime-indexer/src/importCreatorFeesEvm.ts`), mirroring the Solana worker's order:

1. resolve `sending` rows (all kinds, unchanged), expire, then creators (unchanged);
2. partners: for every `import_fee_partners` row of the chain (read with `select *`, only `id`,
   `payout_wallet`, `active` used; inactive partners are still paid what they earned, as on Solana; no
   table yet means no partners), due = `sum(partner_raw)` of this vault's rows minus that partner's
   `partner` transfers from this vault in `sending` / `landed`. One `payout(payout_wallet, amount)` per
   partner per pass, amount = min(due, `maxPayoutPerTx`, the vault's daily room, balance), at least
   `IMPORT_PARTNER_MIN_PAYOUT_WEI_<chainId>` (default = the creator minimum). Same checks as a creator:
   EVM address, not our own wallet, not held by moderation, not a contract. Stored as `kind = 'partner'`,
   `partner_id`, `from_address` = the vault, `sending` with the hash and nonce before the broadcast; the
   resolver is the creator one (receipt, `Payout` events, same-nonce re-send). A failed transfer drops out
   of the paid sum, so the due comes back by itself. `payoutsPerPass` counts creators and partners;
3. protocol sweep: due = `sum(fee_raw - creator_raw - partner_raw)` of this vault's rows (rows with
   `creator_raw > 0 or partner_raw > 0`) + expired creator halves - sweeps; only in a pass that paid no
   creator and no partner.

There is nothing to consolidate on EVM (the Solana `consolidate` kind moves partner WSOL accounts into the
collector; EVM has one receiver). Nothing changes in the CREATE / BUY / SELL paths, the routers or the API
build.
