# EVM generation 8: internal audit of the production contracts (step 1)

Status 2026-10-11. Branch `build/evm-gen8` (worktree `~/mwz-wt/evm-gen8`, from `research/v4-hook-fork-proof` at
`8f73d7fd`). Nothing here is deployed. All runs are local: the hardhat network and anvil forks of BNB Chain 56 and
Robinhood Chain 4663 with fresh test keys. This is our own review, written so an external auditor can start from it;
it is not a substitute for the paid external audit (D11).

Spec: `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` (decisions D1 to D14, invariants I1 to I13 in 2.9, auditor points
A1 to A15 in 8.2). Research proof: `scripts/research/v4-hook/` (702/702 on both forks).

Contents: 1 scope, 2 results, 3 actors and trust, 4 money paths per contract, 5 invariants, 6 auditor points A1 to A15,
7 top risks, 8 known limitations, 9 deviations from the design doc, 10 what steps 2 and 3 need, 11 external audit
scope, 12 deployment (dry run), 13 gas and sizes, 14 verification manifest.

---

## 1. Scope

| File | Lines (total / code) | Role |
|---|---|---|
| `contracts/gen8/MwzLaunchHook.sol` | 693 / 548 | The V4 hook: fees, liquidity lock, graduation latch, creator ledger, router bucket, display call |
| `contracts/gen8/libraries/MwzSwapSim.sol` | 125 / 101 | External library (linked): exact replay of `Pool.swap` for price-limited swaps |
| `contracts/gen8/libraries/MwzFeeMath.sol` | 37 / 20 | Internal library: rate schedule and exact-output gross, shared by hook and lens |
| `contracts/gen8/interfaces/IMwzLaunchHook.sol` | 50 / 40 | `FeeConfig` and the hook view interface |
| `contracts/gen8/MwzLaunchLens.sol` | 79 / 57 | Stateless views: `currentFeeBps`, `previewFill`, `grossForNet`, `progress` |
| `contracts/gen8/MwzV4Launcher.sol` | 460 / 367 | One-transaction launch with L1 to L5 |
| `contracts/gen8/MwzV4Token.sol` | 13 / 7 | Plain 1B ERC20 |
| `contracts/gen8/MwzReserveLock.sol` | 83 / 60 | 2% creator reserve until graduation (D6 R2) |
| `contracts/gen8/MwzCreatorEscrow.sol` | 126 / 96 | App creator-buy escrow, gen-7 schedule (D5 E1) |
| `contracts/gen8/MwzFeeSplitter.sol` | 189 / 144 | Bounded router-bucket splitter (D1 A) |
| `contracts/gen8/MwzCreatorChoiceVault.sol` | 468 / 373 | Holders / split / buyback choice (D2) |
| `contracts/gen8/MwzDisplayPair.sol` | 130 / 93 | Display pair + factory with `factory()` (D10, BNB only) |

Total 2,453 lines, about 1,906 lines of code. Out of scope: `contracts/gen8/test/*` (test helpers), the unchanged gen-7
contracts the system is wired to (GraduationOracle, CommunityRewardsVault, the league / recruiter / protocol vaults,
RewardDistributor), Uniswap v4-core 1.0.2 and v4-periphery 1.0.3 (pinned exactly, as in the proof).

Compiler: solc 0.8.26, EVM cancun, via-IR, optimizer 200 runs, `bytecodeHash: none`, in a separate
`hardhat.gen8.config.ts` (earlier generations keep their 0.8.24 build untouched). OpenZeppelin 5.4.0 (root lockfile;
the proof used 5.1.0: only ERC20, SafeERC20, ReentrancyGuard, ECDSA, MessageHashUtils, Math and Checkpoints are used,
none changed behaviour between the two).

## 2. Results

| Suite | Command | Result |
|---|---|---|
| Local unit + property + gas/size (hardhat, v4-core 1.0.2 PoolManager built locally) | `npx hardhat --config hardhat.gen8.config.ts test` | 80 tests passing (77 before V13; +3 splitter plan tests) in about 5 minutes, including 10 seeded property runs of 220 actions (see 2.1) |
| Property runs, larger campaign | `GEN8_FUZZ_SEEDS=101..140 GEN8_FUZZ_STEPS=300` | 40 seeds x 300 random actions, all invariants checked after every action: 40 / 40 passing (after V13 the splitter step also lands fees and third-party claims between plan and route: 74 late fees, 79 re-plans) (12,000 actions, about 8 minutes) |
| Fork suite, production contracts, BSC 56 + Robinhood 4663, $30K + $50K | `node scripts/gen8/fork-suite/run-fork-suite.mjs` | 746 / 746 PASS (134 s) |
| Research equivalence | `node scripts/gen8/fork-suite/compare-with-research.mjs` | all 702 research checks present and passing (one renamed on purpose, D6) |

### 2.1 What the local suite covers

- `test/gen8/hook.spec.ts`: flags and immutables; constructor zero checks and the flags check; every callback is
  PoolManager-only; unused callbacks revert; `createPool` launcher-only, every cap, every bad range, zero addresses,
  existing pool; launch state (A 850M, B 130M, LP fee 0, dust burned, supply fully accounted); outside initialize /
  add / remove / donate; all four swap types exact to the wei with V4Quoter equality and the D2 creator share;
  exact-input dust 0..2 wei over 60 sizes; the 60 s decay for buys and sells at 8 offsets; partial fills inside A,
  across A/B, at the boundary, inside B, back into A; a passed limit; the 0.1% Uniswap protocol fee forced on; the
  latch (one coin short, crossing, exact boundary, re-crossing); post-graduation 1% with creator exactly 0.5% of volume;
  creator claims, transfers, a rejecting creator contract, reentrancy from a creator's `receive()`; a swap made from
  inside a payout; oversized swaps revert `PartialFill`; `claimRouter`, timelock, cancel, A4 flush, a refusing router;
  two-step ownership and the full list of state-changing functions; display Sync + Swap, a reverting and a gas-burning
  display; Robinhood without display; per-coin isolation.
- `test/gen8/launcher.spec.ts`: constants (L1); constructor wiring checks (hook bound elsewhere, unbound vault or lock,
  zero owner, oracle band, oracle age); `plan()` equals gen-7 `curveForMarketCap` and the nearest grid ticks; target
  allow-list (L2); stale / zero / out-of-band oracle refuses launches but never trading (L3); C8 bounds; the signature
  digest equals the API scheme; expired, too long, wrong signer, someone else's signature, tampered request, replay,
  malleable high-s signature (L4); signer rotation and zero signer; create pause launches-only (L5); request checks;
  atomic launch and no leftover coins or native; first buy below and above 70%; slippage; fee-choice wiring; callback
  outside launch; ownership; the token's function list.
