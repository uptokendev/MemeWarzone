# C1 + C6: TreasuryRouterV4 and the creator fee choice on EVM

Status: spec for audit. Nothing built or deployed. "Today" facts cite this worktree
(`claude/evm-launch-gen`, `68941587`); mainnet state was read on 2026-09-30 with `cast call`
against `bsc-dataseed.bnbchain.org` and `rpc.mainnet.chain.robinhood.com`.

## C1. TreasuryRouterV4: creator 560 bps

### Today

- The creator share is a literal: `amounts.creator = (amount * 500) / ROUTE_BPS`
  (`TreasuryRouterV3.sol:201`); protocol is the remainder (`:205`). Finalize has no creator line
  (`:208-228`).
- `admin` and `upgradeDelay` are immutable (`:46-47`). Each vault setter is a direct call only while
  the slot is empty (`:240-245, 263-268, 286-291, 309-314`), otherwise propose -> `upgradeDelay` ->
  accept. The first LP locker is also one call; once any is authorized it goes through propose/accept
  (`:345`).
- Chain state: both V3 routers (`0xe635AA43…` BNB, `0xda0a9Ed9…` RH) have admin Safe
  `0x1edcEdf5…`, delay 3600, `anyLpLockerAuthorized = true`. Both current factories
  (`0x632061cA…`, `0x35E93D0b…`) show `campaignsCount = 0`, `live = true`, `createPaused = false`.

### Diff

Keep the constant a constant. An immutable constructor parameter would add one more value to verify
for each deployment and would buy nothing.

```diff
-contract TreasuryRouterV3 {
+contract TreasuryRouterV4 {
     using SafeERC20 for IERC20;
     uint16 internal constant ROUTE_BPS = 10_000;
+    uint16 public constant CREATOR_TRADE_BPS = 560;
 ...
-        amounts.creator = (amount * 500) / ROUTE_BPS;
+        amounts.creator = (amount * CREATOR_TRADE_BPS) / ROUTE_BPS;
```

