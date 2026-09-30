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
- `vetoHolderBatch(batchId)`, onlyAdmin, allowed until executed. It credits every amount back.
- `executeHolderBatch(batchId)`, onlyOperator, allowed after `executableAt`. It sets executed and then
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

## Audit notes per money path

| Path | Guard | CEI | Reachable in | Overflow | Griefing |
|---|---|---|---|---|---|
| Router V4 `routeTrade` | none, same as V3; every call goes to a fixed vault | stateless | `!forwardingPaused` | 0.8 checked; `a*560` is safe for `a < 2^256/560` | pausing it halts trading, same as today |
| `accrueTradeFee` | **no** guard, on purpose: the buyback fee re-enters it | no external call | choice set | checked add | never pausable. A revert here would revert every trade |
| `claimCreatorFees` | `nonReentrant` | zero, then send | any | none | a creator that rejects native blocks only itself |
| `syncLpFees` | `nonReentrant` | `lpSynced` written before `withdraw`/transfer | registered non-Keep pool | counter subtraction ≥ 0 | idempotent; a spoofed pool fails the locker checks |
| holder propose/execute/veto | `nonReentrant` | debit, then store, then `createBatch` | Proposed → Executed or Vetoed | caps checked | operator key: 24 h veto plus caps |
| `buybackCurve` / `buybackPool` | `nonReentrant` | debit, then call, then credit refund, then post-check | pre-grad (≤ 95%, after 60 s) / post-grad | checked | sandwich bounded by 0.5% impact vs 4% (curve) or 0.6% (pool) round-trip fees |
| `receive()` | none | accepts only `wrappedNative` or `factory.isCampaign` | any | – | any other sender reverts |
| operator pause | admin sets `operatorPaused`, which blocks buyback and holder paths only | | | | |

Choice front-running is impossible: the choice is set once, inside the create transaction, by the
factory.

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

1. **Meme-token side of LP fees on non-keep coins.** Solana's graduated pool collects fees in SOL
   only, so the question never comes up there. On EVM both sides earn fees. Proposed: burn the
   meme-token side (to DEAD) for holders, split and buyback coins. For split coins, the creator would
   then get no meme-token LP fees.
2. **Quote-bound coins (BNB quote tokens, Robinhood stocks) with a non-keep choice.** Their LP fees
   are in the quote token, while holder batches and buybacks are native only. Proposed: the factory
   refuses a non-keep choice on quote-bound coins in this generation, and allows it later with a quote
   path.