- `test/gen8/periphery.spec.ts`: reserve lock (launcher-only lock, release only after graduation, follows the hook or
  vault creator, once); escrow (schedule 20% at 30 days then every 7 days, only the buyer, rejects); splitter (exact
  league, band edges, squad cap, run ids, operator / admin, receive guard, refusing destination, routing after a router
  change, post-graduation-only run); choice vault (registration, pull by choice, split creator claim, transfer, holder
  batches with approve / veto / execute / weekly cap / unclaimed re-credit, buyback caps, impact, 60 s window, 95% rule,
  rescue of excess only); display factory and pair writes.
- `test/gen8/invariants.spec.ts`: seeded random sequences (buys and sells of all four types, price-limited swaps, time
  jumps including the 60 s window, graduation, creator and router claims, vault pulls, splitter runs with random splits
  inside the band, escrow buys, creator transfers, reserve releases) on a keep coin and a buyback coin, display on and
  off. After every action: I1, I2, I3, I4, I5, I6, I7, I8, I11, I12, I13, splitter accounting, vault liabilities.
  Plus a math fuzz of `grossForNet` (400 random pairs) and the decay table.
- `test/gen8/gas-and-sizes.spec.ts`: EIP-170 for every contract, hook <= 21,500 bytes, the gas table in section 13.

## 3. Actors, powers and trust assumptions

| Actor | Can | Cannot |
|---|---|---|
| Any trader, bot, router, aggregator | Trade at the coin's stored rate; set any `hookData` (analytics only); set price limits | Avoid the fee in our pool; add, remove or donate liquidity; initialize a pool with our hook |
| Coin creator (hook) | Claim the coin's creator ledger to any address; hand the right over in two steps | Touch rates, liquidity, other coins, the router |
| Human creator (choice vault, holders / split / buyback coins) | Claim the split part; hand the right over in two steps; receive the reserve at graduation | Change the choice; move holder or buyback balances |
| MemeWarzone Safe as hook owner | Redirect the router bucket after 48 h (bucket accrued before the change is flushed to the old router first); transfer ownership in two steps | Change rates, creators, creator balances or liquidity; pause trading; withdraw anything |
| Safe as launcher owner | Pause / open launches; rotate the create signer; transfer ownership | Touch any launched coin, any balance or trading |
| API create signer (D3) | Authorize a launch for a named creator wallet, request and deadline (max 1 day) | Trade, move money, change rates; reuse an authorization; authorize for another wallet, chain or launcher |
| Safe as splitter admin | Set the operator; run the same bounded route | Change destinations or bands; withdraw |
| Splitter operator (new key, Zodiac Roles) | Choose, per run, how the recruiter + squad + airdrop band is split (inside the band, squad capped) and when to run | Send money to a wallet, change the league share or the protocol remainder, skip or invent value |
| Safe as choice-vault admin | Approve or veto holder batches; set caps (impact cap at most 50 bps); set the operator; re-credit unclaimed holder payouts; rescue native above every liability | Move creator, holder or buyback balances elsewhere |
| Choice-vault operator | Propose holder batches (need admin approval); execute approved batches after the delay; run capped buybacks | Pay itself; exceed caps; execute an unapproved batch |
| Gen-7 GraduationOracle (Chainlink feed) | Size the curve of a coin at launch | Affect trading, fees or graduation of any launched coin |
| Uniswap governance | Turn on the V4 protocol fee for a pool (max 0.1%) | Touch the hook's state or balances |
| Deployer EOA | Deploy in the planned order; set the display factory's hook once | Anything after deployment (all owners are the Safe from the constructor) |

Trust assumptions, stated plainly:

1. The Safe is honest within its powers above. Its strongest money power is the router redirect, delayed 48 h and
   alerted on `RouterProposed` (design 6.8).
2. The API create signer only signs launches the API accepts (bans, metadata, drafts). A stolen key can launch coins in
   our name but cannot touch money; the Safe pauses launches (`setCreatePaused`) or rotates the key.
3. The splitter operator computes the per-trade split off chain. A stolen key can only move value between the airdrop
   pot and the recruiter / squad pots inside the band, and only into our vaults. Reproducibility: `accrualRoot`.
4. The oracle is read once per launch, never during trading. A wrong price mis-sizes one coin's curve within the
   immutable band (BNB $50 to $20,000, ETH $100 to $50,000 in the draft inputs).
5. The four destination vaults of the splitter accept plain native (they do for the gen-7 router today). If one stops
   accepting, splitter runs revert and the funds wait in the splitter (see 7, risk 4).

## 4. Money paths per contract

For each path: reentrancy guard; checks-effects-interactions order; which states can and cannot reach it;
over/underflow; how it can be griefed.

### 4.1 MwzLaunchHook

**beforeSwap / afterSwap** (fee charge, latch, display)
- Guard: `onlyPoolManager`; only reachable inside a PoolManager swap of a pool whose key names this hook. No
  `nonReentrant`: the callbacks must work for swaps made while another unlock is open (routers, the launcher, the
  vault, the escrow, and a payee swapping from inside a payout). Their accounting is self-contained per swap and keeps
  I4 in every case (test "a swap made from inside a payout keeps I4 exact").
- CEI: the fee is computed, minted as an ERC6909 claim and booked (`_accrue`) before the swap's money moves; the latch
  runs after the fee; the only call to a non-PoolManager address, the display update, is last and capped at 60,000
  gas with no return data copied.
- States: any launched pool, before or after graduation. Unknown pools revert `UnknownPool` in `beforeSwap` (and cannot
  exist anyway: `beforeInitialize` reverts for everyone but the hook).
- Over/underflow: `cost = mulDiv(g, B, B + rate)` with `rate <= 9000`; `fee = g - cost >= 0`; `grossForNet` is a
  ceiling division then at most 11 decrements; fee <= amount in every type; `toInt128` reverts above 2^127 (a swap of
  that size cannot exist); ledgers are `uint128` with checked additions (the native supply of both chains is below
  2^128 wei, so the revert is unreachable). A revert here would only revert that swap.
- Griefing: a swap that the simulation does not predict exactly reverts `PartialFill` rather than mis-charging (A1);
  an oversized exact-output sell or exact-input buy without a limit reverts `PartialFill` (tested). A 1-wei exact-input
  buy pays 1 wei and receives 0 coins (no harm; the indexer must not count it as a buyer). Display gas forcing only
  drops one display update (A2).

