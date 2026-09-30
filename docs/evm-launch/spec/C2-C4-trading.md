# C2-C4: anti-sniper fee, creator first buy, creator buy escrow

Spec for `EVM_LAUNCH_GENERATION_PLAN.md` C2, C3 and C4. Line numbers are for `68941587`.
Solana reference: D11, D12, D14 (`docs/dbc/DBC_BUILD_PLAN.md`) and `frontend/shared/dbcEconomics.mjs:50-70`.

## 0. Constraint that comes before everything: bytecode

`LaunchCampaign` compiles to **24,575 bytes deployed, 1 byte under EIP-170**. That is measured from the
current artifact, with `runs: 1` and `viaIR` already on (`hardhat.config.ts:154-155`), and the source
says the same (`LaunchCampaign.sol:888-894`). C2-C4 add about 1.5-2.5 KB. Nothing in this spec fits
unless the new implementation drops code. See open question Q1.

## Today (facts)

- There is one fee rate, `protocolFeeBps` (200), charged on the native amount:
  `_fee` (`LaunchCampaign.sol:783-786`). Buys add it on top: `total = costNoFee + fee`, bounded by
  `maxCost` (`:537-541`). Sells take it out: `payout = gross - fee`, bounded by `minPayout`
  (`:583-587`). The quotes use the same `_fee` (`:372, :385, :402`). The whole fee goes to
  `routeTrade{value: fee}` (`:813`), and the router splits `msg.value` proportionally
  (`TreasuryRouterV3.sol:430`). The factory caps `protocolFeeBps` at 1000 (`LaunchFactory.sol:623`).
- `launchAt` is the create block's timestamp for an immediate coin, or the scheduled time
  (`LaunchCampaign.sol:324-326`, `LaunchFactory.sol:424`). Trading reverts `TradingNotOpen` before it
  (`:642-644`). A scheduled launch must be 5 min to 30 days ahead (`LaunchFactory.sol:839-840`).
- The trade actor is `msg.sender`, and the signature binds it: the digest contains `actor`
  (`LaunchCampaign.sol:857`), called with `msg.sender` (`:459, :474, :490`). `creator` is the
  factory's `msg.sender` and never changes (`:319`, `LaunchFactory.sol:477`). `owner()` starts as
  the creator (`:302`) but can be transferred.
- The creator's buy lock and cap: `buyer == creator` reverts `CreatorBuyLocked` before
  `creatorBuyLockUntil` and caps `creatorBoughtWei` at `creatorBuyCapWei` (`:627-631`). Those values
  are `launchAt + creatorBuyLockSeconds` and the tier cap (`LaunchFactory.sol:451, 457`;
  `CreatorRegistry.sol:146-173`: 24 h / 6 h / 1 h and 0.25 / 1 / 3 native).
- The create functions are not `payable`, and the factory has no reentrancy guard
  (`LaunchFactory.sol:52, 351-420`). Stock and quote campaigns are configured *after* the clone is
  made, and `configureStockGraduation` requires `sold == 0` (`:388-389`, `BnbBasicLaunchFactory.sol:116`,
  `LaunchCampaign.sol:357`).
- Before graduation the token moves only from or through the campaign (`LaunchToken.sol:42-55`).
  Graduation burns by accounting (`curveSupply - sold`, `liquiditySupply - used`), never by balance
  (`LaunchCampaign.sol:754-758`, `BnbQuoteLaunchCampaign.sol:162-165`,
  `RobinhoodStockLaunchCampaign.sol:177-180`).

## C2. Anti-sniper fee

**Constants:** `ANTI_SNIPER_START_BPS = 5000`, `ANTI_SNIPER_WINDOW = 60`. The init reverts if
`protocolFeeBps > ANTI_SNIPER_START_BPS`, a backstop that the factory's 1000 cap already implies.

**tradingStart = `launchAt`.** No new storage is needed.

```solidity
function currentTradeFeeBps() public view returns (uint256) {
    uint256 end = uint256(launchAt) + ANTI_SNIPER_WINDOW;
    if (block.timestamp >= end) return protocolFeeBps;
    uint256 left = end - block.timestamp;   // 1..60 while trading; >60 only before launchAt (view)
    if (left > ANTI_SNIPER_WINDOW) left = ANTI_SNIPER_WINDOW;
    return protocolFeeBps + (ANTI_SNIPER_START_BPS - protocolFeeBps) * left / ANTI_SNIPER_WINDOW;
}
```

