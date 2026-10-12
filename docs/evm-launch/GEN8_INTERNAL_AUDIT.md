# EVM generation 8: internal audit of the production contracts (step 1)

Status 2026-10-12 (fix round after the AI audit: section 15; earlier sections updated where the fixes changed
them, marked "(2026-10-12)"). First written 2026-10-11. Branch `build/evm-gen8` (worktree `~/mwz-wt/evm-gen8`, from `research/v4-hook-fork-proof` at
`8f73d7fd`). Nothing here is deployed. All runs are local: the hardhat network and anvil forks of BNB Chain 56 and
Robinhood Chain 4663 with fresh test keys. This is our own review, written so an external auditor can start from it;
it is not a substitute for the paid external audit (D11).

Spec: `docs/evm-launch/EVM_GEN8_V4_DESIGN.md` (decisions D1 to D14, invariants I1 to I13 in 2.9, auditor points
A1 to A15 in 8.2). Research proof: `scripts/research/v4-hook/` (702/702 on both forks).

Contents: 1 scope, 2 results, 3 actors and trust, 4 money paths per contract, 5 invariants, 6 auditor points A1 to A15,
7 top risks, 8 known limitations, 9 deviations from the design doc, 10 what steps 2 and 3 need, 11 external audit
scope, 12 deployment (dry run), 13 gas and sizes, 14 verification manifest, 15 fix round 2026-10-12 (diff audits and
audit PoC re-runs).

---

## 1. Scope

| File | Lines (total / code) | Role |
|---|---|---|
| `contracts/gen8/MwzLaunchHook.sol` | 766 / 589 (2026-10-12) | The V4 hook: fees, liquidity lock, graduation latch, creator ledger, router bucket, display call |
| `contracts/gen8/libraries/MwzSwapSim.sol` | 125 / 101 | External library (linked): exact replay of `Pool.swap` for price-limited swaps |
| `contracts/gen8/libraries/MwzFeeMath.sol` | 39 / 20 | Internal library: rate schedule and exact-output gross, shared by hook and lens |
| `contracts/gen8/interfaces/IMwzLaunchHook.sol` | 60 / 50 | `FeeConfig` and the hook view interface |
| `contracts/gen8/MwzLaunchLens.sol` | 92 / 66 | Stateless views: `currentFeeBps`, `previewFill`, `grossForNet`, `progress` |
| `contracts/gen8/MwzV4Launcher.sol` | 473 / 377 | One-transaction launch with L1 to L5 |
| `contracts/gen8/MwzV4Token.sol` | 13 / 7 | Plain 1B ERC20 |
| `contracts/gen8/MwzReserveLock.sol` | 100 / 72 | 2% creator reserve until graduation (D6 R2) |
| `contracts/gen8/MwzCreatorEscrow.sol` | 126 / 96 | App creator-buy escrow, gen-7 schedule (D5 E1) |
| `contracts/gen8/MwzFeeSplitter.sol` | 189 / 144 | Bounded router-bucket splitter (D1 A) |
| `contracts/gen8/MwzCreatorChoiceVault.sol` | 480 / 380 | Holders / split / buyback choice (D2) |
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
| Local unit + property + gas/size (hardhat, v4-core 1.0.2 PoolManager built locally) | `npx hardhat --config hardhat.gen8.config.ts test` | 2026-10-12: 101 passing after the fix round (15.9). Before: 80 tests passing (77 before V13; +3 splitter plan tests) in about 5 minutes, including 10 seeded property runs of 220 actions (see 2.1) |
| Property runs, larger campaign | `GEN8_FUZZ_SEEDS=101..140 GEN8_FUZZ_STEPS=300` | 40 seeds x 300 random actions, all invariants checked after every action: 40 / 40 passing (after V13 the splitter step also lands fees and third-party claims between plan and route: 74 late fees, 79 re-plans) (12,000 actions, about 8 minutes) |
| Fork suite, production contracts, BSC 56 + Robinhood 4663, $30K + $50K | `node scripts/gen8/fork-suite/run-fork-suite.mjs` | 2026-10-12: 2,376 / 2,376 PASS incl. step 2 and the `fixes` area (15.9). Step 1: 746 / 746 PASS (134 s) |
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
| MemeWarzone Safe as hook owner | Redirect the router bucket after 48 h (bucket accrued before the change is parked for the old router and paid only to it, 2026-10-12 F3); claim the router bucket for the current router (F4); transfer ownership in two steps | Change rates, creators, creator balances or liquidity; pause trading; withdraw anything |
| Safe as launcher owner | Pause / open launches; rotate the create signer; transfer ownership | Touch any launched coin, any balance or trading |
| API create signer (D3) | Authorize a launch for a named creator wallet, request and deadline (max 1 day) | Trade, move money, change rates; reuse an authorization; authorize for another wallet, chain or launcher |
| Safe as splitter admin | Set the operator; run the same bounded route | Change destinations or bands; withdraw |
| Splitter operator (new key, Zodiac Roles) | Claim the hook's router bucket into the splitter (F4: only the router, its operator or the hook owner may); choose, per run, how the recruiter + squad + airdrop band is split (inside the band, squad capped) and when to run | Send money to a wallet, change the league share or the protocol remainder, skip or invent value |
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
   immutable band (BNB $10 to $100,000, ETH $50 to $500,000 in the deploy inputs since 2026-10-12, F6). Robinhood has
   no Chainlink sequencer uptime feed (15.7).
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