**_graduate** (the latch)
- Inside `afterSwap` only. `graduated = true` is written first and never reset (I7). Then the only liquidity removal
  that exists: `floor(liqA * 200 / 10000)` from A, which at a price at or below `sqrtGrad` is native only (I6); the
  returned native is minted as a claim and added to `routerOwed` and `pendingGradFees`. The coin leg is 0 by
  construction; if it ever were not, it goes to `0xdEaD` (unreachable branch kept from the proof).
- States: not graduated and the post-swap price at or below `sqrtGrad`. Re-crossing never triggers it again.
- Over/underflow: `liqA * 200` in 256 bits; removal fits `uint128`.

**claimCreator(id, to)**
- Guard: `nonReentrant` (hook-wide lock shared with `claimRouter` and `executeTreasuryRouter`).
- CEI: checks (caller is the coin's current creator, `to != 0`, amount > 0), effect (`creatorOwed[id] = 0`), then the
  payout `unlock -> burn claim -> take native to `to`` as the last call. A reverting recipient reverts the claim and
  the balance stays (A13).
- States: any time, any phase. Only the current creator; the owner has no path (I9).
- Griefing: none on others; the recipient can only hurt its own claim.

**claimRouter()** and **executeTreasuryRouter()** (`_payRouter`)
- Guard: `nonReentrant`.
- CEI: the bucket and the pending bonding / graduation fee counters are moved into `routerPaid[router]` and zeroed,
  then the payout is the last call. In `executeTreasuryRouter` the payout to the old router is tolerant: on failure
  the state is restored exactly and `RouterFlushFailed` is emitted, then the router changes; the bucket follows the new
  router. This prevents a refusing router from blocking a change forever.
- States: `claimRouter` any time with a non-zero bucket, by anyone; `executeTreasuryRouter` only by the owner, only
  with a pending proposal at or after its eta (48 h).
- Over/underflow: `routerPaid` sums are `uint256`.
- Griefing: anyone can call `claimRouter` at any time; it only pays the current router. The owner could make a flush
  fail only by having proposed a router that refuses native 48 h earlier (it already controls the destination).

**createPool** (launcher only) and **unlockCallback**
- `createPool` checks the caller, every cap (bonding <= 200, post <= 100, creator post <= post, start in
  [bonding, 9000], creator bonding <= 1000) and the tick range, writes the pool state, then initializes (the hook's own
  call skips `beforeInitialize`), seeds A and B through its own unlock, burns the dust, and creates and seeds the
  display pair. `unlockCallback` is `onlyPoolManager` and only ever entered through the hook's own `unlock` (the
  PoolManager calls back the unlocker), with two actions: seed and payout.

**Owner functions**: propose / cancel / execute router (48 h), two-step ownership. The full state-changing ABI is
asserted in a test: `acceptCreator, acceptOwnership, afterSwap, beforeSwap, cancelTreasuryRouter, claimCreator,
claimRouter, createPool, executeTreasuryRouter, proposeCreator, proposeTreasuryRouter, transferOwnership,
unlockCallback`. There is no rate setter, no withdraw, no pause, no liquidity function.

### 4.2 MwzV4Launcher

**launch(req, auth)** (payable)
- Guard: OpenZeppelin `nonReentrant`; `unlockCallback` additionally requires the guard to be entered, so the launcher
  can only be a swap sender inside `launch` (A11).
- CEI: checks (pause, request fields, target allow-list, fee choice, `msg.value == firstBuyValue`, authorization:
  signer set, not expired, at most 1 day, ECDSA recover equals the signer, digest unused), effect (digest marked used,
  `nonce++`), then calls into our own contracts only: token deployment, choice-vault registration, coin transfers to the
  hook and the reserve lock, reserve lock record, `hook.createPool`, and the first buy through the PoolManager. The
  first buy's coins go straight to the creator (`take`); `msg.value` is settled entirely (the callback reverts unless
  the exact input was consumed whole), so the launcher never holds native. It has no `receive()`.
- States: launches open (`createPaused == false`), a create signer set, the oracle fresh and inside the band.
- Over/underflow: gen-7 integer math (`mulDiv`), C8 bounds (market cap >= 0.001 native, virtual native <= 1e30);
  `vN * vT` < 2^256 inside those bounds.
- Griefing: front-running the creator's signed request fails (the digest binds `msg.sender`); replays fail; a
  different launch before ours only changes our token's CREATE2 salt nonce. The 70% cap and `minFirstBuyOut` bound the
  first buy.

### 4.3 MwzReserveLock

- `lock`: launcher only, once per pool, after the launcher transferred the reserve (`balanceOf >= amount`; the coin is
  brand new, so the balance is exactly this reserve).
- `release(id)`: `nonReentrant`; checks (amount > 0, hook says graduated, beneficiary non-zero), effect (amount = 0),
  then the token transfer (our plain ERC20, no callbacks). Beneficiary: the hook creator, or the human creator in the
  choice vault when the hook creator is the vault. Permissionless, once.
- If a coin never graduates, its reserve stays locked (same as gen-7). No owner, no rescue.

### 4.4 MwzCreatorEscrow

- `buy(token, minOut)`: `nonReentrant`; the pool must be one of ours; the swap runs through the escrow's own unlock
  (callback gated by the guard and the PoolManager); then the checkpoint is written; the unspent native (only on a
  partial fill) is refunded to the buyer as the last call. Beneficiary is always `msg.sender`.
- `claim(token)`: `nonReentrant`; claimable = vested by the gen-7 formula minus claimed; effect before transfer.
- Cumulative amounts are `uint208` (supply 1e27 fits); timestamps `uint48`.
- Griefing: none; anyone can only escrow their own buys.

### 4.5 MwzFeeSplitter

- `route(runId, expectedPaid, recruiter, squad, airdrop, accrualRoot)` (V13): operator or admin, `nonReentrant`,
  `runId == runs + 1`, and `hook.routerPaid(this).amount == expectedPaid` or `PaidMismatch(expected, actual)`. It never
  claims: the operator claims (`hook.claimRouter()`, permissionless) and plans first. It reads
  `hook.routerPaid(this)` and routes exactly the difference since its last run: league = floor(3750 x B / 10000), weekly
  30% of that, monthly the rest; `recruiter + squad + airdrop` in [1500 B + 1750 G, 1750 B + 2000 G] / 10000 and
  `squad <= 250 (B + G) / 10000`; protocol = total minus the rest. Effects (run counter, routed totals) before the
  payouts; any failed payout reverts the whole run. `receive()` accepts the PoolManager only.
- Over/underflow: checked arithmetic; `committed > total` reverts `OutOfBand` (cannot happen for honest inputs: the
  bands leave at least 39% of bonding fees and 80% of graduation fees for the protocol).
- Griefing: a destination vault that refuses native blocks runs (funds wait; see risk 4). Forced native (selfdestruct)
  stays in the splitter forever (no withdraw by design).