With a base of 200 this is `5000 - 80 * elapsed`, exactly: 5000 at 0 s, 4600 at 5 s, 2600 at 30 s,
200 at 60 s. That is Solana's 60 one-second periods (`dbcEconomics.mjs:59-62`,
`dbcAntiSniper.test.mjs:6-10`). The division is exact (4800 / 60 = 80), so nothing is rounded.

- `_fee(x)` becomes `x * currentTradeFeeBps() / MAX_BPS`. Every buy, sell and quote path goes through
  it, so `buyExact*`, `sellExact*`, the `*Authorized` variants and `quoteBuyExactTokens`,
  `quoteBuyExactBnb` and `quoteSellExactTokens` change together and agree within a block. A new
  `_feeAt(x, bps)` serves the first buy (C3). **The fee applies to buys and sells**, the same as
  DBC's fee scheduler (E2).
- **The trader stays bounded.** `maxCost` and `minPayout` checks are unchanged. The fee never goes up
  over time. So a transaction that lands later than it was quoted pays the same fee or less: an
  exact-token buy costs less, an exact-native buy gets more tokens, and a sell pays out more. Only
  curve movement can trip slippage, as it can today.
- The whole fee goes through `routeTrade`, anti-sniper part included, and the router splits it by the
  profile (`TreasuryRouterV3.sol:430`). No new event: `TokensPurchased.cost` and `TokensSold.payout`
  already carry the fee-inclusive amounts. The indexer derives the bps from the block time.

## C3. Creator first buy at create

**Factory.** Add OZ `ReentrancyGuard`. Every `create*` function becomes `payable nonReentrant`.
`CampaignRequest` gains `uint256 firstBuyTokens` and `uint256 firstBuyMaxCost`, and both enter
`_hashCampaignRequest` (`LaunchFactory.sol:848-860`), so the route authority signs the amount on
every create path (native, scheduled, stock, BNB quote). New step, run **last** in each public create
function (after `configureStockGraduation` / `configureQuoteCatalogBinding`):

```
if (req.firstBuyTokens == 0) { if (msg.value != 0) revert FirstBuyValueWithoutAmount(); return; }
cost = campaign.quoteCreatorFirstBuy(req.firstBuyTokens);        // costNoFee + 2%
if (cost > req.firstBuyMaxCost) revert Slippage();
if (msg.value < cost) revert InsufficientValue();
campaign.creatorFirstBuy{value: cost}(req.firstBuyTokens);        // tokens to `creator`
if (msg.value > cost) _send(msg.sender, msg.value - cost);         // last line; reverts on failure
```

**Campaign.** Add `creatorFirstBuy(uint256 tokens) external payable onlyFactory nonReentrant`.
It reverts in these cases:

- `FirstBuyClosed` if `totalBuyVolumeWei != 0`. That counter only increases (`:602`), so this is a
  once-only window that closes forever at the first buy of any kind.
- `FirstBuyTooLarge` if `tokens > totalSupply * CREATOR_FIRST_BUY_MAX_BPS / MAX_BPS` (1000, 10%).
- `QuoteMismatch` if `msg.value != costNoFee + _feeAt(costNoFee, protocolFeeBps)`.
- `FirstBuyReachesTarget` if, after the buy, `netRaisedWei >= graduationNativeTarget()`. An oracle
  revert propagates, so this fails closed.

It skips `_requireTradingOpen`, launch protection and the tier cap. It does call
`_assertWalletCanTrade(creator)`. It then runs `_recordBuy(creator, …)`, which pays the tokens to the
creator unlocked, routes the fee with the signed `tradeRouteProfile` (`:838-841`), and emits
`TokensPurchased(creator, tokens, total)` and then `CreatorFirstBuy(creator, tokens, costNoFee, fee)`.
It does **not** call `_autoFinalizeIfEligible`, and it does **not** write `launchAt`.

**Why it cannot move or bypass tradingStart for others.** `launchAt` is written only in `_initialize`
(`:324`), and `currentTradeFeeBps` reads only `launchAt`. For a scheduled coin the creator gets their
allocation early, but the tokens cannot leave the wallet (`LaunchToken.sol:52`), and a sell hits
`TradingNotOpen` until `launchAt`. On an immediate coin, anyone in the same block after the create
pays 5000 bps.