**Fee phase (2026-10-12, F1)**: the rate and split of a swap follow the pool price at its START (`slot0` read in
`beforeSwap`): inside A the bonding rate with the launch decay and the bonding split; at or past `sqrtGrad` the post
rate and split. The latch below decides only the one-time graduation (15.1). Before `openAt` only the launcher's
swap passes (B, 15.8). A sell may not end above `sqrtStart` (F2, 15.2).

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

**claimRouter()**, **payParkedRouter(r)** and **executeTreasuryRouter()** (2026-10-12, F3 / F4; diff audits 15.3, 15.4)
- Guard: `claimRouter` and `payParkedRouter` are `nonReentrant`; `executeTreasuryRouter` makes no external call.
- CEI: `claimRouter` checks the caller (router, owner, or the router's `operator()` read by a gas-capped staticcall)
  and the amount, zeroes the bucket and the pending bonding / graduation counters, records `routerPaid[router]`, then
  pays as the last call. `executeTreasuryRouter` moves the bucket into `routerParked[old]` (no payout) and switches the
  router. `payParkedRouter(r)` zeroes `routerParked[r]`, records `routerPaid[r]`, then pays `r` as the last call; a
  refusing `r` reverts the call and the bucket stays parked for `r`.
- States: `claimRouter` any time with a non-zero bucket, by the router, its operator or the owner;
  `executeTreasuryRouter` only by the owner, only with a pending proposal at or after its eta (48 h);
  `payParkedRouter` by anyone, any time, only to the router the bucket was accrued under.
- Over/underflow: `routerPaid` / `routerParked` sums are `uint256`; `parkedOwed -= amount` follows an earlier `+=`.
- Griefing: a third party cannot claim (C-M1 / D-L3 closed). The old text here ("the flush is tolerant ... the bucket
  follows the new router") described the A-2 hole: an owner contract executing inside an unlock made the flush fail
  and moved the old router's bucket to the new router. There is no flush any more (15.3).

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
- `release(id)`: `nonReentrant`; checks (amount > 0, hook says graduated, the PoolManager is locked, the pool price
  is at or past the graduation price now (2026-10-12, F1), beneficiary non-zero), effect (amount = 0),
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
  claims: the operator claims (`hook.claimRouter()`, since 2026-10-12 only the router, its operator or the hook
  owner, F4) and plans first. It reads
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
- Holder batches: operator proposes (moves holder balances into the batch, weekly cap; claim deadline in
  [executableAt + 7 days, now + 365 days], F5), admin approves the exact root, total and claim deadline, operator executes after the delay (`totalLiabilities -= total`, then `createBatch{value}`), admin can veto
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
| I3 | Rate <= 9000 in the window (from `openAt`), == bonding after, == post for a swap that starts at or past the graduation price (2026-10-12, F1) | `MwzFeeMath.rate`, launcher constants, hook caps | hook.spec decay table, fixes spec, invariants (every trade vs block time and start price) |
| I4 | Claims held == routerOwed + parkedOwed + sum(creatorOwed) (parked buckets since 2026-10-12, F3) | single `_accrue` / `_graduate` / payout paths | after every action in the property runs; payout reentrancy test |
| I5 | The hook never holds coins | dust burned at seed; no coin path | property runs, fork suite |
| I6 | A and B lose liquidity only once, floor(liqA x 2%) from A at graduation | no remove path; add / donate / initialize revert | position liquidity read from PoolManager storage after every action |
| I7 | `graduated` false to true once, only at price <= sqrtGrad | latch in `afterSwap` | property runs (latch condition and monotonic), hook.spec |
| I8 | Post-graduation creator share == floor(curve x creatorPostBps / 10000) | `_accrue` | every trade in the property runs |
| I9 | Only the creator moves its ledger | `claimCreator` check | hook.spec |
| I10 | Router changes only via propose + 48 h + execute | owner functions | hook.spec, fork suite |
| I11 | A swap never reverts because of the display | 60k gas cap, no return data | hook.spec, fork suite, property runs |
| I12 | Stored rates never change | no setter | property runs, fork suite |
| I13 | Supply 850M + 130M + 20M, seed uses the coins sent, dust burned | launcher constants, seed | hook.spec, property runs |
| I14 (2026-10-12) | Fee phase and bucket follow the start price; `price <= sqrtGrad` implies the latch | `beforeSwap` phase, `_accrue` | property runs: HookFee phase, `pendingBondingFees` delta, latch implication after every action |
| I15 (2026-10-12) | The price never sits above `sqrtStart` | `afterSwap` F2 check | property runs (incl. a full-dump action after graduation) |
| I16 (2026-10-12) | No swap before `openAt` except the launcher's first buy | `beforeSwap` B check | property runs with a scheduled third coin (direct, sell, escrow attempts) |

## 6. Auditor points A1 to A15

| # | Point | How it is handled in production |
|---|---|---|
| A1 | Simulation drift | `MwzSwapSim` is the proof's replay, moved verbatim into a linked library; `afterSwap` still reverts `PartialFill` on any difference. Exact under the 0.1% protocol fee (unit and fork). |
| A2 | Display gas forcing | Accepted: one missed display update, `DisplayUpdateFailed`; money never reads the display. |
| A3 | `tx.origin` in the display `to` | Display only; nowhere else. |
| A4 | Router redirect window | 2026-10-12 (F3): `executeTreasuryRouter` parks the bucket for the old router (`routerParked`, `RouterParked`); anyone pays it to that router only (`payParkedRouter`). The earlier tolerant flush was bypassable (A-2). Alert on `RouterProposed` stays an indexer task (step 3). |
| A5 | Side pools | Out of contract scope; watcher in step 3. |
| A6 | Uniswap protocol fee up to 0.1% | Our fee stays gen-7 exact on the curve amount the PoolManager reports; quotes include it (tested both places). Disclose. |
| A7 | Timestamp | 60 s decay on `block.timestamp`, as gen-7. Accepted. |
| A8 | Oracle | Read once per launch: try/catch around both oracle reads, immutable sane band on the price, gen-7 C8 bounds, oracle age window <= 2 days checked at deploy. Never read by trading. |
| A9 | Hook size | 16,708 bytes runtime (target 21,500; limit 24,576) after moving the replay into `MwzSwapSim` and previews into the lens. |
| A10 | Exact-input buy fee = g - cost | 0..2 wei above the gen-7 floor; measured 0..1 on forks, 0..2 bound proven over 60 sizes. In the protocol's favour. |
| A11 | Launcher rate exception | Launcher swaps only from its callback, which only runs inside `launch` (OZ guard entered) and only from the PoolManager. Tested. |
| A12 | Crossing swap pays bonding on its whole amount | Kept by design; `HookFee.graduated == false` for that swap, so the indexer books it as bonding. Since 2026-10-12 (F1) the same rule holds for every swap: the phase is the start price. |
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
- (2026-10-12) A sell that would take the price above the start price reverts `PriceAboveStart` (F2). After graduation
  the coins in circulation can exceed what A takes back; such a sell needs a price limit at or below `sqrtStart` (it
  then partially fills). UniversalRouter V4 swaps carry no limit, so the app must cap the sell size.
- (2026-10-12) The graduation latch can still be forced with a buy-and-sell-back; it no longer changes fees, League
  counting or the reserve (F1), but `Graduated` fires early and the one-time graduation fee is taken then. A
  three-transaction same-block bundle (buy to the graduation price, `release`, sell back) can release a creator's
  reserve early (15.1, residual).
- (2026-10-12) Robinhood Chain has no Chainlink L2 sequencer uptime feed (15.7).

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
| Launcher | `Launched(address indexed token, bytes32 indexed id, address indexed creator, address hookCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut, uint40 openAt)` (2026-10-12: `openAt` added; old topic `0x088cfcd4...e8202` is gone) | `0x31a17dc08a6e6d68b3756995fcffd6409e467aecf1e327d19f4a6d5d2493abad` |
| Launcher | `LaunchMetadata(address indexed token, bytes32 indexed id, string name, string symbol, string logoURI, string xAccount, string website, string extraLink, bytes32 metadataHash)` | `0xb1da1fbea51ed6d80051f5210a2219d6337b68bf121164963927cd17d0a248a4` |
| Launcher | `CreatePauseUpdated(bool)`, `CreateSignerUpdated(address,address)` | `0x28c36262...2c2e07`, `0xc5a5f992...0e541e` |
| Hook | `PoolLaunched(bytes32 indexed id, address indexed token, address indexed creator, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, (uint16,uint16,uint16,uint16,uint16) fees, address display, uint40 openAt)` (2026-10-12: `openAt` added; old topic `0x882a0042...d7f01` is gone) | `0xdd7c18f0da19abbb07777bcf2ee68f0abe4c034ef678a7a2c11c32cdd02d0b08` |
| Hook | `HookFee(bytes32 indexed id, address indexed swapSender, address indexed referrer, bool buy, bool graduated, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare)` (signature unchanged; since 2026-10-12 `graduated` = the swap STARTED at or past the graduation price, F1) | `0xb77d9c06aa8d782c4be19bbd7a54af4d03bb0eaf618c887f8d1eb5f7b0213ad2` |
| Hook | `Graduated(bytes32 indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved)` | `0x9408aa53590d2acf7d72e624d65745b71ea5a308a6cc5f2c7cbee7163b3dc332` |
| Hook | `CreatorClaimed(bytes32 indexed id, address indexed to, uint256 amount)` | `0xc1d27057937a5216efd7c1ee2b680a2a34893e3f35e3a33f70c4bf0935312664` |
| Hook | `CreatorProposed(bytes32 indexed id, address indexed current, address indexed proposed)` | `0x1cf5caa2b6a5e78ae6ef887c184ec7769be961dc26752723f916f81b41c60b0a` |
| Hook | `CreatorTransferred(bytes32 indexed id, address indexed previous, address indexed next)` | `0x144ce8a4ec60039eca39fc887805725944bd0789eadedc386cdaf0cc731e48c2` |
| Hook | `RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)` | `0x2a665e6945441ed891d04bf4224d831464c1973f64bc3826a762686cc02bb1d2` |
| Hook | `RouterParked(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)` (2026-10-12, F3; replaces `RouterFlushFailed`, removed) | `0x506167ba2006e49cff0621af84213321ef12c7bcbd489bbb9072a59247567d66` |
| Hook | `RouterProposed(address indexed router, uint256 eta)` | `0xef16fd666847c0c0678edfd1d0ffd1bfa37b9d6be4af7ce29e8b0e01dcb94d59` |
| Hook | `RouterChanged(address indexed previous, address indexed next)` | `0xc736654a613824c69968e0ec25ac1a428ccd49e15c28e97b5dfd2c6059757e2a` |
| Hook | `RouterProposalCancelled(address indexed router)` | `0x2da9e1f0074f0b00eb9265a391bbfbe3620e2dd942a4c34944ab3c8c0d18f4f4` |
| Hook | `DisplayUpdateFailed(bytes32 indexed id)` | `0xd025c44224b2edf45f377e00f22d95292dda4ecbb55f69cc49701ad6fd5951c3` |
| Splitter | `Routed(uint256 indexed runId, bytes32 indexed accrualRoot, address indexed caller, (uint256 total, uint256 bondingFees, uint256 gradFees, uint256 weeklyLeague, uint256 monthlyLeague, uint256 recruiter, uint256 squad, uint256 airdrop, uint256 protocol) run)` | `0x57881eb45e99d6dfb862adfc2e825ffc08734a496e850ef6106dd14bb24b2ef3` |
| Choice vault | `HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 claimDeadline)` (2026-10-12, F5: deadline added) | `0x22070f74010d6fdb033b5195480fe86205d63d57f90005cca85ea9967cf8b9c1` |
| Choice vault | `CoinRegistered`, `Pulled`, `CreatorFeesClaimed`, `CreatorTransferred`, `HolderBatchProposed` / `Vetoed` / `Executed`, `Buyback` | see ABI |
| Reserve lock | `ReserveLocked`, `ReserveReleased` | `0xcf641ecd...128cdc`, `0x014cc1b5...d173ad` |
| Escrow | `EscrowBuy(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed)`, `EscrowClaimed` | `0x7e577df8...584b21` |
| Display (BNB) | V2 `PairCreated`, `Sync`, `Mint`, `Swap` (exact Uniswap V2 signatures) | standard |

Trades themselves are PoolManager `Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`; the hook's `HookFee` for the same swap comes in the
same transaction (fee taken in `beforeSwap` for exact-input buys and exact-output sells: `HookFee` before `Swap`; in
`afterSwap` for the other two types: `HookFee` after `Swap`). Join on (tx, pool id, nearest log index); a transaction
can hold several swaps of one pool through a router.

### 10.2 Indexer rules these contracts imply (step 3)

- Volume = `HookFee.curveAmount`; fee = `HookFee.fee`; phase = `HookFee.graduated` (2026-10-12: the phase of THAT
  swap by its start price; the crossing swap and every swap back inside A after a graduation are bonding swaps, League
  counting follows the flag, not the `Graduated` event); D14 split at the block of `Graduated` (the crossing swap goes
  to `curve_trades`). A coin shows as graduated in the app when the latch is set AND the price is at or past the
  graduation price (lens `progress().postPhase`), since a forced latch with a sell-back is possible (15.1).
- Scheduled open (B): `Launched.openAt` / `PoolLaunched.openAt`; no trade before it except the launch transaction's
  first buy; `lens.tradingOpen(id)`.
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
- Router change: `RouterParked(old, ...)`, then `payParkedRouter(old)` emits `RouterClaimed(old, ...)` (counts for the
  old splitter's next run exactly like a claim). The splitter operator's claims: `claimRouter()` from the operator key
  (F4); a `NotRouterCaller` revert means a wrong key.
- Alerts: `RouterProposed`, `RouterParked`, `DisplayUpdateFailed` bursts, `CreatePauseUpdated`,
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

Sizes after the 2026-10-12 fix round: see 15.9 (hook 17,529 runtime). Step-1 sizes (runtime / initcode bytes): hook 16,708 / 17,715; MwzSwapSim 5,558; lens 3,682; launcher 14,363 / 15,935
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

## 15. Fix round 2026-10-12 (after the AI audit): diff audits

Founder go 2026-10-12 for the contract findings of the AI audit (`docs/build_plans/GEN8_AI_AUDIT_FINDINGS.md`,
reviewers A hook, B launcher and periphery, C money distribution, D economics). Base `aac801d5`. Each entry states the
change, then the CLAUDE.md money-path questions: reentrancy guard, checks-effects-interactions order, which states can
and cannot reach it, over/underflow, griefing. The audit PoCs are re-run against the fixed code by
`scripts/gen8/audit-rerun.sh` (copies them from the audit commits with path-only changes; results in 15.9).

### 15.1 F1 forced graduation: fee phase by the start price, reserve release by the current price

Change (hook). `beforeSwap` reads `slot0` and sets `post = sqrtP <= sqrtGrad` (V4 price is coins per native, so this
is "coin price at or past the graduation price"). The rate is `MwzFeeMath.rate(fees, post, isLauncher, openAt, now)`:
post rate when `post`, else the bonding rate with the 60 s launch decay; the launcher's own swap stays at the bonding
rate. `post` is handed to `afterSwap` in a new transient slot (`T_POST`) next to `T_RATE`, so the two fee paths of a
swap use one phase. `_accrue` books by `post` instead of the latch: bonding phase, creator `floor(fee * 560 / 10000)`
and the full fee into `pendingBondingFees`; post phase, creator `floor(curve * 50 / 10000)` capped at the fee.
`HookFee.graduated` now carries `post`. Graduation itself is unchanged: the first swap that ENDS at or past
`sqrtGrad` sets the latch, removes 2% of A's liquidity, books the graduation fee and emits `Graduated`; that crossing
swap started inside A, so it pays the bonding rate (as before, A12).

Change (reserve lock). `release` additionally requires (a) the PoolManager to be locked (`TransientStateLibrary
.isUnlocked == false`, error `PoolManagerUnlocked`) and (b) `slot0.sqrtP <= sqrtGrad` now (error
`PriceBelowGraduation`), on top of the latch.

Change (lens). `currentFeeBps` follows the same price rule; `progress()` gains `postPhase`; new `tradingOpen()`.

Everything else gated on graduation: the choice vault's buyback progress cap (`if (!graduated)` 95% of A's target)
stays latch-based: its purpose is "a buyback can never trigger graduation", and once the latch is set there is
nothing left to trigger. The display pair has no phase. The splitter routes what the hook books, by bucket.

- Reentrancy: `beforeSwap` / `afterSwap` stay `onlyPoolManager` without a lock (unchanged reason, 4.1); the new
  reads (`getSlot0`, `tload`) are views. `release` keeps `nonReentrant`; its new checks are views on the PoolManager.
- CEI: the phase is decided before any accounting; `_accrue` is unchanged in order (mint claim, then ledgers);
  `release` still zeroes the reserve before the transfer.
- States: `post == true` is reachable only after the latch (the pool starts at `sqrtStart > sqrtGrad`, and the first
  swap that ends at or past `sqrtGrad` latches; no liquidity can be added or donated). The property runs assert
  `price <= sqrtGrad => graduated` after every action. A swap starting exactly at `sqrtGrad` is post (tested).
- Over/underflow: none new (a comparison and a transient bool).
- Griefing and what is left of A-1 / D-H1:
  - One transaction (buy to `sqrtGrad`, sell back, A-1) and two transactions in one block (D-H1): the latch still
    fires (founder design: instant graduation), the graduation fee is paid out of the attacker's own buy, and the
    price is back in A. Every later swap that starts in A pays 2% with the bonding split, books into
    `pendingBondingFees` and is flagged `graduated = false` for the indexer (League counting continues). The reserve
    cannot be released: inside the attacker's unlock `release` reverts `PoolManagerUnlocked`; after it,
    `PriceBelowGraduation`. Measured locally: the one-transaction round trip costs about 5% of A's raise and gains
    nothing on fees. Fork numbers in 15.9.
  - Residual (measured, reported, not fixed): a bundle of THREE transactions in one block (buy to `sqrtGrad`, then
    `release` as its own transaction while the price sits at the graduation price and the PoolManager is locked,
    then the sell back) releases the creator's 20M reserve before a real graduation. It needs A's whole raise as
    capital for one block (on BSC a builder bundle; on Robinhood back-to-back transactions from one sender) and costs
    the same round trip as D-H1. The beneficiary is always the coin's creator, so only a creator has a motive; the
    fee motive (0.5% creator share of volume vs 0.112%) is gone. Closing it needs a time condition on release (for
    example "at or past the graduation price at two different block timestamps", or a minimum time since the latch),
    which is a design change and is left to the founder.
  - Other effects of a forced latch that remain by design: the `Graduated` event fires early (the indexer and the app
    must show "graduated" from the price, not from the event alone; see 10.2 below), and the one-time 2% graduation fee
    is taken at the forced crossing and never again (A keeps 98% of its liquidity for the real crossing).

### 15.2 F2 no sell may leave the price above the start price

Change (hook, `afterSwap`). After the fee paths: `if (!zeroForOne && sqrtAfter > getSqrtPriceAtTick(tickStart))
revert PriceAboveStart()`. The `slot0` read is shared with the latch check and the display call (the display no
longer reads `slot0` itself).

- Reentrancy / CEI: a revert inside the PoolManager callback reverts the whole swap; nothing was booked that survives.
- States: before graduation every coin outside the pool came out of A, so selling all of them back ends at most at
  the start price (rounding is in the pool's favour); the revert is reachable only at the start price with zero
  liquidity (A-3) or after graduation, when A holds 98% of its liquidity and the 20M reserve is in circulation, by a
  sell larger than A can take back. Such a sell must carry a price limit at or below `sqrtStart` and then partially
  fills to exactly `sqrtStart` (tested, local and fork, every UR). UniversalRouter V4 swaps carry no price limit, so
  through a UR the oversize sell reverts; the app must cap a sell at what A can absorb (lens `progress`) or use the
  limit. At the start price itself a limit equal to the price is refused by the PoolManager (`PriceLimitAlreadyExceeded`).
- Over/underflow: none (`TickMath` on a stored, validated tick).
- Griefing: A-3 is closed: the price can no longer be pushed to `MAX_SQRT_PRICE` for free, so the next buyer's gas
  and the shown market cap stay normal. `MwzSwapSim` keeps its above-start code path (now unreachable).

### 15.3 F3 router change: parked bucket, no try/catch

Change (hook). `executeTreasuryRouter` no longer pays anything. It moves `routerOwed`, `pendingBondingFees` and
`pendingGradFees` into `routerParked[old]` (same three counters as `routerPaid`), adds the amount to `parkedOwed`,
emits `RouterParked(old, amount, bondingFees, gradFees)`, then switches the router. New permissionless
`payParkedRouter(r)` pays a parked bucket to `r` only: it deletes `routerParked[r]`, lowers `parkedOwed`, records
`routerPaid[r]` and pays through the hook's own unlock, emitting `RouterClaimed` like a claim. The try/catch and
`RouterFlushFailed` are removed. Invariant I4 becomes `claims == routerOwed + parkedOwed + sum(creatorOwed)`.

- Reentrancy: `executeTreasuryRouter` makes no external call at all (its old `nonReentrant` is no longer needed and is
  removed); `payParkedRouter` is `nonReentrant` (hook-wide lock shared with the claims).
- CEI: `payParkedRouter` checks (amount > 0), effects (delete parked, `parkedOwed -= amount`, `routerPaid += `), then
  the payout as the last call; a refusing router reverts the whole call and the bucket stays parked.
- States: execute by the owner only, with a pending proposal at or after its eta; pay parked by anyone, any time,
  only to the router the bucket was accrued under. Re-proposing the same router parks to itself (paid by the same
  call path); proposing an old router again adds to its parked counters.
- Over/underflow: `routerParked` and `parkedOwed` are `uint256` sums of `uint128` buckets; `parkedOwed -= amount`
  cannot underflow because every parked amount was added to it first.
- Griefing: A-2 (owner contract executing inside an unlock to make the flush fail) is gone: there is no flush to fail.
  A refusing old router no longer redirects its bucket to the new router; it stays parked until that router accepts
  (it cannot block the change). `payParkedRouter` is one-shot per change, so it can move the old splitter's
  cumulative paid between that splitter's plan and route at most once per change (the operator re-plans).
- Internal audit text corrected: 4.1 said "a broken router can never block the change" and "the bucket follows the
  new router"; the second half was the A-2 hole. 4.1 now points here.

### 15.4 F4 claimRouter access

Change (hook). `claimRouter` reverts `NotRouterCaller` unless `msg.sender` is the current router, the owner, or the
router's operator, read live with a 30,000-gas `staticcall` to `operator()` (a router without one, one that reverts,
returns short data or burns the gas simply has no operator). The splitter itself has no claim path (V13 unchanged:
`route` never claims and is pinned to `expectedPaid`).

- Reentrancy: `nonReentrant` unchanged; the operator read is a gas-capped `staticcall` before any state change, so
  the router cannot write or re-enter.
- CEI: checks (caller, amount) then effects (bucket zeroed, `routerPaid`) then the payout.
- States: any time with a non-zero bucket. When the splitter admin rotates the operator, the hook follows at once
  (tested). A Zodiac Roles operator acts through the Safe, which is the owner, so it passes too.
- Over/underflow: none new.
- Griefing: C-M1 / D-L3 are closed: a third party can no longer move `routerPaid` between the operator's plan and its
  `route` (on chain: `NotRouterCaller`). Our own second claim (two workers, or the Safe) still makes a stale plan
  revert `PaidMismatch`, which the worker handles by re-planning. C-M2 (a third-party dust claim parking the worker
  below its minimum) loses its on-chain trigger; the worker's below-minimum rule is still an off-chain item (F11).
  A malicious router could return any address from `operator()`; the router is chosen by the owner behind the 48 h
  timelock, and whoever it names can only pay the router its own bucket.

### 15.5 F5 holder-batch claim deadline

Change (choice vault). `proposeHolderBatch` requires `executableAt + 7 days <= claimDeadline <= now + 365 days`
(`MIN_CLAIM_WINDOW`, `MAX_CLAIM_WINDOW`, error `BadClaimDeadline`), so 0 is impossible. `approveHolderBatch(batchId,
root, total, claimDeadline)` must name the stored deadline (else `BadBatch`) and emits `HolderBatchApproved(batchId,
root, total, claimDeadline)`. `executeHolderBatch` refuses a batch whose deadline is less than 7 days away at execution
(the Safe vetoes and the operator re-proposes).

- Reentrancy: unchanged (`proposeHolderBatch` and `executeHolderBatch` `nonReentrant`; approve has no external call).
- CEI: the new checks sit with the other checks before any effect; execute still sets `status`, lowers liabilities,
  then calls the distributor.
- States: proposal by the operator only; approval by the admin only, with the exact root, total and deadline.
- Over/underflow: `uint64` deadline compared in `uint256`; `now + 365 days` cannot overflow.
- Griefing: C-L2 is closed: the Safe now sees and signs the deadline, and the distributor can always reach
  `recoverUnclaimed` after it (tested: recover after the deadline returns the unclaimed amount).

### 15.6 F6 oracle band

No contract change: the band was already two immutable constructor parameters. Deploy inputs
(`scripts/gen8/deploy/inputs.example.json`), the fork suite and the local fixture now use BNB $10 to $100,000
(56, 97) and ETH $50 to $500,000 (4663, 46630). B-05's price of $50,001 now launches; prices just outside the new band
are refused (tested both chains' bands).

### 15.7 F17 Robinhood sequencer uptime

Checked 2026-10-12 (read-only): Chainlink's L2 sequencer uptime page lists 11 mainnets (Arbitrum, Base, Celo, Mantle,
MegaETH, Metis, OP, Scroll, Soneium, X Layer, zkSync) and says it is no longer adding networks; Chainlink's
Robinhood mainnet feed listing (58 entries) has no uptime feed; Robinhood's own oracle page recommends checking one
but names no address. On chain: the gen-7 oracle `0xe635AA43...` reads ETH/USD `0x78F3556b...` (8 decimals, 24 h
heartbeat, 0.5% deviation), `maxPriceAge` 90,000 s. **No uptime feed exists, so nothing is added**; the launcher keeps
its band and the oracle's own staleness rule. If the founder wants a guard, the options are a tighter age for
Robinhood launches or a second price source; both are design changes.

### 15.8 B scheduled trading open

Change (launcher). `LaunchRequest` gains `uint64 openAt` as its last field, included in `hashRequest` (so the API
signs it). `launch` computes the effective open time: 0 or a time not after the block time opens now (gen-1
`LaunchCampaign` rule); later than `now + 30 days` reverts `OpenAtTooFar` (draft scheduler bound, `MAX_OPEN_DELAY`).
`Launched` gains `uint40 openAt`. Change (hook). `PoolState.launchTime` becomes `openAt` (same slot, same width);
`createPool` takes `openAt` and requires `now <= openAt <= now + 30 days` (`BadOpenAt`); `beforeSwap` reverts
`TradingNotOpen` before `openAt` unless the swap sender is the launcher (whose swap can only run inside `launch()`,
A11); the 60 s decay runs from `openAt`; `PoolLaunched` gains `uint40 openAt`. The choice vault's buyback window reads
the same field, so buybacks start at `openAt + 60 s`.

- Reentrancy: unchanged (`launch` `nonReentrant`; the hook check is a comparison).
- CEI: the bound is a check before the authorization is consumed.
- States: before `openAt`: only the creator first buy in the launch transaction (bonding rate, as before); claims,
  creator transfers, router claims and the reserve lock work (no swap involved). From `openAt`: as an unscheduled coin
  launched at `openAt`. Graduation unchanged.
- Over/underflow: `uint40` holds `now + 30 days` for 30,000 years; `openAt + 60` in `uint256`.
- Griefing: none new; nobody can trade a scheduled coin early through any router, the escrow or the vault (tested on
  both forks through every UR). The creator holds the first-buy coins through the wait with no market; that is the
  product choice.

### 15.9 Results of the fix round

| Suite | Result |
|---|---|
| Local unit + property + gas/size (`npx hardhat --config hardhat.gen8.config.ts test`, fresh deterministic keys since this round) | 101 passing (80 before; +21: `test/gen8/fixes-2026-10-12.spec.ts` 19, hook.spec +2 for F3 / F4) in about 5 minutes |
| Property runs (10 seeds x 220 actions, default) | all invariants after every action, plus I14 (phase by start price, bucket delta, latch implication), I15 (price <= sqrtStart, incl. a full-dump action), I16 (scheduled third coin: every attempt before `openAt` refused), F4 (a random user's `claimRouter` refused before every claim), F1 release rule (release succeeds at/past the graduation price, refused back in A). Over the 10 seeds: 130 to 145 trades each, 27 to 80 post-phase trades, 23 to 68 swaps back in A after graduation, up to 10 refused pre-open attempts, up to 3 refused oversize dumps, up to 9 refused releases |
| Fork suite, BSC 56 + Robinhood 4663, $30K + $50K (`node scripts/gen8/fork-suite/run-fork-suite.mjs`, public read-only RPCs, no .env) | 2,376 / 2,376 PASS (2,116 before; new area `fixes` 42 per chain; base and step-2 checks adapted to F1 / F3 / F4 / F5 / B) in 1,101 s |
| Audit PoC re-run (`scripts/gen8/audit-rerun.sh`, then `npx hardhat --config hardhat.audit-rerun.config.ts test` and `node audit-rerun/D/fork-econ.mjs --sims grad,grad2,splitter`) | see the table below |

Audit PoCs against the fixed code (a FAILING PoC is an exploit that no longer works):

| PoC | Finding | Outcome now | Evidence |
|---|---|---|---|
| A-1 (`auditA.spec.ts`) | forced graduation, one unlock | fixed (F1): fails at `release` | `reverted with custom error 'PriceBelowGraduation()'`; fees after the round trip 2% (fixes spec, fork `fixes`) |
| A-2 | owner skips the A4 flush from inside an unlock | fixed (F3): fails | no `RouterFlushFailed` exists; the bucket is parked for the old router (hook.spec, fork `fixes`) |
| A-3 | free price push to MAX | fixed (F2): fails | `WrappedError(... 0xb47b2fb1) <- PriceAboveStart` |
| A coverage (`MwzSwapSim == Pool.swap`, 160 swaps) | check | still passes | |
| B-05 | immutable oracle band | fixed by inputs (F6): fails | $50,001 now launches; outside the new band refused (fixes spec) |
| B-01, B "checked" items (5) | info / checks | still pass | |
| C-M1 | third-party `claimRouter` griefing | fixed (F4): fails | `reverted with custom error 'NotRouterCaller()'` at the attacker's claim |
| C-L2 | deadline 0 in holder batches | fixed (F5): fails | `reverted with custom error 'BadClaimDeadline()'` |
| C-L1, C-COV, C-I1, C-M3 | operator band bound, band property, forced native, airdrop pot root (F16) | as written they now stop at their own setup claim (`NotRouterCaller`, default signer); with that setup claim made by the operator (copy `tests/C-operator-setup`, exploit steps unchanged) all four still reproduce: they are bounded-by-design items or open decisions (F16), not part of this round | |
| C-M2 (indexer worker, off chain) | dust claim parks the worker | on-chain trigger removed (F4); the worker's below-minimum rule is still an off-chain fix (F11) | |
| D grad (one unlock, sell-back WITHOUT a price limit) | D-H1 | fixed: the whole round trip reverts (F2), the latch is never set | BSC and Robinhood, $30K and $50K: `SIM grad FAILED: transaction execution reverted`; same flow locally: `PriceAboveStart` (fixes spec) |
| D grad2 (two transactions, one block) | D-H1 | fixed: the sell-back transaction reverts (status 0, F2); the attacker is left holding A's coins at the graduation price, i.e. a real graduation paid in full ($4,058 BSC / $4,059 RH at $30K, $6,764 / $6,766 at $50K) | `rerun-d.log` |
| D grad with the sell-back limited at the start price (our fork `fixes` area) | D-H1 variant | latch fires, nothing else changes: fees back to 2% through every router, reserve locked | below |
| D splitter | D-L3 | fixed (F4): the griefer's claim reverts | `data="0x544df468"` (`NotRouterCaller`) on both forks |

Remaining cost / benefit of forcing graduation (fork `fixes` area, oracle prices at the fork blocks: BNB $753, ETH
$2,529): one transaction or two in one block, sell-back limited at the start price: BSC $198 ($30K target, fresh
coin), $128 (after $1,000 of buyers), $330 / $250 ($50K); Robinhood $198 / $128 ($30K), $330 / $251 ($50K). About
40% of that is the 2% graduation fee, paid to the router bucket. Gain: none on fees (every later swap in A pays 2%
with the bonding split, through every router), League counting continues (phase flag), reserve locked. The only
remaining gain is the three-transaction bundle that releases the creator's reserve early (same cost, plus A's raise
as one-block capital: $3,980 at $30K, $6,631 at $50K); see 15.1.

Gas (local table `reports/gen8/local-gas.json`, before -> after): bonding swaps +0.5k to +1.6k on BNB, +1.7k to +2.8k
on Robinhood (one `slot0` read in `beforeSwap`, the phase in transient storage, the F2 check on sells); post-phase
swaps +3.7k to +4.8k BNB, +3.7k to +5.9k Robinhood (they read no price before; a graduated buy without a display still
skips the `afterSwap` read); crossing swap +0.7k / +1.8k; launch +1.0k to +2.9k (the `openAt` field and events);
`claimRouter` +5.4k (operator read); reserve release +6.9k (lock check and price read); everything else within
+0.1k. Forks (direct, warm): BSC buy 150,401 / sell 156,589 (was 149,827 / 154,944), Robinhood 135,340 / 141,231 (was
134,520 / 139,377); crossing BSC 250,037 (was 249,520), Robinhood 235,837 (was 233,826); launch with first buy BSC
1,798,800 (was 1,797,506), Robinhood 1,226,539 (was 1,223,237).

Sizes (runtime / initcode): hook 17,529 / 18,536 (was 16,708; limit 24,576, target 21,500), launcher 14,670 / 16,242,
lens 4,042 / 4,491, reserve lock 2,515 / 2,955, choice vault 13,119 / 13,688; others unchanged.