### 4.6 MwzCreatorChoiceVault

- `pull(id)`: `nonReentrant`; permissionless; claims the hook ledger into the vault and requires the balance delta to
  equal the claimed amount before crediting by the fixed choice.
- `claimCreatorFees(id, to)`: human creator only, `nonReentrant`, zero then pay.
- Holder batches: operator proposes (moves holder balances into the batch, weekly cap), admin approves the exact root
  and total, operator executes after the delay (`totalLiabilities -= total`, then `createBatch{value}`), admin can veto
  until execution (balances restored). Unclaimed re-credit is admin-only and requires `msg.value` equal to the sum.
- `buyback(id, amountIn)`: operator, `nonReentrant`; buyback coins only; caps per tx, per coin-week and interval;
  outside the 60 s window; before graduation `(nativeInA + amountIn) <= 95%` of A's target; the swap carries a price
  limit at the impact cap (at most 50 bps, admin-set) and may partially fill; balance and liabilities are reduced
  before the swap and the unspent part is credited back after it; coins go straight to `0xdEaD`.
- `rescueExcessNative`: admin, only native above `totalLiabilities` (forced sends only, since `receive()` accepts the
  PoolManager only). Invariant `totalLiabilities == balance` is checked after every action in the property runs.

### 4.7 Display pair and factory, lens, library

No money. The display pair holds nothing and has no swap, mint or burn. Only the hook writes to it; its reserves are
clamped to `uint112` for display. The lens and `MwzSwapSim` are views.

## 5. Invariants (design 2.9)

| # | Invariant | Enforced by | Tested in |
|---|---|---|---|
| I1 | Fee = gen-7 formula to the wei (+0..2 wei on exact-input buys) | `beforeSwap` / `afterSwap` math | hook.spec (all types, quoter), invariants (every trade), fork suite (every router path) |
| I2 | Fee only on the filled part of a limited swap | `MwzSwapSim` replay + `PartialFill` check | hook.spec partial fills, invariants, fork suite |
| I3 | Rate <= 9000 in the window, == bonding after, == post after graduation | `MwzFeeMath.rate`, launcher constants, hook caps | hook.spec decay table, invariants (every trade vs block time) |
| I4 | Claims held == routerOwed + sum(creatorOwed) | single `_accrue` / `_graduate` / payout paths | after every action in the property runs; payout reentrancy test |
| I5 | The hook never holds coins | dust burned at seed; no coin path | property runs, fork suite |
| I6 | A and B lose liquidity only once, floor(liqA x 2%) from A at graduation | no remove path; add / donate / initialize revert | position liquidity read from PoolManager storage after every action |
| I7 | `graduated` false to true once, only at price <= sqrtGrad | latch in `afterSwap` | property runs (latch condition and monotonic), hook.spec |
| I8 | Post-graduation creator share == floor(curve x creatorPostBps / 10000) | `_accrue` | every trade in the property runs |
| I9 | Only the creator moves its ledger | `claimCreator` check | hook.spec |
| I10 | Router changes only via propose + 48 h + execute | owner functions | hook.spec, fork suite |
| I11 | A swap never reverts because of the display | 60k gas cap, no return data | hook.spec, fork suite, property runs |
| I12 | Stored rates never change | no setter | property runs, fork suite |
| I13 | Supply 850M + 130M + 20M, seed uses the coins sent, dust burned | launcher constants, seed | hook.spec, property runs |

## 6. Auditor points A1 to A15

| # | Point | How it is handled in production |
|---|---|---|
| A1 | Simulation drift | `MwzSwapSim` is the proof's replay, moved verbatim into a linked library; `afterSwap` still reverts `PartialFill` on any difference. Exact under the 0.1% protocol fee (unit and fork). |
| A2 | Display gas forcing | Accepted: one missed display update, `DisplayUpdateFailed`; money never reads the display. |
| A3 | `tx.origin` in the display `to` | Display only; nowhere else. |
| A4 | Router redirect window | Implemented: `executeTreasuryRouter` flushes the bucket to the old router first, tolerant of a refusing old router. Alert on `RouterProposed` stays an indexer task (step 3). |
| A5 | Side pools | Out of contract scope; watcher in step 3. |
| A6 | Uniswap protocol fee up to 0.1% | Our fee stays gen-7 exact on the curve amount the PoolManager reports; quotes include it (tested both places). Disclose. |
| A7 | Timestamp | 60 s decay on `block.timestamp`, as gen-7. Accepted. |
| A8 | Oracle | Read once per launch: try/catch around both oracle reads, immutable sane band on the price, gen-7 C8 bounds, oracle age window <= 2 days checked at deploy. Never read by trading. |
| A9 | Hook size | 16,708 bytes runtime (target 21,500; limit 24,576) after moving the replay into `MwzSwapSim` and previews into the lens. |
| A10 | Exact-input buy fee = g - cost | 0..2 wei above the gen-7 floor; measured 0..1 on forks, 0..2 bound proven over 60 sizes. In the protocol's favour. |
| A11 | Launcher rate exception | Launcher swaps only from its callback, which only runs inside `launch` (OZ guard entered) and only from the PoolManager. Tested. |
| A12 | Crossing swap pays bonding on its whole amount | Kept by design; `HookFee.graduated == false` for that swap, so the indexer books it as bonding. |
| A13 | Claim to a contract that rejects native | Reverts, balance stays, claim to another address works. Tested. |
| A14 | Reentrancy | Claims and the router flush share one `nonReentrant` lock and zero state before paying; callbacks are PoolManager-only; `unlockCallback` only through the hook's own unlock. New fact found while building: a payout recipient runs while the PoolManager is unlocked and can swap in our pool from its `receive()`; this is safe because every swap books itself (tested). |
| A15 | Research launcher accepted caller fees and any target | Fixed: rates are launcher constants (no fee field in the request), targets are an allow-list. |

## 7. Top risks (ranked)

1. **The hook is immutable and holds every coin's fees and liquidity.** A bug in fee math or the latch cannot be
   patched. Mitigation: small surface, every path tested to the wei on two forks and two targets, property runs, and
   the paid external audit before mainnet (D11). This is the risk that matters most.
2. **Off-chain split correctness (D1).** The splitter bounds the operator, but the per-trade attribution (recruiter
   links at trade time, `tx.from`) lives in the indexer. Wrong attribution moves value between recruiter and airdrop
   pots inside the band. The indexer must compute run amounts from aggregate sums (`bands()`), not by summing per-trade
   floors, or a run can miss the lower band by a few wei and revert.
3. **Router redirect by the Safe.** 48 h timelock, flush first, alert required. A compromised Safe can redirect future
   protocol and community income after 48 h; it cannot touch creator money or liquidity.