## C4. Creator buy escrow (replaces the lock)

**Identity.** A buy is the creator's when `buyer == creator`, where `buyer` is `msg.sender`, the
signed actor. The factory relay exists only for C3. Remove `creatorBuyLockUntil`, the
`InitParams.creatorBuyLockUntil` field and `CreatorBuyLocked`. **Keep** `creatorBuyCapWei` and
`creatorBoughtWei` unchanged (`:629-630`). The first buy does not count toward the cap.
`CreatorRegistry` stays as deployed, and the new factory ignores `creatorBuyLockSeconds`.

**Design: cumulative checkpoints, the exact per-buy schedule.** Every creator buy of `a` tokens at
time `s` releases `a/5` at `s + 30d + 7d·k` for k = 0..4. That is Solana's per-buy Jupiter escrow
(D12). Sum it over buys and it becomes:

```
Cum(x)    = total escrowed by creator buys with timestamp <= x
vested(t) = ( Σ_{k=0..4} Cum(t − 30 days − 7 days·k) ) / 5        (floor; a term with t < offset is 0)
claimable = vested(now) − creatorEscrowClaimed
```

- **Storage:** `Checkpoints.Trace208 _creatorEscrowCum` (OZ 5.x; key `uint48` timestamp, value
  cumulative tokens; one entry per buy block, since same-timestamp buys overwrite the last entry) and
  `uint256 creatorEscrowClaimed`. That uses the slot freed by `creatorBuyLockUntil`, so the layout
  grows by one slot. The clones are not upgradeable, so there is no layout migration.
- **Buy:** in `_recordBuy`, when `buyer == creator`, the tokens stay in the campaign and
  `push(uint48(block.timestamp), latest + amountOut)` runs. Emits
  `CreatorBuyEscrowed(creator, amountOut, block.timestamp)`.
- **Claim:** `claimCreatorEscrow() external nonReentrant returns (uint256 amount)`. It reverts
  `NotCreator` unless the caller is `creator`, and `NothingToClaim` if the amount is 0. It updates
  `claimed += amount` before `safeTransfer(creator, amount)` and emits `CreatorEscrowClaimed`.
  Views: `creatorEscrowTotal()`, `creatorEscrowVested(uint256 t)`, `creatorEscrowClaimable()`.
- **Gas:** each claim does 5 `upperLookupRecent` calls and 1 write. The cost is independent of how
  much has been claimed or how many steps have passed, and grows only as log₂ of the creator's own
  buy count. Only the creator can add entries, and each one costs a server signature, 2% (or more)
  and the tier cap. 10⁶ dust buys means 20 iterations per lookup. Nobody else can grief it.
- **Rejected alternatives:** a per-buy tranche array costs O(n) per claim. A single aggregate that
  restarts on each top-up is O(1), but it re-locks older tokens, which is not D12. A weighted-average
  start releases part of a new buy before its 30 days.

## Audit block

| | `creatorFirstBuy` + factory create | trade fee (C2) | escrow buy | `claimCreatorEscrow` |
|---|---|---|---|---|
| Guard | factory `nonReentrant` + campaign `nonReentrant` | existing `nonReentrant` on every entry (`:447-491`) | same | `nonReentrant` |
| CEI | campaign: checks, then `sold`/`netRaised`/`totalBuyVolume`, then token and router. Factory: refund is the last line | unchanged order (`:537-549`, `:583-595`) | checkpoint written before the router call and before auto-finalize | `claimed +=` before transfer |
| States | only inside create, `totalBuyVolumeWei == 0`, cannot reach the target | trading open; not launched, not PENDING (`:533-534`, `:578-579`) | same as a buy | any state: before graduation, PENDING, graduated, paused (vested tokens are owed; pause stops trading, not debts) |
| Overflow | `tokens ≤ 1e26`; cost ≤ `_area(curveSupply)` ≤ ~5e53 (`MAX_PRICE_SLOPE`, `MAX_TOTAL_SUPPLY`) | `x · 5000 ≤ 2.5e57` < 2²⁵⁶; `5000 − base` cannot underflow (base ≤ 1000) | `Cum ≤ 1e27 < 2²⁰⁸`; `uint48` time | `Σ5 Cum ≤ 5e27`; `claimed ≤ vested` |
| Griefing | nobody can buy before it: the campaign does not exist earlier in the transaction, and later buys close it. A refund to a rejecting creator only fails their own create | a sniper pays 50%; a validator or sequencer that skews time by s seconds changes the fee by 80·s bps inside the window only. BSC: ~0.75-3 s blocks, many blocks share a second. Robinhood (Orbit sequencer, ~0.1 s blocks): the sequencer sets the time. Worst case, a sniper pays less, and users stay bounded by `maxCost`/`minPayout` | creator only; bounded as above | pays only `creator`; nobody else can call it or block it |