Nothing else changes. That includes `ICreatorRewardsVault.accrueTradeFee(address)`, which V2 keeps
with the same selector. Trade split in bps: linked 3750/560/1250/0/250/**4190**, unlinked
3750/560/0/1500/0/**4190**, OG 3750/560/1500/0/250/**3940**. Finalize is byte-identical. A proof
test compiles both routers and asserts `previewFinalize` is equal and `previewTrade` differs only in
`creator` and `protocol`, and only by `floor(a*560/1e4) - floor(a*500/1e4)`.

### What must be re-pointed

| Contract | Router check today | Action |
|---|---|---|
| Weekly league `TreasuryVaultV2` | open `receive()` (`TreasuryVaultV2.sol:98`) | keep, constructor arg |
| `MonthlyLeagueTreasury` (replacement) | open `receive()` (`MonthlyLeagueTreasury.sol:113`) | keep, constructor arg |
| `RecruiterRewardsVault` | open `receive()` (`NativeTreasuryVaultBase.sol:22-25`) | keep, direct setter |
| `ProtocolRevenueVault` | open `receive()` with operator fill (`ProtocolRevenueVault.sol:40-44`) | keep, direct setter |
| `CommunityRewardsVault` | `depositAirdrop`/`depositSquadPool` are `onlyRouter`, a single router (`CommunityRewardsVault.sol:164-167, 201-211`); admin `setRouter`, no timelock (`:185-188`) | keep, `setRouter(V4)` |
| `CreatorRewardsVault` V1 | `onlyRouter` (`CreatorRewardsVault.sol:42-45, 65`) | replaced by V2. V1 stays on V3 and stays unused |
| New generation's LP locker | the factory deploys it and calls `configureRevenue(treasuryRouter_, …)` (`LaunchFactory.sol:296-303`) | points at V4 from birth; the router must authorize it |

Keeping the community vault means keeping the airdrop distributor, operator and pre-authorized
batches exactly as they are (`make-airdrop-setup-calls.mjs:40-42`). The consequence: once the vault's
router is V4, the V3 router's `depositAirdrop` call reverts, and so does every unlinked or squad
trade routed through V3 (`TreasuryRouterV3.sol:435-440`). This costs nothing today because V3
serves 0 campaigns. It is still why step 1 below pauses create on the old factory first
(`LaunchFactory.sol:666`). `make-airdrop-recovery-batch.ts:77` reads the router from the vault, so
recoveries follow V4 automatically.

### Safe transactions (all direct: every V4 slot is empty, so no timelock applies)

Deployer first: `TreasuryRouterV4(admin = Safe, weekly, monthly, 3600)`, where admin is immutable
and must be the Safe at construction. Then `CreatorRewardsVaultV2`, a holder `RewardDistributor`
(owner Safe) and the new factory, which creates its locker.

**BNB (56)**. The constructor gets weekly `0xC9286EE3…` and monthly `0x42D254A7…` (read from V3).
1. `LaunchFactory 0x632061cA….setCreatePaused(true)`
2. `V4.setRecruiterRewardsVault(0x40ac5cD7…)`
3. `V4.setCommunityRewardsVault(0xB6ccAc81…)`
4. `V4.setProtocolRevenueVault(0xc2d4E6f8…)`
5. `V4.setCreatorRewardsVault(<CreatorRewardsVaultV2>)`
6. `CommunityRewardsVault 0xB6ccAc81….setRouter(V4)`
7. `V4.setAuthorizedLpLocker(<new locker>, true)`, then `V4.setPrimaryLpLocker(<new locker>)`
8. `VaultV2.setFactoryOnce(<new factory>)`, `VaultV2.setHolderDistributorOnce(<holder dist>)`,
   `VaultV2.setOperator(0xdcf07EB0…)`, `VaultV2.setCaps(...)`
9. `HolderDistributor.setBatchOperator(VaultV2)`, then
   `authorizeBatch(weeklyContractBatchId(56, epoch, "airdrop_holders"), cap, end, end+6d)` x 12 weeks

**Robinhood (4663)**. The constructor gets weekly `0xB6ccAc81…` and monthly `0x576c1d6B…`. The
steps are the same with factory `0x35E93D0b…`, recruiter `0xBd7EB35d…`, community `0xdE9Ec7c6…`,
protocol `0x632061cA…` (addresses collide across chains; match them per chain).

Off chain: add V4 to the indexer's router scan (`TREASURY_ROUTERS_<id>`, the recruiter credit
source), to `realtime-indexer/src/abis.ts` and to `scripts/check-evm-payout-bounds.mjs`.

## C6. CreatorRewardsVaultV2

### Storage

```solidity
enum Choice { Unset, Keep, Holders, Split, Buyback }
struct Cfg { address creator; Choice choice; uint8 creatorPct; address pool; }
address public immutable admin;              // Safe
address public immutable wrappedNative;
address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
address public router; address public factory; address public locker; address public holderDistributor;
address public operator; bool public operatorPaused;
mapping(address => Cfg) public cfg;
mapping(address => uint256) public creatorBalance, holderBalance, buybackBalance;   // native, per campaign
mapping(address => uint256) public heldBuybackTokens;                               // pre-grad buys
mapping(address => mapping(address => uint256)) public lpSynced;                    // pool => token
uint256 public totalLiabilities;             // Σ the three balances + Σ proposed-not-executed batches
// caps (admin): maxBuyPerTx, maxBuybackPerCampaignWeek, minBuyInterval, maxImpactBps (<= 50),
// maxHolderBatchPerWeek; holderBatchDelay (immutable, >= 24 h)
```

### Choice

`setCampaignChoice(campaign, creator, choice, pct)` is `onlyFactory`. It requires
`cfg.choice == Unset`, `choice != Unset`, and `pct ∈ 1..99` if Split, else 0. The factory calls it
inside `createCampaign*` before the C3 first buy, with values that the server's create authorization
signs. There is no setter afterwards. `setFactoryOnce` also pins `locker = factory.permanentLpLocker()`.

### Accrual

`accrueTradeFee(campaign)` is `onlyRouter` and payable. It requires `cfg.choice != Unset`, so a
direct `routeTrade` from a non-campaign reverts its own call; today anyone can accrue to any address
(`CreatorRewardsVault.sol:82-88`). `_credit(c, v)` works like this. Keep: creator += v. Split:
`k = v*pct/100`, creator += k, holders += v-k. Holders: holders += v. Buyback: buyback += v.
The function makes **no external call**: V1 calls `creator()` on the campaign (`:113`), V2 reads the
stored creator. It is deliberately **not** `nonReentrant` (see the audit notes below).

### Creator claim

`claimCreatorFees(campaign)`, `nonReentrant`. It requires `msg.sender == cfg.creator`, zeroes
`creatorBalance` (and debits `totalLiabilities`), then sends and requires `ok`. It pays only Keep and
the creator part of Split.

### (a) Holders

The community vault cannot take this money. `receive()` reverts (`CommunityRewardsVault.sol:181-183`),
deposits are router-only (`:201-211`), and the weekly runner prices the trader/creator pot from
`warzoneAirdropBalance` (`frontend/scripts/weekly-airdrop/chain.mjs:29-31`). Holder money deposited
there would inflate the codes-0/1 pot. `RewardDistributor` has **one** `batchOperator` (`:52`),
already the community vault. So holders get a **second `RewardDistributor` instance**: same audited
code, owner Safe, `batchOperator = VaultV2`. The EVM runner gets a program `airdrop_holders` with its
own batch id, the way it does `airdrop_trader`/`airdrop_creator` (`make-airdrop-setup-calls.mjs:51`),
and the Claim Center reads both distributors.

- `proposeHolderBatch(batchId, root, claimDeadline, campaigns[], amounts[])`, onlyOperator. It debits
  each `holderBalance`, enforces `maxHolderBatchPerWeek` and stores the batch with
  `executableAt = now + holderBatchDelay`. The leaf file is published at proposal time.
- `approveHolderBatch(batchId, root, total)`, onlyAdmin (Safe), added by audit fix F5 below: the Safe
  approves the exact root and total the operator proposed; without it nothing executes.
- `vetoHolderBatch(batchId)`, onlyAdmin, allowed until executed. It credits every amount back.
- `executeHolderBatch(batchId)`, onlyOperator, allowed after `executableAt` and only once approved. It sets executed and then
  calls `holderDistributor.createBatch{value: total}`, which enforces the Safe's
  `authorizeBatch` max and publish window (`RewardDistributor.sol:103-108`).
- Unclaimed money after the deadline goes back through the existing atomic recovery batch into the
  community vault's airdrop pot (`recoverUnclaimed`, `:158-172`), the same as unclaimed code-2 leaves
  on Solana.

### (b) Buyback

Before graduation the buy goes through the campaign's signed path, `buyExactBnbAuthorized`
(`LaunchCampaign.sol:468-475`) with actor = the vault (`:855-857`) and profile StandardUnlinked.
Tokens go to `msg.sender` (`:601-609`). Before graduation the vault **cannot** forward them to
`0x…dEaD`, because `LaunchToken._update` only allows transfers from the campaign
(`token/LaunchToken.sol:42-55`). They are therefore held in `heldBuybackTokens`. The vault has no
sell or transfer path for them except `flushBuybackTokens(campaign)`, which is permissionless once
`tradingEnabled` and sends everything to DEAD. The campaign needs no change.

`buybackCurve(c, amountIn, minOut, deadline, sig)`, onlyOperator, `nonReentrant`:
1. Checks: choice Buyback; `!launched && !graduationPending`; now ≥ trading start + 60 s (C2 view);
   progress ≤ 95% of target (C5 view); `amountIn ≤ buybackBalance[c]`, `≤ maxBuyPerTx`, within the
   week cap; `now ≥ lastBuy[c] + minBuyInterval`.
2. Effects: `buybackBalance[c] -= amountIn` and the liabilities are debited.
3. Interaction: `(out, spent) = campaign.buyExactBnbAuthorized{value: amountIn}(...)`. Take `spent`
   from the **return value**, not from the balance delta, because the buy's own fee re-enters
   `accrueTradeFee` and raises the balance. The refund `amountIn - spent` is credited back.
4. Post-checks: `currentPrice() ≤ before * (1e4 + maxImpactBps) / 1e4` (`:406`), still not
   launched, `heldBuybackTokens[c] += out`.

`buybackPool(c, amountIn, minOut)` runs after graduation. `cfg.pool` is bound by
`bindPool(pool)`, which is permissionless and valid only if `locker.poolInfo(pool).campaign == c`.
- BNB Topaz V2: `amountIn ≤ reserveNative * 24 / 1e4`, because (1+x/r)² ≤ 1.005 ⇒ x/r ≤ 0.2497%.
  The vault wraps, transfers to the pair and calls `swap(…, DEAD, "")` using the pair's own
  `getAmountOut`.
- Robinhood V3: the vault wraps, sets `approve(SwapRouter02, amountIn)`, calls `exactInputSingle`
  with `recipient = DEAD`, fee 3000 and `sqrtPriceLimitX96` at 0.5% price in the swap direction.
  Then `spent = wethBefore - wethAfter`, it resets the approval to 0 and unwraps the leftover.

The vault hard-codes the recipient as DEAD. No parameter can name one.

Randomness is off chain, as on Solana (D5): `EVM_BUYBACK_SEED_SECRET`, with `sha256` published
before the week, the secret published after, and moment `i = HMAC(secret, chain|campaign|day|i)`.
The chain enforces the bounds, not the moments.

### Where native can leave the vault

The complete list: `cfg.creator` (claim), `holderDistributor` (set once by the Safe, through a
Safe-authorized batch), a campaign with `factory.isCampaign` (`LaunchFactory.sol:218`),
`wrappedNative`, and the bound pool or SwapRouter02 with recipient DEAD. `rescueExcess(to, amt)`
(admin) can move only `balance - totalLiabilities`. A compromised operator can therefore do three
things: (1) propose a malicious holder root, which the Safe can veto for 24 h and which is capped per
week and per Safe batch; (2) buy at bad moments, which is bounded by the per-tx cap, 0.5% impact,
the interval and the weekly cap, and the money still buys the coin; (3) stall, and the Safe rotates
`operator`. It cannot send native to itself.

## D19: LP fees follow the choice, with no locker code change

Proof from the code:
1. At harvest the recipient is `creatorPayoutRecipient[info.creator]`, falling back to
   `info.creatorFeeRecipient` (`PermanentLpLocker.sol:295-296`, `PermanentV3PositionLocker.sol:371-372`).
2. That mapping is keyed by the **creator** and overwritten at every registration (`:163` / `:274`).
   Passing the real creator with the vault as recipient would therefore redirect all of that
   creator's coins, or be overwritten by their next keep coin.
3. `updateCreatorPayoutRecipient` lets whoever is the key re-point the recipient (`:191-197` /
   `:305-311`). A creator key would let the creator take the fees back.
4. The registration arguments come from the locker admin, which is the factory
   (`LaunchFactory.sol:296-303`). Today it passes `campaignCreator` twice (`:545-553`).

The new factory's `notifyCampaignGraduated` therefore passes, for non-keep coins,
**`creator = campaign` and `creatorFeeRecipient = VaultV2`**. Keep coins are unchanged. The campaign
has no code that could call `updateCreatorPayoutRecipient`: its only low-level calls are native sends
(`LaunchCampaign.sol:499, 903, 922`). So the recipient of that pool is fixed forever, per campaign.
`creatorRegistry.recordGraduation(campaignCreator)` keeps the real creator (`LaunchFactory.sol:555-556`).

Attribution: `syncLpFees(pool)` is permissionless and `nonReentrant`. It requires
`poolInfo.creator == poolInfo.campaign`, `creatorFeeRecipient == this` and a non-Keep choice. For
each token it computes `delta = locker.cumulativeCreatorPaid(pool, token) - lpSynced`
(`PermanentLpLocker.sol:64, 299`, `PermanentV3PositionLocker.sol:103, 375`). For the wrapped native
side it unwraps and runs `_credit`. For the meme side it sends to DEAD (see open question 1). Donated
tokens are never credited. The locker bytecode is the same source. It is redeployed only because
every factory constructs its own. The one delta is the factory's two arguments. The indexer reads the
real creator from `CampaignChoiceSet`, because the `GraduationPoolRegistered.creator` field is the
campaign address for these coins.

The pending path (`_tryTransferToken` fails, then `pendingToken[vault]`) cannot be reached for
WETH9/WBNB or for a graduated `LaunchToken`. A test pins that. If it ever happened, the tokens would
be claimable to the vault as excess, which only the Safe can move.

## As built (fees builder, 2026-09-30, branch `claude/evm-fees`)

This section supersedes the design text above wherever they differ. E9 and E10 (decided after this
spec was written) replace open questions 1 and 2.

**Files.** `contracts/TreasuryRouterV4.sol`, `contracts/CreatorRewardsVaultV2.sol`,
`contracts/EvmGenPoolSwap.sol` (internal library shared by both lockers and the vault),
`contracts/PermanentLpLocker.sol` and `contracts/PermanentV3PositionLocker.sol` (new generation
source), `contracts/interfaces/ICreatorRewardsVaultV2.sol`, `scripts/deploy-evm-treasury-router-v4.ts`.

**E9 in the lockers.** Registration is unchanged in signature; `expectedTokenA` is the MEME token and
`expectedTokenB` the paired asset (the factory passes them in that order; the V3 locker refuses the
wrapped native as the A side). `harvest` claims both sides as before, then sells `carriedMeme[pool] +`
the new MEME fees into the same pool, bounded to 0.50% price impact:
Topaz V2 sells at most `reserveMeme * 50 / 20000` (0.25% of the reserve, price move 0.499%) through a
direct pair `swap` using the pair's own `getAmountOut`; Uniswap V3 swaps with `sqrtPriceLimitX96 =
sqrtP * sqrt(1 - 0.005)` rounded inward, so the pool itself stops the sale (partial fill). What is not
sold is carried to the next harvest. The sale runs in a self-only external call inside `try`, so a
failing sale (paused pool, empty range, anything) reverts only itself and the harvest continues. The
80/20 split then runs once, on the paired asset only (fees + proceeds), through the unchanged paths:
creator transfer with `pendingToken` fallback, protocol `routeLpToken`. **The paired asset is paid as
WBNB/WETH (wrapped), not unwrapped native**: no native push (no gas griefing surface), no new pending
native state, no factory change for the V2 locker. Quote-bound pools pay the quote token.

No TWAP guard in the lockers. Both lockers are embedded in the factory's initcode and the BNB factory
sits at 48,797 of the 49,152-byte EIP-3860 initcode limit (the V2 TWAP check cost 220 bytes, V3 ~830).
The bound alone makes a sandwich unprofitable: to move the price by d the attacker trades ~r*d/2 and
pays 0.30% twice (~0.003*r*d); the most it extracts is the sale times d, <= 0.0025*r*d. Proven by
`evmgen-fees-locker-v2` at 1%-10% attacker sizes (the attacker ends with less paired, every size).

**CreatorRewardsVaultV2 as built.** Choice, accrual, creator claim and holder batches as specified,
plus (E10) per-campaign quote balances (`creatorQuoteBalance`, `holderQuoteBalance`,
`buybackQuoteBalance`, `quoteLiabilities[token]`):
- `syncLpFees(pool)`: reads the locker's `poolInfo` (V2 or V3 shape, by the vault's immutable
  `dexKind`), binds `cfg.pool` and `cfg.quote` (paired token when it is not the wrapped native) on first
  use, and credits `cumulativeCreatorPaid - lpSynced`. Wrapped native is unwrapped (`withdraw(delta)`)
  and credited under the choice; a quote token is credited to the quote balances.
- `claimCreatorQuote(c)`: the creator part of a split coin's LP fees, in the quote token.
- `convertHolderQuote(c, amt)` (operator): quote -> native through `quoteRoutePool[quote]`, credited to
  the campaign's holders. `setQuoteRoute(quote, feeTier)` (admin) reads the pool from the DEX factory
  (`getPool(wrapped, quote, false)` on Topaz, `getPool(wrapped, quote, fee)` on V3): no free address.
- `buybackPool(c, amt)` (operator): native pool -> WBNB/WETH into the coin's pool (native caps apply);
  quote pool -> the quote balance into the coin's pool. MEME output is `DEAD`, hard-coded.
  `convertBuybackNativeToQuote(c, amt)` (operator) turns a quote coin's native buyback balance into
  quote through the route pool (native caps charged here).
- Every vault swap uses the same bound (`maxImpactBps <= 50`) plus a TWAP guard (Topaz `quote(...,1)`,
  V3 `observe` over 1800 s, 100 bps; skipped when the pool cannot serve it) and reverts `NothingSwapped`
  when nothing may be swapped. Buyback, conversions and holder batches are operator-only; the operator
  names no recipient anywhere.
- `buybackCurve`: the C2 window is detected without a new view: `quoteBuyExactBnb(amountIn)` must
  report `fee * 1e4 <= totalCost * 200` (flat 2%). Progress check `(netRaisedWei + amountIn) <= 95%` of
  `graduationNativeTarget()`, price impact via `currentPrice()`, and a post-check that the buy did not
  enter Pending (it reverts the whole buy).
- `pullLockerPending(token)` (permissionless) + `attributeExcessQuote(c, amt)` (admin): a pausable quote
  (stock token) that fails the locker's transfer parks the vault's share as `pendingToken[vault]`; it is
  pulled into the vault as unattributed excess and the admin can assign only excess, never another
  campaign's balance.
- `rescueExcessToken` refuses the wrapped native (LP fees wait there until sync) and every MEME token the
  vault holds for a burn; `rescueExcessNative` moves only `balance - totalLiabilities`.
- `receive()` accepts only the wrapped native (unwrap) and factory campaigns (buyback refunds).

**Hardening (2026-09-30, branch `claude/evm-core`): the V3 price limit bounds the bought token.**
`EvmGenPoolSwap.v3Limit` computed `sqrtP * sqrt(1 - i)` for `zeroForOne`. That swap buys token1, whose
price is `1/p`, so the bought token could rise by `1/(1 - 0.005) = +0.5025%`, above the spec's
`after <= before * (1e4 + maxImpactBps) / 1e4`. It surfaced as a nonce-dependent failure of the V3
vault buyback test (which orientation the pool takes depends on the token addresses). Now
`zeroForOne` uses `sqrt(1e4 / (1e4 + i))` and the other direction is unchanged (`sqrt(1 + i)`), so in
both orientations the bought token's price rises by at most `i` (rounded inward, never beyond). Effect
on the V3 locker's MEME sale when MEME is token0: MEME may fall by `1 - 1/1.005 = 0.4975%` instead of
0.5% (slightly tighter, the rest carries to the next harvest). No state, guard or call order changed;
pure arithmetic on `BPS <= 1e4` and `impact <= 50` (`1e4 * 1e18` fits easily). Pinned in both
orientations by `test/evmgen-hardening-locker-binding.spec.ts` ("V3 impact bound").

**Size cleanup (2026-09-30, `claude/evm-core`).** `CreatorRewardsVaultV2` runtime 24,518 -> 22,307
bytes, no behaviour change: the `holderBatchLegs` view is removed (the legs are the calldata of
the propose transaction and are still stored for execution); all 11 constants
(`DEX_TOPAZ_V2`, `DEX_UNISWAP_V3`, `DEAD`, `BUYBACK_ROUTE_PROFILE`, `MAX_IMPACT_BPS_LIMIT`,
`TWAP_DEVIATION_BPS`, `TWAP_WINDOW`, `FLAT_TRADE_FEE_BPS`, `MAX_CURVE_PROGRESS_BPS`,
`MAX_BATCH_CAMPAIGNS`, `MIN_HOLDER_BATCH_DELAY`) are `internal`; and the getters nothing outside the
contract reads are `internal`: `lpSynced`, `heldTokenAsset`, `holderBatches`, `buybackWeek`,
`lastBuybackAt`, `holderWeek`, `holderProposedInWeek`, `operatorPaused`, `maxBuyPerTx`,
`maxBuybackPerCampaignWeek`, `minBuyInterval`, `maxHolderBatchPerWeek` (the last five are emitted in
`OperatorUpdated` / `CapsUpdated`). Still public because scripts, tests or the app read them:
balances and quote balances, `heldBuybackTokens`, `quoteRoutePool`, `quoteLiabilities`,
`totalLiabilities`, `buybackSpentInWeek`, `maxImpactBps`, `cfg`, `isKeep`, and the addresses
(`admin`, `router`, `factory`, `locker`, `holderDistributor`, `operator`, `wrappedNative`,
`dexKind`, `dexFactory`, `holderBatchDelay`). Logic, errors and the TWAP guard are untouched.

### Internal-audit fixes (2026-09-30, branch `claude/evm-fees`)

Findings from internal audits 1, 3, 4 and 5 against this stack. Each fix below supersedes the text above
where they differ. The audit specs (`test/audit3-bnb-graduation.fork.spec.ts`, `test/audit4-fees.spec.ts`,
`test/audit5-privileged-roles.spec.ts`) keep every attack's steps; the former EXPLOIT tests now assert
`HOLDS`.

**F1 (HIGH, audits 1/4/5): the router <-> creator vault binding is fixed for life.** A routine Safe
rotation of `TreasuryRouterV4.creatorRewardsVault` (propose/accept), or re-pointing
`CreatorRewardsVaultV2.router`, reverted every buy and sell of every existing campaign: the choices live
only on the vault that was bound at create, `accrueTradeFee` reverts `ChoiceUnset`/`OnlyRouter`, and
strict fee routing bubbles it. Fix, chosen for the least new surface (nothing added, two paths removed):
`proposeCreatorRewardsVault`, `acceptCreatorRewardsVault`, `pendingCreatorRewardsVault(Since)` and the
`CreatorRewardsVaultProposed` event are deleted from the router; `setCreatorRewardsVault` is set-once
(`"already set"`). The vault's `setRouter` is deleted and `router` is `immutable` (constructor). Keying
the vault per campaign was rejected: it adds a per-campaign storage write to every create and a new
lookup to every trade for a property the set-once binding gives for free. Consequence: a vault bug is
fixed by a new router + vault + factory generation; campaigns already created keep their router and
vault. Old-generation routers (V3) are untouched.
- Reentrancy / CEI: no new external call; `setCreatorRewardsVault` checks, emits, writes (admin only).
- Reachable states: `creatorRewardsVault` goes `0 -> vault` once; `_routeTrade` refuses while it is 0.
- Overflow: none. Griefing: the Safe can no longer freeze trading through this slot; it still can
  through `setForwardingPaused` (documented, unchanged).
- Indexer: `CreatorRewardsVaultProposed` in `scripts/lib/indexerManifest.cjs` can no longer fire.

**F2 (MEDIUM, audit 4 M1): one MEME sale per pool per block, in both lockers.** `harvest` is
permissionless and each call re-applied the impact bound to the price the previous call left, so a
contract looping `harvest` 13 times in one transaction sold 3% of the reserve (all carried MEME) at
compounding impact and a single back-run profited. New state `lastSaleBlock[pool]` (public) in
`PermanentLpLocker` and `PermanentV3PositionLocker`: the sale step runs only when `lastSaleBlock[pool] !=
block.number`, and sets it before the `try`. A second harvest in the same block still claims and splits
the paired side; its MEME is added to `carriedMeme` and sold by the next block's harvest.
- Reentrancy: unchanged (`harvest` is `nonReentrant`; the write happens inside the guard, before the
  self-call). CEI: the marker is written before the external sale; if the sale reverts, the `try`
  swallows it and the marker stays (the block's sale attempt is spent, nothing is lost: all MEME carries).
- Reachable states: `lastSaleBlock` only increases, one write per pool per block with MEME to sell.
- Overflow: none (block number compare). Griefing: anyone can spend a block's sale attempt by calling
  `harvest` first, which is exactly an honest harvest; the next block sells again. Harvest never reverts
  because of the marker.

**F3 (MEDIUM, audit 3 M2): the Topaz locker's sale needs the pair's TWAP; the unprofitability claim is
corrected.** On a BSC fork with real Topaz, an attacker who adds 30-66% of the pool's liquidity, dumps MEME,
triggers `harvest` and buys back, profited at 5 and 30 bps: as an LP it earns back most of its own swap
fees, and the sale cap is measured on the reserve its dump just inflated. The earlier text ("the bound alone
makes a sandwich unprofitable") was wrong for that attacker and is corrected in `EvmGenPoolSwap`,
`PermanentLpLocker` and `PermanentV3PositionLocker`. Fix: `PermanentLpLocker.sellMemeForPaired` passes
`MEME_SALE_TWAP_DEV_BPS = 100` to `v2Plan` (was hard-wired 0), and `v2Plan` now fails CLOSED: it sells
nothing when spot `getAmountOut` is worse than Topaz `quote(tokenIn, sellIn, 1)` (TWAP reserves of the
last closed 30 min observation window, which no transaction in the current block can move) by more than
1%, or when `quote` reverts (pair younger than one window). The locker is no longer embedded in the
factory's initcode (`deployFactoryWithLocker`), so the bytes the old text cited are not a constraint.
- Measured (`audit3-bnb-graduation.fork.spec.ts`, fees 1/5/30/100 bps): every dump in the audit's grid
  (0.05x-2x the MEME reserve, LP share 0-66%) now sells nothing and loses the attacker money; the
  creator/protocol side gains the attacker's fees. Residual, pinned: a dump small enough to stay inside the
  1% band (0.2-0.4% of the reserve) with a 50-66% LP position nets the attacker at most ~0.2% of one honest
  harvest (e.g. 0.000038 BNB on a 0.0295 BNB harvest at 30 bps), for capital of twice the pool.
- Behaviour change: a harvest while spot is more than 1% below the last closed window's TWAP, or in the
  pool's first 30 minutes, sells no MEME; it is carried (never lost) and the paired side is split as
  before. The vault's Topaz swaps (`buybackPool`, conversions) share `v2Plan` and fail closed the same way
  (`NothingSwapped`).
- Reentrancy / CEI: the new call is a `staticcall` to the pair inside the self-only sale step, before any
  transfer. Reachable states: unchanged. Overflow: `out * 1e4` and `twapOut * (1e4 - 100)` with amounts
  bounded by token supplies (< 2^128 in practice; checked arithmetic reverts inside the `try`, which only
  carries). Griefing: nobody can make a registered pair's `quote` revert; a price pushed >1% off TWAP only
  delays the sale (and costs the pusher the pool fee).
- The V3 locker keeps no TWAP guard (a new V3 pool has one observation slot, so a TWAP would never be
  available or would fail open). Its residual against a dominant in-range LP attacker is one bounded sale
  per block (F2), each at most 0.50% below the price that attacker set. Founder item: a keeper that grows
  the pool's `observationCardinalityNext` would allow the same guard there.

**F4 (MEDIUM, audit 4 M2): vault swaps scale the bound to the pool fee, the V3 TWAP guard fails closed,
route pools get observation slots, and conversions are spaced per route pool.** On a 0.05% Uniswap V3
route pool whose oracle had no 30 min history, `convertHolderQuote` was sandwiched at a profit (+195 STK
on a 2,500 STK conversion), and the operator could repeat it in one block. Four changes:
1. `EvmGenPoolSwap.feeScaledImpact(bound, feePips) = min(bound, feePips / 60)` (fee * 5/3 in bps, the
   locker's E13 rule). `CreatorRewardsVaultV2._swap` applies it on both DEX kinds: Topaz reads
   `dexFactory.getFee(pool, false)` (bps, x100 to pips), V3 reads `pool.fee()`. 0.30% -> 50 bps,
   0.05% -> 8, 0.01% -> 1, a 0-fee pool -> 0 (`NothingSwapped`). The admin's `maxImpactBps` still caps it.
2. `v3Limit` returns `ok=false` when `twapWindow != 0` and `observe` reverts (was: guard skipped). The
   lockers pass `twapWindow = 0` and are unaffected. (`v2Plan` fails closed since F3.)
3. `setQuoteRoute` on V3 calls `pool.increaseObservationCardinalityNext(180)` (`V3_ROUTE_OBSERVATIONS`),
   so the route can serve `observe(1800)` once its slots span 30 min (one touched block per 10 s on
   average). A busier pool needs more slots; anyone can add them on the pool directly. **Operational:** a
   Buyback coin's own V3 pool is not grown by the vault; the keeper must call
   `increaseObservationCardinalityNext` on it once before `buybackPool` can run there.
4. `_checkInterval(routePool)` in `_quoteToNative` (`convertHolderQuote`) and in
   `convertBuybackNativeToQuote`, sharing `minBuyInterval`. Keyed by the route pool, not the campaign,
   because the route is shared: a per-campaign interval would still let the operator stack conversions
   for many campaigns in one block. Consequence: one conversion per route pool per `minBuyInterval`.
- Measured: at 0.05% and 0.01% the audit's sandwich (front-runs of 50k and 200k STK) now loses the
  attacker 9.8-36.8 STK; without history the conversion refuses (`NothingSwapped`); a second conversion
  through the same pool in the interval reverts `TooSoon`.
- Reentrancy: `increaseObservationCardinalityNext` is an admin-only external call to the canonical pool
  read from the DEX factory (no attacker-chosen address); `getFee`/`fee()` are views before the swap;
  every swap path stays `nonReentrant`. CEI: interval stamped before the swap (a revert undoes it).
- Overflow: `feePips / 60` with `feePips <= 1e6` (uint24) or `getFee * 100` with Topaz fees <= 1e4.
- Griefing: the operator can only be slowed (interval, fail-closed guard); nobody else can call these.
  A pool with too few observation slots blocks conversions until someone grows it (no funds at risk).

**F5 (MEDIUM, audit 5 M1): the Safe approves holder payout content, not just an id and a max.** Batch A
pre-authorized 12 weeks of holder batch ids on the distributor by id and max only, so the payout operator
(an EOA) could propose a root that paid itself up to the weekly cap and it executed after 24 h unless the
Safe noticed and vetoed. Fix in `CreatorRewardsVaultV2` (the distributor is the unchanged audited
`RewardDistributor`): `HolderBatch.approved` (packs into the status slot), `approveHolderBatch(batchId,
root, total)` onlyAdmin, which reverts `BadBatch` unless the batch is proposed (status 1) with exactly that
root and total, and `executeHolderBatch` reverts `NotApproved` until approved. The operator still proposes
(and the vault still debits balances and enforces the weekly cap at proposal); it cannot change a proposed
root (ids are single-use, `AlreadySet`); the veto stays available until execution, approved or not.
Deploy script: batch A no longer pre-authorizes any week. New `holderWeekCalls(d, {batchId, root, total},
caps, now)` builds the weekly Safe batch H: `vault.approveHolderBatch(id, root, total)` +
`distributor.authorizeBatch(id, total, now, now + 6 days)`, refusing a total above
`EVMGEN_HOLDER_BATCH_AUTH_MAX`. Weekly flow: operator proposes and publishes the leaf file -> Safe signers
recompute the root from that file and check the total -> Safe executes batch H -> after 24 h the operator
executes -> holders claim on the holder distributor.
- Reentrancy: `approveHolderBatch` makes no external call. CEI unchanged in `executeHolderBatch` (status
  written before `createBatch`). Reachable: approve only in status 1; approving twice is harmless; a vetoed
  or executed batch cannot be approved. Overflow: `total` compared as uint256 against the stored uint128.
- Griefing: a compromised operator can propose junk that the Safe simply does not approve (the amounts stay
  debited until the Safe vetoes, which returns them; see F7 for the weekly cap). A compromised Safe was
  already able to veto; it still cannot redirect holder money except by approving a bad root, which is now
  an explicit signed act rather than silence.

**F6 (LOW, audit 4 L1): only what `pullLockerPending` pulled can be attributed or rescued.** LP quote the
locker has paid the vault but `syncLpFees` has not credited yet sits above `quoteLiabilities`, so
`attributeExcessQuote` (to another campaign) and `rescueExcessToken` could take it, leaving the owning
campaign's later sync insolvent. New `pulledUnattributed[token]` (public): `pullLockerPending` records the
balance delta its `claimPendingToken` call produced (robust to fee-on-transfer tokens); both admin paths go
through `_usePulled`, which requires `amount <= pulledUnattributed[token]` and `amount <= balance -
quoteLiabilities[token]`, then decrements. Consequence: a token sent to the vault by mistake is not
rescuable (it is not user money; the safer failure).
- Reentrancy: `pullLockerPending` stays `nonReentrant`; the locker's `claimPendingToken` pays
  `msg.sender` only. CEI: balance read, external claim, balance read, one counter write. Reachable: pull is
  permissionless; attribute/rescue admin only. Overflow: `after - before` cannot underflow for a sane ERC20
  (a token whose balance drops on receipt reverts the pull). Griefing: anyone can pull at any time, which
  only moves the vault's own pending into the vault and makes it attributable.

**F7 (LOW, audit 4 L2): a veto frees the weekly holder cap.** A vetoed batch kept counting against
`maxHolderBatchPerWeek`, so one bad proposal of the full cap blocked every honest batch for the rest of the
week. `vetoHolderBatch` now subtracts the batch total from `holderProposedInWeek` when the batch was
proposed in the week the counter tracks: `(executableAt - holderBatchDelay) / 1 weeks == holderWeek`
(`holderBatchDelay` is immutable, so this is exactly the proposal week). A batch from an earlier week frees
nothing (that week's counter is gone).
- Reentrancy / CEI: no external call added; the subtraction happens with the status write, before the
  per-campaign refunds (all storage). Reachable: status 1 -> 3 once, so each total is subtracted at most
  once. Overflow: `holderProposedInWeek >= b.total` whenever the weeks match, because the total was added
  in that same week and the counter is only reset when a new week starts. Griefing: none added; the
  operator gains nothing by proposing and having it vetoed.

**F8 (LOW, audit 3 L1): a creator's chosen payout wallet survives later graduations.** Both lockers
wrote `creatorPayoutRecipient[creator] = creatorFeeRecipient` on every `registerGraduatedPool`, so a Keep
creator's second graduation (the factory passes `(creator, creator)`) silently reset the wallet chosen with
`updateCreatorPayoutRecipient`, for all of that creator's pools. Now both `PermanentLpLocker` and
`PermanentV3PositionLocker` set it only when unset. Non-Keep coins are unaffected (their key is the
campaign, registered once, recipient the vault). `poolInfo[pool].creatorFeeRecipient` still records the
registration value, which is what `CreatorRewardsVaultV2._poolParties` checks.
- Reentrancy / CEI: no external call added (registration is admin/factory-only). Reachable: the mapping
  goes `0 -> registration value` once, then only the creator changes it. Overflow: none. Griefing: none; a
  creator cannot be forced onto a wallet by someone else's registration (keys are the creator's own).

**F9 (MEDIUM, Robinhood testnet run 2026-09-30): harvest gas guard, both lockers.** `harvest` is
permissionless and runs the MEME sale as a self-call inside `try`. The call forwards 63/64 of the gas left
(EIP-150) and keeps 1/64. When the harvest has little left to do after a failed sale (MEME already carried,
no paired fee: one warm SSTORE and an event), that 1/64 is enough, so a caller who sends just too little
gas makes the sale run out of gas inside the `try`. The `catch` carries the MEME, the harvest succeeds,
and anyone can repeat it every block to stop the MEME side from ever being sold. On testnet a harvest sent
with exactly `eth_estimateGas` reverted. The same gas sensitivity is what the grief uses. Fix:
`uint256 public constant MIN_SALE_GAS = 500_000` and `error InsufficientSaleGas()` in
`PermanentLpLocker` and `PermanentV3PositionLocker`. Right before the `try`, and after the
`lastSaleBlock` write so that SSTORE does not come out of the budget, `if (gasleft() < MIN_SALE_GAS)
revert InsufficientSaleGas();`. A short harvest now fails loudly and changes nothing, and the next honest
harvest sells. Harvests with no MEME to sell, or in a block that already had a sale, never reach the
check and need no extra gas.
- **How the value was set.** The sale frame (`sellMemeForPaired`, including its TWAP reads, the swap and
  the V3 callback) was measured with `callTracer` inside a real harvest on local mainnet forks
  (`test/evmgen-fees-fork.spec.ts`, anvil, nothing sent to a network). BSC real Topaz volatile pool:
  **98,891 gas** (whole harvest 410,571). Robinhood real Uniswap V3 at 0.30%: **89,610 gas** (whole harvest
  470,819). Pessimistic worst case about 220k: a LaunchToken instead of the mock ERC20 (+2.1k cold
  SLOAD), a costlier paired token such as a Robinhood stock token (about +60k per transfer), a tick
  crossing inside the 0.5% band (at most one at spacing 60, about +50k), and a fresh oracle observation
  slot (about +22k). 500k leaves the sale 63/64 of it, about 492k: 5x the measured cost and 2.2x the
  pessimistic case. Both fork tests now assert `2 x measured <= MIN_SALE_GAS x 63/64`.
- Reentrancy: unchanged (`nonReentrant`, and the check makes no external call). CEI: the check sits
  between the `lastSaleBlock` write and the self-call. On revert both are undone.
- Reachable states: only a harvest with MEME to sell in a block without a sale reaches the check. A
  revert there leaves every state as it was (`carriedMeme`, `lastSaleBlock`, balances, pending).
- Overflow: none (a compare).
- Griefing: a low-gas caller can now only waste its own gas. It can no longer spend the block's sale
  attempt or carry the MEME. The guard is a floor, not a cap: a pool whose real sale costs more than
  about 492k (not reachable with the pools we register) would again be exposed to a caller who sends
  exactly enough to pass the guard, which is why the margin is 2x the pessimistic case. Unchanged and
  still recoverable: a caller who gives the post-sale split too little gas parks the protocol share in
  `pendingProtocolToken` (permissionless retry) or the creator share in `pendingToken`. Neither was
  seen at any gas limit in the sweep below.
- Callers: wallets and the keeper must not send the bare `eth_estimateGas`. The estimate already includes
  the guard now (a lower limit reverts), but the keeper uses `max(2 x estimate, 2,000,000)`.
- Tests: `test/evmgen-fees-harvest-gas-guard.spec.ts`, 5 per locker. The exact minimum gas limit is
  found by binary search over `eth_call`. `min - 1` reverts `InsufficientSaleGas` and changes nothing,
  then `min` sells in full and splits 80/20 with no pending. A sweep from 150k to `min + 400k` finds that
  every successful harvest sold in full. The griefing shape (MEME already carried, no paired fee, a sale
  that costs about 350k via the mock pools' new `setSwapGasBurn` knob) is swept too. **With the guard set
  to 0 that sweep fails on both lockers** (for example "gas 286409 carried the MEME"). With 500k it passes.
  A harvest with nothing to sell succeeds below `MIN_SALE_GAS`. Sizes: `PermanentLpLocker` 11,350 B,
  `PermanentV3PositionLocker` 13,044 B.

### E19: unclaimed holder payouts back to the same coin's holders (2026-10-01, branch `claude/evm-fees`)

Founder decision E19 (2026-09-30), same shape as the airdrop rule of 2026-09-27. After a holder batch's
claim window the Safe recovers what nobody claimed from the holder `RewardDistributor` and credits it back
to each coin's `holderBalance`, to be paid in a later week.

**Contract.** `CreatorRewardsVaultV2.creditUnclaimedHolders(address[] campaigns, uint256[] amounts)`,
`external payable onlyAdmin nonReentrant`, plus `event HolderUnclaimedCredited(campaign, amount)` (one per
leg) and `error ValueMismatch()`. For each leg: the campaign's choice must be Holders or Split
(`WrongChoice` otherwise, which covers an unknown campaign, Keep and Buyback), the amount must be non-zero
(`Insufficient`); it is added to `holderBalance[campaign]`. Then `sum == msg.value` (`ValueMismatch`) and
`totalLiabilities += sum`. 1..200 legs, lengths equal (`BadBatch`). No other state is touched: the weekly
holder cap (`holderProposedInWeek`), batches and quote balances are unchanged; the credited native is paid
only through a later proposed, Safe-approved, vetoable holder batch like any other holder money.
Runtime size 23,601 -> **24,063 bytes** (limit 24,576; 513 left).

**Leaf file.** The weekly leaf file (`realtime-indexer/src/evm/evmCreatorChoice.ts` `buildLeafFile`) now
carries, per leaf, `parts: [{campaign, amount}]`: which coin each wei of that wallet's leaf came from (the
per-coin shares that `holderLeaves` summed). Not part of the merkle leaf, so roots are unchanged.
`checkLeafParts` (indexer and `scripts/evm-holder-batch-verify.mjs`, same rule) requires each leaf's parts to
add up to the leaf and each campaign's parts to add up to that campaign's `proposeHolderBatch` amount. A file
without parts still verifies for the weekly flow; the recovery script refuses it.

**Script.** `scripts/make-holder-recovery-batch.ts` (`HOLDER_RECOVERY_FILE=<leaf file or API URL> npx hardhat
run ... --network <chain>`). Reads the distributor's batch and `hasClaimed` for every leaf, excludes claimed
leaves, sums the parts of the rest per campaign, and writes ONE Safe batch:
`RewardDistributor.recoverUnclaimed(batchId, Safe)` then
`CreatorRewardsVaultV2.creditUnclaimedHolders{value: total}(campaigns, amounts)`. Refuses: before the
deadline; already recovered or fully claimed; root, funded total, deadline, distributor or vault not the
file's; vault admin not the Safe or not the distributor's owner; claimed leaves not adding up to
`totalClaimed`; attribution not summing exactly to `totalFunded - totalClaimed`; a campaign that is not a
holders or split coin in the vault; a file without parts.

**Audit.**
- Reentrancy: `nonReentrant`, and the function makes no external call at all (it only receives value).
  `recoverUnclaimed` in the same batch is `nonReentrant` on the distributor and pays the Safe, whose
  receive does nothing.
- CEI: checks, then effects, no interaction. The value check runs after the loop; any failure reverts
  every credit in the call. The Safe runs both calls as one MultiSend transaction: if the credit reverts,
  the recovery reverts too and the money stays claimable-expired in the distributor (tested).
- Reachable states: any time, admin only. Only for coins whose immutable choice is Holders or Split, so
  holder money can only land where holder money comes from. Keep, Buyback, unset or foreign addresses
  revert. It cannot lower any balance, change a batch, or pay anyone: it has no transfer.
- Over/underflow: checked 0.8 adds; `sum` and each `holderBalance` are bounded by native supply, and
  `msg.value` equality makes a wrapped sum impossible without reverting first. No subtraction.
- Griefing: none from outside (admin only). A wrong attribution by the admin can only move expired holder
  money between holder coins, never out of holder balances; the script refuses anything that does not
  reconcile exactly with the distributor and the published leaf file. Sending value to the vault this way
  cannot inflate `rescueExcessNative` (liabilities rise by exactly the value) nor break I2.
- Admin trust: unchanged in kind. The admin (Safe) could already recover expired distributor money to any
  address (`recoverUnclaimed` recipient) and rescue excess; this adds a path that returns money INTO
  liabilities, not out. Replay: the same Safe batch reverts in `recoverUnclaimed` (`AmountZero`).
- Invariants: I2 holds (balance and liabilities rise by the same `msg.value`); I3 gains a term
  (`+ recovered credited`); I5 unchanged (no new exit).
- Tests: `test/HolderRecoveryBatch.spec.ts` (full holder week, partial claims, deadline, generated Safe
  batch through `MockSafeBatchExecutor`, per-coin exact credit, Safe ends at 0, atomic failure, replay,
  script refusals, non-admin / wrong sum / unknown / keep / buyback / zero / empty legs);
  `realtime-indexer/src/evm/evmCreatorChoice.test.ts` (parts per leaf, both checkers refuse moved parts).

## Audit notes per money path

| Path | Guard | CEI | Reachable in | Overflow | Griefing |
|---|---|---|---|---|---|
| Router V4 `routeTrade` | none, same as V3; every call goes to a fixed vault | stateless | `!forwardingPaused` | 0.8 checked; `a*560` is safe for `a < 2^256/560` | pausing it halts trading, same as today |
| Locker `harvest` (both) | `nonReentrant`; the sale is a self-only external call inside `try` | principal checked before and after collect; `carriedMeme` written after the sale's result; split last | registered pool, any time, permissionless | reserve*50 and sqrtP*r (r < 2^34) cannot overflow; `memeToSell - memeSold >= 0` (sold <= amount by construction: V2 min(), V3 pool pays <= `activeSwapMaxPay`) | a failed or bounded sale carries, never reverts; too little gas at the sale reverts `InsufficientSaleGas` (F9), so no caller can force a carry; sandwich unprofitable (bound vs 2x0.30% fee); a creator recipient that rejects the token -> `pendingToken`, unchanged |
| V3 `uniswapV3SwapCallback` (locker, vault) | only `msg.sender == activeSwapPool` (set just before the swap, cleared after) | pays at most the in-flight amount, in the in-flight token | only during a sale / vault swap | `owed > 0` and `<= maxPay` checked | any other caller reverts `UnexpectedCallback` |
| `accrueTradeFee` | **no** guard, on purpose: the buyback's own fee re-enters it | no external call | choice set | checked add | never pausable. A revert here would revert every trade |
| `claimCreatorFees` / `claimCreatorQuote` | `nonReentrant` | zero, then send | any | none | a creator that rejects native blocks only itself (tested: rejecting and re-entering creators) |
| `syncLpFees` | `nonReentrant` | `lpSynced` written before `withdraw` | registered non-Keep pool, recipient = vault, key = campaign | cumulative - synced >= 0 | idempotent; spoofed pool fails the locker's registration fields |
| holder convert/propose/approve/execute/veto | `nonReentrant` (approve: admin, no external call) | debit, then store, then `createBatch` | Proposed -> (Approved) -> Executed, or Vetoed | caps checked; total < 2^128 | operator key: the Safe approves the exact root + total (F5), 24 h veto, weekly cap, the distributor's `authorizeBatch` max and window |
| `buybackCurve` | `nonReentrant` | debit, call, credit refund from the returned `spent`, post-check | pre-grad, fee flat 2%, <= 95% progress | checked | sandwich bounded by 0.5% impact vs ~4% curve round trip |
| `buybackPool` / `convertBuybackNativeToQuote` | `nonReentrant` | wrap, swap (bounded, TWAP), unwrap leftover, debit `spent` | pool bound by sync | checked | bounded impact + TWAP + interval + native per-tx and weekly caps |
| `pullLockerPending` / `attributeExcessQuote` | `nonReentrant` | pull (balance delta recorded), then credit only `min(pulledUnattributed, balance - quoteLiabilities)` | any / admin | checked | cannot move another campaign's balance or unsynced LP quote (F6) |
| rescue (native / token) | `nonReentrant`, admin | check excess, send | any | checked | cannot touch liabilities, wrapped native, or held MEME |
| `creditUnclaimedHolders` (E19) | `nonReentrant`, admin | no external call; credit, then `sum == msg.value`, then liabilities | any, Holders/Split coins only | checked adds, no subtraction | admin only; returns money into holder liabilities, never out; replay reverts in `recoverUnclaimed` |
| `receive()` | none | accepts only `wrappedNative` or `factory.isCampaign` | any | – | any other sender reverts |
| operator pause | admin `setOperator(op, paused)` blocks every operator path | | | | |

## Invariants

- I1: every V4 route is conserved (Σ parts = amount), and `creator == floor(a*560/1e4)`.
- I2: `address(this).balance ≥ totalLiabilities` after every call.
- I3: per campaign, `accrued + lpCredited == claimed + balances + toHolders + buybackSpent`.
- I4: a choice is never changed once it is set.
- I5: native leaves the vault only to the destinations listed above.
- I6: for each (pool, token), `lpSynced ≤ locker.cumulativeCreatorPaid`.
- I7: bought and meme-side LP tokens end only at DEAD, or in `heldBuybackTokens` until they are flushed.

## Tests (hardhat)

- `TreasuryRouterV4.spec.ts`: the split table for 3 profiles, conservation fuzz, finalize equal to V3.
- `CreatorRewardsVaultV2.choice.spec.ts`: set once, only the factory, pct bounds, accrual for an
  unset campaign reverts, all four splits with rounding.
- `…Claim.spec.ts`: a creator that rejects native, a non-creator, re-entry.
- `…Holders.spec.ts`: propose, veto, refund, execute before and after the delay, weekly cap, Safe
  `authorizeBatch` max and window, recovery into the airdrop pot. Codes 0/1 batches are unchanged.
- `…Buyback.spec.ts`: impact bound, 95% skip, the anti-sniper window, refund accounting with
  re-entrant accrual, no graduation triggered, flush only after `tradingEnabled`, recipient is DEAD.
- `…LpFees.fork.spec.ts`: BNB fork with real Topaz and RH fork with real Uniswap V3. Graduate a keep
  coin and a holders coin by the same creator. The keep coin pays the creator. The holders coin pays
  the vault, `syncLpFees` credits exactly 80% of harvest, the creator's
  `updateCreatorPayoutRecipient` leaves the holders coin untouched, and a double sync credits 0.
- `CutoverV4.spec.ts`: the Safe batch above in order. After step 6, an old-router unlinked route
  reverts; the recovery batch works against V4.

## Open questions for the founder

1. ~~Meme-token side of LP fees on non-keep coins.~~ Superseded by E9: every harvest sells the MEME side
   in the pool, on every coin.
2. ~~Quote-bound coins with a non-keep choice.~~ Superseded by E10: all choices, built as above.
3. ~~(Q4) Topaz pool fee at registration.~~ Decided by E13 (accept and record); built, see
   "E13 as built" below.
4. **Buyback and holder caps per chain** (`EVMGEN_BUYBACK_MAX_PER_TX`, `..._PER_CAMPAIGN_WEEK`,
   `EVMGEN_HOLDER_MAX_PER_WEEK`, `EVMGEN_HOLDER_BATCH_AUTH_MAX`): the deploy script refuses mainnet
   without them.

## E13 as built (branch `claude/evm-core`, 2026-09-30): the Topaz locker accepts the pool's actual fee

Founder decision E13: Topaz's own fee manager must not be able to freeze a coin. `contracts/PermanentLpLocker.sol`:
- `REQUIRED_POOL_FEE_BPS` (30) is **removed**. `registerGraduatedPool` reads `getFee(pool, false)` from the configured
  Topaz factory and records it in `poolInfo[pool].poolFeeBps` (new last field; event `PoolFeeRecorded`). Any fee
  Topaz can set is accepted, including 0 (Topaz's zero-fee indicator); only a value above 10,000 bps (not a fee) is
  refused (`InvalidTradingFee`).
- Still refused: a stable pool (`StablePoolUnsupported`), a pool whose `factory()` is not the configured Topaz factory
  and registration before `configureRevenue` (both `InvalidTopazFactory`; before E13 an unconfigured locker skipped
  the factory check), a token pair that is not (MEME, paired) (`TokenPairMismatch`), missing LP (`LockedLpMissing`).
- **Harvest maths follow the fee.** The MEME-sale bound's sandwich argument (above: sale <= 0.25% of the reserve vs
  the attacker paying 0.30% twice) only holds while the sale stays below the pool fee. `saleImpactBps(fee) =
  min(50, fee * 5 / 3)`, so one harvest sells at most `5/6 * fee` of the MEME reserve (30 bps -> 50, exactly today's
  bound; 15 bps -> 25; 0 -> 0, a zero-fee pool accrues no fees and sells nothing). Harvest reads the live fee
  (`_refreshPoolFee`, inside a `try`, falling back to the recorded fee) and records a change, so a fee lowered after
  registration shrinks the bound at the next harvest. The sale price itself is the pair's own `getAmountOut`, which
  already charges the pool's real fee. The 80/20 split is unchanged.
- **Factory kind probe.** Both lockers now answer `REQUIRED_LIQUIDITY_KIND()` (V2 = 1, V3 = 2), and
  `LaunchFactory`'s constructor requires it to equal the router's detected liquidity kind (`LockerKindMismatch`); a
  contract without the selector reverts the constructor. Safer than before: the old V2 probe only checked that a
  30 bps getter was non-zero.
- `CreatorRewardsVaultV2`'s V2 `poolInfo` interface gains the trailing `poolFeeBps` (static field; the vault ignores it).

Audit block (the diff):
- **Reentrancy.** `registerGraduatedPool` is `onlyAdmin` (the factory) and makes only view calls (pool, factory
  `getFee`, LP balance) before its writes. `harvest` stays `nonReentrant`; the new `getFee` read is a `staticcall`
  inside `try`, before `claimFees`'s effects are used; `sellMemeForPaired` stays self-only and takes the bound as an
  argument (`OnlySelf` for any other caller).
- **CEI.** Harvest: principal check, claim, principal re-check, fee read + record (`poolInfo[pool].poolFeeBps`, a
  storage write under the guard that no later step reads from storage), bounded sale in `try`, `carriedMeme`, split.
- **Reachable states.** Registration: once per pool, admin only, configured locker only. Harvest: registered pool,
  permissionless, any time. A fee change by Topaz can only shrink or restore the sale bound (capped at 50 bps).
- **Overflow.** `poolFee <= 10_000` before the `uint16` cast; `fee * 5` with `fee <= 10_000`; live values above 10,000
  are ignored (recorded fee kept), so the cast never truncates.
- **Griefing.** Topaz's fee manager (a Topaz role, not ours) can no longer block a graduation by setting a custom fee.
  A fee lowered to near zero lowers the harvest's MEME sale per call (more carried; nothing lost, `carriedMeme`
  accumulates); a zero fee means no fees accrue at all. A reverting or hostile `getFee` cannot revert a harvest (try,
  fallback). A sandwich of the permissionless harvest remains unprofitable at every fee (sale < fee x reserve).
- **Tests.** `evmgen-fees-locker-v2.spec.ts` (E13: probe + bound table; 15 bps registration recorded, harvest exact
  at the 25 bps bound with the pair charging 15 bps; fee change after registration recorded and used, fee 0 sells
  nothing; stable / foreign factory / unconfigured / >100% still refused), `PermanentLpLockerTopazFee.spec.ts`
  (100 bps recorded), `BnbLifecycleCertification.spec.ts` (a campaign graduates through the real factory while
  Topaz reports 100 bps; the pool is registered with `poolFeeBps = 100`). The mock pair's swap fee now follows its
  factory's `getFee` (30 by default, so every other test is unchanged).