4. **Splitter liveness depends on four immutable destinations.** If the weekly league vault, monthly treasury,
   recruiter vault or protocol destination stops accepting native, every run reverts (the band can be moved away from
   the community vault and the recruiter vault, but the league and protocol shares cannot). Funds are not lost: the hook
   can be pointed at a new splitter (48 h) for future income, but what already sits in the old splitter waits until the
   destination accepts again. All four are Safe-administered gen-7 contracts.
5. **API create key.** A stolen key can launch coins (no money power). Pause and rotate are immediate.
6. **Oracle at launch.** A manipulated or broken feed mis-sizes a coin's curve within the band. Chainlink feeds, band,
   staleness.
7. **Partial-fill replay.** Exact because the hook blocks outside liquidity. If Uniswap ever changed `Pool.swap`
   semantics, our hook is bound to v4-core 1.0.2 behaviour of the deployed PoolManager, which is immutable on both chains.

## 8. Known limitations (disclose to users and the external auditor)

- Side pools: anyone can pair our coin elsewhere without our fee (A5).
- Uniswap protocol fee: up to 0.1% on top if Uniswap governance turns it on (A6).
- The swap `sender` is the router, not the trader: the hook cannot know the trader; attribution uses `tx.from`; ERC-4337
  wallets show the bundler and default to the unlinked profile.
- Timestamp decay: validators / the sequencer can skew `block.timestamp` by seconds (A7).
- Creator buys outside our app are not escrowed (D5).
- A 1-wei buy pays 1 wei and gets nothing; HookFee shows `curveAmount == 0`.
- Oversized swaps without a price limit revert `PartialFill` (they cannot fill anyway). An exact-output buy of more
  coins than the pool holds reverts inside the PoolManager with `SafeCastOverflow`, as on any V4 pool. Both were found
  by the property runs (the generator asked for 14.0M coins when the pool held 10.7M) and are now unit-tested.
- Coins or native sent to the hook, the splitter or the display contracts by mistake are not recoverable (no owner
  power over assets by design). The choice vault can rescue native above its liabilities.
- A reserve of a coin that never graduates stays locked, as in gen-7.
- Splitter destinations are immutable (see risk 4).

## 9. Deviations from the design doc (all deliberate, each needs the founder's eye)

| # | Doc | Production | Why |
|---|---|---|---|
| V1 | 3.4: the splitter "tracks received per run" from `claimRouter` | The hook keeps `pendingBondingFees` and `pendingGradFees` (packed with `routerOwed`) and records per payee `routerPaid(router) = {amount, bondingFees, gradFees}`; the splitter routes the difference since its last run | The bands (league exactly 37.5% of bonding fees; the 1500..1750 / 1750..2000 bands) need the split of each run into bonding and graduation fees. A plain native transfer cannot carry it and the operator must not supply it. This adds state to the hook that the doc's state table does not list. Not a design change in the doc's sense (the bands are as written), but it touches the hook, so it is called out. |
| V2 | 3.4: `route(runId, amounts[], accrualRoot)` | `route(runId, recruiter, squad, airdrop, accrualRoot)`; league amounts are computed on chain; protocol is the remainder | Makes "sum == received" true by construction and removes two operator inputs. `runId` must be the next number (idempotent worker). |
| V3 | 2.7 step 1: `_grossForNet` into the external library | `grossForNet` stays an internal function in `MwzFeeMath`, compiled into both hook and lens | It runs on every exact-output sell; a library call would add a DELEGATECALL to swaps without a limit. Same source for hook and lens. |
| V4 | 2.3: `previewFill`, `currentFeeBps` on the hook | On `MwzLaunchLens` (doc 2.7 step 2 says so); the hook keeps `poolKeyFor` | Size. App, API and aggregators call the lens. |
| V5 | 2.3 event `HookFee(id, swapSender, referrer, buy, curveAmount, fee, feeBps, creatorShare)` | Adds `bool graduated` after `buy` | The indexer needs the phase of each fee for D1 and D14 without replaying the latch order. |
| V6 | D2 (a): creator bonding share | `creatorBondingBps = 560` of every pre-graduation fee, including launch-window fees and the creator's own first buy | Same base as gen-7 (`TreasuryRouterV4.routeTrade` gets the whole fee). |
| V7 | Gen-7 signs `firstBuyTokens` / `firstBuyMaxCost` | Gen-8 signs `firstBuyValue` (must equal `msg.value`), `minFirstBuyOut` and an API `salt` | The first buy is exact-input in V4. |
| V8 | "metadata as gen-7" | Same fields (name, symbol, logoURI, xAccount, website, extraLink) plus `metadataHash`, signed, emitted in `LaunchMetadata`; not stored in an on-chain array | Gas; the indexer reads events today. |
| V9 | L3 "staleness and band check as gen-7 C8" | Gen-7 C8 bounds kept; plus an immutable USD band on the oracle price and the oracle's own age window <= 2 days checked at deploy | The task asked for a band; gen-7 had only the market-cap bounds. 2 days because the Robinhood oracle allows 90,000 s (Chainlink ETH/USD 24 h heartbeat); 1 day refused it on the fork. |
| V10 | D3 "keeps bans (RiskRegistry)" | Bans stay in the API signer; no on-chain RiskRegistry / CreatorRegistry call at launch | The signature is the gate; fewer moving parts in the launcher. Say if on-chain bans are wanted. |
| V11 | D5 E1 "creator buys made in our app" | The escrow accepts anyone's buys, always for `msg.sender` | No harm (you can only lock your own coins); simpler than resolving the creator through the hook or the vault. |
| V13 | 3.4 / V2: the run routes "what was received" and `route()` claimed the bucket itself | `route(runId, expectedPaid, recruiter, squad, airdrop, accrualRoot)`: no claim inside `route`; reverts `PaidMismatch(expected, actual)` unless `hook.routerPaid(this).amount == expectedPaid` (cumulative) | Found by the step-3 indexer work, founder go 2026-10-11. With the auto-claim (and `claimRouter` being permissionless) fees that landed after the off-chain plan were swept into the run while recruiter / squad / airdrop were fixed, so their shares fell into protocol. Pinning the run to the planned cumulative paid amount makes B, G and total equal the plan (see the diff audit below). |
| V12 | Gas | +6.5k gas per bonding swap vs the proof (creator ledger write, D2) and +130k on launch (reserve lock, signature, registration, metadata event) | Measured on forks, see section 13. |