### As built (branch `claude/evm-core`), audit block updated to the code

Files: `contracts/LaunchCampaign.sol` (all three campaign kinds inherit it), `contracts/LaunchFactory.sol`,
`contracts/BnbBasicLaunchFactory.sol`, `contracts/token/LaunchTokenDeployer.sol`.

| Path | Guard | CEI order as built | Reachable states | Overflow | Griefing |
|---|---|---|---|---|---|
| factory `create*` (payable) | factory `nonReentrant` (OZ `ReentrancyGuard`) on all five public creates | verify signature -> eligibility -> oracle range check -> clone + init -> `setCampaignChoice` on the router's vault -> quote/stock/binding config -> `_creatorFirstBuy` last; inside it: view quote, `creatorFirstBuy{value: cost}`, refund `msg.value - cost` to `msg.sender` as the very last call, reverting the create on failure | live, not paused, create not paused | `cost <= msg.value` checked before the subtraction | a rejecting refund receiver only fails its own create (tested); value sent without `firstBuyTokens` reverts, so the factory never keeps native |
| `creatorFirstBuy` | `onlyFactory` + campaign `nonReentrant` | checks (`totalBuyVolumeWei == 0`, `0 < tokens <= 10% supply`, `tokens <= curveSupply`, `costNoFee*1e4 <= nativeTarget*5000`, exact `msg.value`) -> risk check -> `_recordBuy` (volume, raise, buyers, sold, then token transfer to creator, then `routeTrade{fee}`) | only inside create; `launchAt` untouched; skips trading-open and the tier cap | `tokens <= 1e26`; `costNoFee * 1e4 <= ~2.7e24` | the oracle is read (revert fails the create closed); the cap is 50% of the live native target, not "cannot reach target", so it can never graduate the coin at create (E8, C5 §8) |
| trade fee (C2) | existing `nonReentrant` on every entry | `_fee` = `x * currentTradeFeeBps() / 1e4`; `quoteBuyExactBnb` computes the bps once per call | trading open, not Pending, not launched | `x*5000 <= 2.5e57`; `5000 - base` safe: init refuses `protocolFeeBps > 5000` | as in the table above |
| escrow buy (C4) | same as a buy | cap check -> volume/raise/sold -> `Checkpoints.Trace208.push(uint48(now), latest + amount)` -> `routeTrade` -> refund -> Pending check | creator (`creator`, the signed actor) buying through any path except the first buy | `Cum <= 1e27 < 2^208`; the `uint208` cast is safe by the supply cap | creator only; each entry costs a signature, the fee and the tier cap |
| `claimCreatorEscrow` | `nonReentrant` | `claimed += amount` then `safeTransfer(creator)` | every state including paused, Pending and Graduated | `sum of 5 Cum <= 5e27`; `creatorEscrowVested(t)` clamps `t - offset` to `uint48.max`, so any `t` is safe | pays only `creator`; nobody else can call it |

Deviations from the text above, all deliberate:
- The first-buy limit is `costNoFee <= 50% of the native target` (C5 §8), which implies "cannot reach the target".
- The factory relays the first buy through a view quote (`quoteCreatorFirstBuy`) and the campaign re-checks the
  exact value, so the factory never holds native between calls.
- `CreatorRegistry` is unchanged; the factory ignores `creatorBuyLockSeconds` and keeps `creatorBuyCapWei`.
- E7: launch protection, `_feeSplit`, the non-strict routing branches, `leagueReceiver/leagueFeeBps/strictFeeRouting`
  and the `pendingNative` fee escrow are removed from the campaign; the unsigned entry points stay, closed while
  `requireAuthorizedTrading` (default on). LaunchToken's creation code moved to `LaunchTokenDeployer` (the campaign
  mints its supply right after, and `mint` is `onlyOwner`, so a token not owned by the campaign cannot pass init).