**V13 diff audit (MwzFeeSplitter.route, 2026-10-11).**
- Change: the line `if (hook.treasuryRouter() == address(this) && hook.routerOwed() != 0) hook.claimRouter();` is
  removed; a new input `expectedPaid` and a new check `if (paid != expectedPaid) revert PaidMismatch(expectedPaid, paid)`
  right after the `routerPaid` read. Nothing else changed (bands, run id sequencing, operator / admin, effects order,
  destinations, no withdraw). No hook change.
- Why equal cumulative paid means the plan: `_payRouter` (used by `claimRouter` and by the A4 flush in
  `executeTreasuryRouter`) moves the whole bucket together with `pendingBondingFees` / `pendingGradFees` into
  `routerPaid[r]` in one step, and nothing else writes `routerPaid`. The three cumulative counters only grow and only
  together, so `amount` equal to the planned value implies `bondingFees` and `gradFees` equal too, hence the same B,
  G and total. A tolerant flush that fails restores all three together.
- Reentrancy: `nonReentrant` unchanged. The function now makes no state-changing external call before its effects:
  the only call before them is the view `hook.routerPaid`. The removed `claimRouter()` was the one external
  state-changing call before the effects (it re-entered this contract's `receive()` through the PoolManager); its
  removal shrinks the surface.
- Checks-effects-interactions: checks (caller, run id, paid == plan, nothing to route, bands, committed <= total,
  balance >= total), then effects (`runs`, `routedAmount`, `routedBondingFees`, `routedGradFees`), then the payouts.
  Unchanged order; one more check.
- Reachable states: any time the caller is operator or admin. `expectedPaid` below or above the record reverts.
  A splitter that is no longer the hook's router still routes what it was paid (claim or flush). Fees still owed in
  the hook wait for a claim; they are never part of a run until claimed. `Underfunded` still guards the balance.
- Over/underflow: no new arithmetic; `paid - routedAmount` as before (paid only grows).
- Griefing: a third party calling `claimRouter` (or the Safe's router change flushing) between the operator's plan
  and its `route` makes `route` revert `PaidMismatch`; the operator re-plans against the new record and routes. No
  funds move, nothing is lost or misrouted; the cost is one wasted transaction per interleaving, and an attacker pays
  a `claimRouter` each time (which only pays our splitter). Fees that land after the operator's claim stay in the
  hook and go to the next run with their full league and band shares.
- Operator flow (step 3): `claimRouter()` if `routerOwed() > 0`; read `routerPaid(splitter).amount` = P; the run's rows
  are the `HookFee` / `Graduated` logs up to the `RouterClaimed` event whose cumulative paid reaches P (from the last
  run's P); compute amounts with `bands(B, G)`; `route(runId, P, recruiter, squad, airdrop, accrualRoot)`; on
  `PaidMismatch` re-plan.

Nothing in the doc turned out to be unsound. V1 is the one place where the doc did not say how a stated rule could be
enforced on chain; it is resolved inside the stated design, not by a different one.

## 10. What step 2 and step 3 need from these contracts

ABIs: `contracts/gen8/abi/*.abi.json` (regenerate with `node scripts/gen8/export-abis.mjs`). Pool id = `keccak256(abi.encode
(address(0), token, 0x800000, 10, hook))`, also emitted in `Launched` and `PoolLaunched`.

### 10.1 Events (topic0)

| Contract | Event | topic0 |
|---|---|---|
| Launcher | `Launched(address indexed token, bytes32 indexed id, address indexed creator, address hookCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut)` | `0x088cfcd47a3402b49e48e3f02ab27f94e17c8faf2fd7174441c6a1b2f22e8202` |
| Launcher | `LaunchMetadata(address indexed token, bytes32 indexed id, string name, string symbol, string logoURI, string xAccount, string website, string extraLink, bytes32 metadataHash)` | `0xb1da1fbea51ed6d80051f5210a2219d6337b68bf121164963927cd17d0a248a4` |
| Launcher | `CreatePauseUpdated(bool)`, `CreateSignerUpdated(address,address)` | `0x28c36262...2c2e07`, `0xc5a5f992...0e541e` |
| Hook | `PoolLaunched(bytes32 indexed id, address indexed token, address indexed creator, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, (uint16,uint16,uint16,uint16,uint16) fees, address display)` | `0x882a00429193dca8fdb004116ad7dab1dccf4e77ab2999afc6e0909732bd7f01` |
| Hook | `HookFee(bytes32 indexed id, address indexed swapSender, address indexed referrer, bool buy, bool graduated, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare)` | `0xb77d9c06aa8d782c4be19bbd7a54af4d03bb0eaf618c887f8d1eb5f7b0213ad2` |
| Hook | `Graduated(bytes32 indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved)` | `0x9408aa53590d2acf7d72e624d65745b71ea5a308a6cc5f2c7cbee7163b3dc332` |
| Hook | `CreatorClaimed(bytes32 indexed id, address indexed to, uint256 amount)` | `0xc1d27057937a5216efd7c1ee2b680a2a34893e3f35e3a33f70c4bf0935312664` |
| Hook | `CreatorProposed(bytes32 indexed id, address indexed current, address indexed proposed)` | `0x1cf5caa2b6a5e78ae6ef887c184ec7769be961dc26752723f916f81b41c60b0a` |
| Hook | `CreatorTransferred(bytes32 indexed id, address indexed previous, address indexed next)` | `0x144ce8a4ec60039eca39fc887805725944bd0789eadedc386cdaf0cc731e48c2` |
| Hook | `RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)` | `0x2a665e6945441ed891d04bf4224d831464c1973f64bc3826a762686cc02bb1d2` |
| Hook | `RouterFlushFailed(address indexed router, uint256 amount)` | `0xab328c600f1136ae1f2cc5a41598d1474d4dd6ca3f64b5e2df7a1a215856f8ed` |
| Hook | `RouterProposed(address indexed router, uint256 eta)` | `0xef16fd666847c0c0678edfd1d0ffd1bfa37b9d6be4af7ce29e8b0e01dcb94d59` |
| Hook | `RouterChanged(address indexed previous, address indexed next)` | `0xc736654a613824c69968e0ec25ac1a428ccd49e15c28e97b5dfd2c6059757e2a` |
| Hook | `RouterProposalCancelled(address indexed router)` | `0x2da9e1f0074f0b00eb9265a391bbfbe3620e2dd942a4c34944ab3c8c0d18f4f4` |
| Hook | `DisplayUpdateFailed(bytes32 indexed id)` | `0xd025c44224b2edf45f377e00f22d95292dda4ecbb55f69cc49701ad6fd5951c3` |
| Splitter | `Routed(uint256 indexed runId, bytes32 indexed accrualRoot, address indexed caller, (uint256 total, uint256 bondingFees, uint256 gradFees, uint256 weeklyLeague, uint256 monthlyLeague, uint256 recruiter, uint256 squad, uint256 airdrop, uint256 protocol) run)` | `0x57881eb45e99d6dfb862adfc2e825ffc08734a496e850ef6106dd14bb24b2ef3` |
| Choice vault | `CoinRegistered`, `Pulled`, `CreatorFeesClaimed`, `CreatorTransferred`, `HolderBatch*`, `Buyback` | see ABI |
| Reserve lock | `ReserveLocked`, `ReserveReleased` | `0xcf641ecd...128cdc`, `0x014cc1b5...d173ad` |
| Escrow | `EscrowBuy(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed)`, `EscrowClaimed` | `0x7e577df8...584b21` |
| Display (BNB) | V2 `PairCreated`, `Sync`, `Mint`, `Swap` (exact Uniswap V2 signatures) | standard |

Trades themselves are PoolManager `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`; the hook's `HookFee` for the same swap comes in the
same transaction (fee taken in `beforeSwap` for exact-input buys and exact-output sells: `HookFee` before `Swap`; in
`afterSwap` for the other two types: `HookFee` after `Swap`). Join on (tx, pool id, nearest log index); a transaction
can hold several swaps of one pool through a router.

### 10.2 Indexer rules these contracts imply (step 3)

- Volume = `HookFee.curveAmount`; fee = `HookFee.fee`; phase = `HookFee.graduated` (the crossing swap is bonding);
  D14 split at the block of `Graduated` (the crossing swap goes to `curve_trades`).
- D1 accruals: for each `HookFee` with `graduated == false`, the router part is `fee - creatorShare`; league 37.5% of
  `fee`; recruiter / squad / airdrop by the trader's profile at trade time; for `Graduated`, the creator's profile
  (store it at launch). Run amounts must be computed from the run's totals with `MwzFeeSplitter.bands(B, G)` where
  B and G come from `pending()` after the operator's `claimRouter()`, and the run is submitted with
  `expectedPaid = routerPaid(splitter).amount` (V13); per-trade slice rows go into the Merkle tree whose root is `accrualRoot`.
- Post-graduation router part goes to protocol in full; the widget partner's 0.25% (D9) is paid off chain from it.
- Creator owner: `PoolLaunched.creator` / `Launched.creator`, then `CreatorTransferred` (hook) and, for choice coins,
  the vault's `CreatorTransferred`. `Launched.hookCreator == choiceVault` marks a choice coin.
- League exclusion: `tx.from` equals the current creator, or the swap sender is the escrow.
- Holder census exclusions: PoolManager, hook, `0xdEaD`, launcher, reserve lock, escrow, choice vault.
- Alerts: `RouterProposed`, `RouterFlushFailed`, `DisplayUpdateFailed` bursts, `CreatePauseUpdated`,
  `CreateSignerUpdated`, splitter backlog (`pending().total` growing without `Routed`).

### 10.3 Step 2 (extended fork suite) starting points

`scripts/gen8/fork-suite/run-fork-suite.mjs` already deploys the full production stack on both forks. To add: splitter
runs against the real gen-7 vault addresses, choice-vault pull / holder batch / buyback on forks, escrow on forks,
every UniversalRouter version for the choice-vault and escrow paths, side-pool scenarios (V2 / V3 / hookless V4 pools
of our coin), a Robinhood 4663 display-off check against the canonical UR 2.1.2, and long runs of the property
generator against the canonical PoolManager.

### 10.4 Step 2 results (2026-10-11): what step 3 and step 9 inherit

Fork suite `run-fork-suite.mjs` + `step2.mjs`: 2,104 / 2,104 on BSC 56 and Robinhood 4663, targets $30K and $50K
(base 746 unchanged; step-2 areas split, choice, escrow, side, grad each on a fresh fork). No contract change in step 2.
After V13 (splitter runs pinned to `expectedPaid`, claim-first operator flow): 2,116 / 2,116 (12 new splitter checks:
stale plan, late fee left for the next run, third-party claim then re-plan).
Results: `scripts/gen8/fork-suite/results/gen8-fork-suite-bsc-rh.json` (`safeCalls`, `watcher`, `nums` per area).

- Splitter destinations: the four gen-7 vaults read from the gen-7 TreasuryRouterV4 accept plain native from any
  sender, so the splitter needs no Safe call to pay them. The gen-7 community vault does not (`onlyRouter`); pointing it
  at a gen-8 splitter (`setRouter`) makes every gen-7 route with an airdrop or squad part revert ("airdrop route
  failed"), proven on both forks. D8 stands: a new community vault with router = splitter at deploy.
- Downstream of the splitter: the BNB protocol destination is the ProtocolRevenueForwarder (forwards each payment to
  its sink `0xc2d4E6f8...`); the Robinhood one is the ProtocolRevenueVault (fills its operator up to $10K, overflow
  to the Safe).
- Run amounts (audit risk 2, reproduced): summing per-trade floors lands under the band (8 to 12 wei on run 1 of each
  fork) and the run reverts `OutOfBand`. The rule that always lands in band (2,000 random runs, 0 out of band; the
  per-trade method failed 53): B, G and the router-part total from `HookFee` (`graduated == false`) and `Graduated`
  since the last `Routed`; recruiter = floor(sum(bps x amount) / 10000), squad likewise (capped at `squadMax`);
  rsa = floor(sum of all three numerators / 10000) clamped into [`rsaMin`, `rsaMax`] of `bands(B, G)`;
  airdrop = rsa - recruiter - squad (if negative, take it from recruiter). Graduation rows use the creator's profile.
  The indexer's B, G and total equal the hook's own ledger (`pending()` + `pendingBondingFees` / `pendingGradFees` /
  `routerOwed`) on every run.
- UniversalRouter 2.1.x V2 / V3 swap commands take a sixth field (`uint256[]` per-hop slippage) that the v2.0 layout
  has not: five-field input reverts `SliceOutOfBounds` on 2.1.x. Encoders must follow the router version (as V4_SWAP).
- Holder distributor (D8): the gen-7 one has a single batch operator (the gen-7 vault), so gen-8 needs its own. The
  stand-in (gen-7 RewardDistributor code) works end to end: Safe `setBatchOperator(choiceVault)` once, then per batch
  `authorizeBatch` + `approveHolderBatch`, operator execute after 24 h, claims, `recoverUnclaimed` + 
  `creditUnclaimedHolders` (E19).
- Side pools: hookless V4, Uniswap V2 / V3, PancakeSwap V2 / V3, Topaz (Solidly-style) and PancakeSwap Infinity CL
  pools of a gen-8 coin can be created by anyone; trades there leave our pool, ledgers and positions untouched; an
  arbitrageur closes the gap to within the two fees. Watcher events: section 6.8 plus the topic list in the results
  file. Holder censuses must exclude side-pool contracts (pairs, pools, Pancake's Infinity vault).
- Fork mechanics: BSC full nodes drop fork-block state after about a minute and anvil then cannot mine (EIP-2935
  history slot read). `lib.mjs` seeds the history contract's 8,191 slots locally; each step-2 area runs on its own
  fork. After 48 h of fork time the Chainlink feeds are stale and launches revert, as on mainnet.

## 11. External audit scope (proposal)

- Commit: the head of `build/evm-gen8` when the audit starts (step 1 ends at the commit that adds this file).
- Files: the 12 files in section 1 (about 1,906 lines of code). Libraries pinned: v4-core 1.0.2, v4-periphery 1.0.3
  (LiquidityAmounts only), OpenZeppelin 5.4.0.
- Focus (design 8.3): return-delta accounting for all four swap types and `BeforeSwapDelta` signs; ERC6909 claim
  accounting; the replay library against `Pool.swap`; hook flags and the CREATE2 deployment; reentrancy through the
  PoolManager's unlocked state during payouts; the latch; the splitter bands and the hook's paid-ledger; the launcher's
  signature scheme; the choice vault's buyback limits and holder batch flow; behaviour under each UniversalRouter
  version listed in design 2.1; behaviour with the protocol fee on.
- Inputs to hand over: this file, the design doc, `test/gen8`, the fork suite and its results, the deployment plan.

## 12. Deployment (dry run only, step 9 draft)

`node scripts/gen8/deploy/plan-gen8-deploy.mjs --chain 56|4663|97|46630 --deployer <addr> --nonce <n>` writes
`output/gen8-deploy-plan-<chain>.dry-run.json`. It has no RPC and reads no key. Order (deployer EOA, which never holds
user money; every owner / admin is the Safe from the constructor):

1. `MwzSwapSim` library; [BNB] `MwzDisplayPairFactory(WBNB)`; `CommunityRewardsVault(Safe, predicted splitter)` (gen-7
   code, the gen-8 airdrop / squad pot, D8: the gen-7 community vault serves one router only).
2. `MwzLaunchHook` through the canonical CREATE2 proxy `0x4e59b448...` with the mined salt; constructor
   `(PoolManager, predicted launcher, Safe, predicted splitter, display factory or 0)`.
3. [BNB] `displayFactory.setHook(hook)`.
4. `MwzFeeSplitter`, `MwzCreatorChoiceVault`, `MwzReserveLock`, `MwzV4Launcher` (paused) at the predicted nonces; then
   `MwzLaunchLens`, `MwzCreatorEscrow`. The launcher constructor reverts unless the hook, vault and lock all point at
   it, so a nonce drift cannot leave a mis-wired system.
5. Safe batch B (bind): vault distributor, operator and caps (copied from the gen-7 vault's `limits()`), community
   vault distributor and airdrop operator, distributor batch operator.
6. Safe batch H (opening day, inside the combined release): `launcher.setCreatePaused(false)` and the gen-7 factories'
   `setCreatePaused(true)`.

Inputs still open in `scripts/gen8/deploy/inputs.example.json`: the weekly / monthly league destinations (read from the
gen-7 TreasuryRouterV4 on the day), the splitter operator key, a holder distributor and an airdrop distributor for
gen-8, the vault caps, and everything on the testnets (Uniswap V4 availability on 97 / 46630 is unchecked).

## 13. Gas and sizes

Sizes (runtime / initcode bytes): hook 16,708 / 17,715; MwzSwapSim 5,558; lens 3,682; launcher 14,363 / 15,935
(includes the token's creation code); token 1,502; reserve lock 2,081; escrow 5,022; splitter 3,567 (3,868 before V13); choice vault
12,842; display pair 1,924; display factory 3,496. All under EIP-170; hook under the 21,500 target.

Fork measurements (canonical PoolManager, warm pool, direct unlock callback unless noted):

| | BSC $30K | BSC $50K | RH $30K | RH $50K | Research proof (BSC / RH, $30K) |
|---|---|---|---|---|---|
| Launch with first buy | 1,796,128 | 1,797,007 | 1,223,173 | 1,223,296 | 1,665,897 / 1,100,443 |
| Buy exact-in, hooked (bonding) | 149,891 | 149,070 | 133,607 | 134,360 | 143,337 / 127,014 |
| Sell exact-in, hooked (bonding) | 154,852 | 154,031 | 138,496 | 139,409 | 148,460 / 131,905 |
| Buy exact-in, hookless twin | 87,435 | 87,467 | 93,172 | 93,332 | 87,499 / 93,172 |
| Hook overhead buy / sell | +62.5k / +61.3k | +61.6k / +60.5k | +40.4k / +44.9k | +41.0k / +45.7k | +55.8k / +55.0k, +33.8k / +38.3k |
| Same via UniversalRouter (docs main) buy / sell | 157,146 / 166,730 | 157,298 / 166,694 | 148,423 / 152,269 | 148,163 / 152,173 | |
| Crossing swap (graduates) | 249,488 | 249,360 | 233,718 | 233,826 | 216,900 / 201,342 |
| Display per swap (BNB) | 9,642 | 9,642 | n/a | n/a | 9,644 |

The BNB overhead includes the display pair (about 9.6k). The +6.5k per bonding swap versus the proof is the D2 creator
ledger write. Local hardhat table (`test/gen8/gas-and-sizes.spec.ts`, written to `reports/gen8/local-gas.json`):
claimCreator 58k, claimRouter 125k (first payout to a router writes three new slots), splitter run to six
destinations 327k (332k before V13; the claim is now a separate transaction, claimRouter 125k), choice-vault pull 133k, escrow buy 241k, escrow claim 90k, reserve release 60k, vault buyback 285k,
price-limited buy (library replay) +14k over an unlimited one.

## 14. Verification manifest

| Item | Value |
|---|---|
| Compiler | solc 0.8.26+commit.8a97fa7a, EVM cancun, via-IR, optimizer enabled, runs 200, `bytecodeHash: none` |
| Linked library | `MwzSwapSim` into `MwzLaunchHook` and `MwzLaunchLens` |
| Pinned packages | `@uniswap/v4-core` 1.0.2, `@uniswap/v4-periphery` 1.0.3, `@openzeppelin/contracts` 5.4.0 (lockfile) |
| Hook flags | `0x28EC` (beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, beforeDonate, beforeSwapReturnDelta, afterSwapReturnDelta) |
| Build | `npx hardhat --config hardhat.gen8.config.ts compile` (outputs `artifacts-gen8/`) |