## Invariants (fuzz)

1. `currentTradeFeeBps() ∈ [base, 5000]`, non-increasing in time, `== base` from `launchAt + 60`.
2. Every buy satisfies `total ≤ maxCost` and every sell `payout ≥ minPayout`. Each router call carries
   `fee == ⌊x·bps/10⁴⌋`.
3. `creatorEscrowClaimed ≤ creatorEscrowVested(now) ≤ creatorEscrowTotal()`. Vested is monotone in
   `t` and equals the total from `lastBuy + 58d` onward.
4. For each buy, `vested(s + 30d − 1)` includes none of its tokens (checked against a per-buy
   reference model).
5. Before graduation:
   `token.balanceOf(campaign) == (curveSupply − sold) + liquiditySupply + creatorReserve + (escrowTotal − escrowClaimed)`.
6. The first buy happens at most once, at 200 bps, at ≤ 10% of supply, and `launchAt` is unchanged.
7. The factory's native balance is unchanged after any create.

## Tests (`test/LaunchCampaign.AntiSniper.spec.ts`, `…FirstBuy.spec.ts`, `…CreatorEscrow.spec.ts`)

- The fee at 0/1/5/30/59/60/3600 s, for immediate and scheduled coins, on buys and sells, with quote ==
  execution in the same block. A buy quoted at t=5 and mined at t=40 costs less and passes `maxCost`.
  Router `msg.value` == fee on the anti-sniper part too.
- A sniper in the create block pays 5000 bps. A scheduled buy before `launchAt` reverts.
- First buy: 0 tokens with value (revert), exactly 10% (ok), 10% + 1 wei (revert), overpay refunded
  to the wei, `firstBuyMaxCost` too low (revert), a rejecting refund receiver (the create reverts),
  a first buy that would hit the target (revert), a changed amount against the signature (revert
  `InvalidRouteAuthorization`), each create path including stock and BNB quote, a scheduled coin whose
  first buy lands before `launchAt` with the sell still refused, and the flat 2% fee in the create
  block. A direct call to `creatorFirstBuy` by a non-factory, or a second call, reverts.
- Escrow: the creator's wallet delta is 0; `vested` is 0 at +30d−1s, 20% at +30d, 100% at +58d; two
  buys 10 days apart match the reference model at every step boundary; several buys in one block
  make one checkpoint; claims after graduation work; the stranger and zero-claim cases revert; the
  tier cap still reverts `CreatorBuyCapExceeded`; the first buy is not escrowed and not capped.
- A reentrant router or receiver mock on each path.
- Bytecode: every campaign implementation stays ≤ 24,576 bytes (asserted in a test).

## For C5 (graduation author)

- Escrowed tokens are inside `sold` and sit in the campaign. Graduation must keep burning **by
  accounting** and never burn or pool `balanceOf(this)`. Invariant 5 must hold across graduation.
- The first buy and escrow buys count toward `netRaisedWei`, and so toward the target, and they move
  the curve price. The first buy can never cross the target by itself (C3 reverts). The C5 curve
  choice should make 10% cost well below the smallest target at every accepted native price.
- A crossing buy by the creator writes its checkpoint before auto-finalize, so C7's "the buy lands
  even if graduation fails" keeps escrow intact.
- The leagues must exclude `CreatorFirstBuy` and `CreatorBuyEscrowed` volume (D13).

## Open questions

- **Q1 (bytecode).** C2-C4 do not fit in `LaunchCampaign`'s 1 spare byte. Proposal: remove from the
  new implementation (a) block-based launch protection, which is off on mainnet and replaced by C2
  (`:158-161, 617-626, 655-679`); (b) the unauthorized entry points `buyExactTokens`, `buyExactBnb`
  and `sellExactTokens` plus `_requireDirectTradeAllowed`, which E4 keeps permanently off; and
  (c) the legacy non-router fee path and `_feeSplit`, which cannot run because the factory always sets
  `strictFeeRouting: true` (`LaunchFactory.sol:485`; `:797-836`). The alternative is an external
  library (more deploy steps and more audit surface). Needs a founder go, because it deletes features.
