# DogeOS DOGE/USD testnet oracle — audit diff (gate 2)

**Subject:** `contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol` (commit `7abea7299`)
**Baseline:** `contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol` (unchanged since branch point `6c5ca159a`)
**Consumer:** `contracts/GraduationOracle.sol`, constructed as `GraduationOracle(feed, 3600)`
**Plan:** `docs/templar/plans/2026-10-10-dogeos-foundation-launch.md`, Task 4; spec gate 2
**Rule applied:** CLAUDE.md §1 "Contracts are written to pass a real audit on the first pass" — reentrancy guard, checks-effects-interactions ordering, reachable states, over/underflow, griefing, stated per money path. This contract holds and moves no funds, but it *prices* a money path (the gen-7 graduation target), so it gets the full treatment.
**Date:** 2026-10-10. Written as an external auditor would; the verdict is allowed to be FAIL.

Scope note: this audit covers the oracle contract and the way `GraduationOracle` and `LaunchFactoryGen7` consume it. It does not re-audit gen-7 (`contracts/gen7/*` is unchanged on this branch, verified by `git diff --stat 6c5ca159a -- contracts/gen7 contracts/integrations contracts/robinhood` → empty). The off-chain price push worker (spec §4) did not exist at the time of writing and is covered only as part of the trust model.

## Diff

Command (the original is CRLF in the working tree, the new file is LF; `--strip-trailing-cr` removes that noise so only semantic lines show):

```
diff -u --strip-trailing-cr contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol
```

Output (header timestamps are working-tree mtimes, not meaningful):

```diff
--- contracts/robinhood/testnet/RobinhoodTestnetEthUsdOracle.sol	2026-10-10 10:46:15.634036700 +0200
+++ contracts/dogeos/testnet/DogeosTestnetDogeUsdOracle.sol	2026-10-10 14:12:01.828065900 +0200
@@ -1,18 +1,18 @@
 // SPDX-License-Identifier: MIT
 pragma solidity ^0.8.24;
 
-/// @title Robinhood Testnet ETH/USD AggregatorV3-compatible oracle
-/// @notice Testnet-only price feed for MemeWarzone Robinhood chain-46630 staging infrastructure.
-/// @dev This contract intentionally refuses Robinhood production chain 4663. Local chain 31337 is
-///      permitted only when the constructor explicitly enables rehearsal mode for deterministic CI.
-contract RobinhoodTestnetEthUsdOracle {
-    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
-    uint256 public constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
+/// @title DogeOS Chikyu Testnet DOGE/USD AggregatorV3-compatible oracle
+/// @notice Testnet-only price feed for MemeWarzone DogeOS chain-6281971 staging infrastructure.
+/// @dev This contract refuses every chain except DogeOS Chikyu testnet 6281971. DogeOS has no mainnet
+///      chain id, so there is no separate mainnet-forbid branch. Local chain 31337 is permitted only
+///      when the constructor explicitly enables rehearsal mode for deterministic CI.
+contract DogeosTestnetDogeUsdOracle {
+    uint256 public constant DOGEOS_TESTNET_CHAIN_ID = 6281971;
     uint256 public constant LOCAL_REHEARSAL_CHAIN_ID = 31337;
     uint8 public constant decimals = 8;
     uint256 public constant version = 1;
-    string public constant description = "ETH / USD - Robinhood Testnet 46630";
-    string public constant SOURCE_VERSION = "mwz-rh46630-eth-usd-aggregator-v1";
+    string public constant description = "DOGE / USD - DogeOS Chikyu Testnet 6281971";
+    string public constant SOURCE_VERSION = "mwz-dogeos6281971-doge-usd-aggregator-v1";
 
     struct Round {
         int256 answer;
@@ -39,10 +39,9 @@
     constructor(address updater_, int256 initialAnswer, bool allowLocalRehearsal) {
         if (updater_ == address(0)) revert ZeroUpdater();
         if (initialAnswer <= 0) revert InvalidAnswer(initialAnswer);
-        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);
 
         bool localAllowed = allowLocalRehearsal && block.chainid == LOCAL_REHEARSAL_CHAIN_ID;
-        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID && !localAllowed) revert WrongChain(block.chainid);
+        if (block.chainid != DOGEOS_TESTNET_CHAIN_ID && !localAllowed) revert WrongChain(block.chainid);
 
         updater = updater_;
         certifiedChainId = block.chainid;
@@ -55,7 +54,7 @@
         _;
     }
 
-    /// @notice Publish a new positive ETH/USD answer. Every update creates a fresh monotonically increasing round.
+    /// @notice Publish a new positive DOGE/USD answer. Every update creates a fresh monotonically increasing round.
     function updateAnswer(int256 newAnswer) external onlyUpdater returns (uint80 roundId) {
         if (newAnswer <= 0) revert InvalidAnswer(newAnswer);
         roundId = _writeRound(newAnswer);
```

Three hunks. Everything outside them — the `Round` struct, the five custom errors, the three immutables, `_latestRoundId`, `_rounds`, the `AnswerUpdated` event, the second half of the constructor, `onlyUpdater`, `updateAnswer`'s body, `latestRoundData`, `getRoundData` and `_writeRound` — is byte-identical after CR stripping. That satisfies the plan's "everything else stays line-for-line".

### Hunk 1 (lines 1–18): header comments, contract name, constants

| Line | Change | Enumerated in the plan? | Assessment |
|---|---|---|---|
| `@title` | "Robinhood Testnet ETH/USD …" → "DogeOS Chikyu Testnet DOGE/USD …" | No (NatSpec) | Acceptable. Pure documentation; no bytecode effect (`bytecodeHash: none`, and NatSpec is not compiled in). Leaving the Robinhood title on a DogeOS contract would be an actively misleading artifact on L2Scan after verification, so the rewording is *required* for correctness of the published metadata, not merely tolerated. |
| `@notice` | chain-46630 → chain-6281971 | No (NatSpec) | Acceptable, same reasoning. The text states the real lock. |
| `@dev` | "intentionally refuses Robinhood production chain 4663" → "refuses every chain except … 6281971. DogeOS has no mainnet chain id, so there is no separate mainnet-forbid branch." | No (NatSpec) | Acceptable and, importantly, **truthful**: it documents hunk 2's removed line and gives the reason, which is exactly what the plan's enumerated change list says ("no mainnet-forbid branch, because DogeOS has no mainnet id"). The comment matches the code; an auditor's main concern with comment edits is drift between prose and behaviour, and there is none here. |
| contract name | `RobinhoodTestnetEthUsdOracle` → `DogeosTestnetDogeUsdOracle` | Implied by the plan's file name | Acceptable and necessary: both contracts compile in the same Hardhat project, so a duplicate name would break `getContractFactory`. No functional effect. |
| `ROBINHOOD_TESTNET_CHAIN_ID = 46630` → `DOGEOS_TESTNET_CHAIN_ID = 6281971` | Renamed and revalued | Yes | Acceptable. 6281971 is the verified Chikyū id (spec "Verified chain facts", plan global constraints). The public getter name changes, so any script that read `ROBINHOOD_TESTNET_CHAIN_ID()` on this contract would fail loudly rather than return a wrong chain — that is the right failure mode. The test pins `DOGEOS_TESTNET_CHAIN_ID() == 6281971` and pins the absence of both Robinhood getters. |
| `ROBINHOOD_MAINNET_CHAIN_ID = 4663` | Removed | Yes | Acceptable. The constant existed only to feed the mainnet-forbid branch removed in hunk 2. Keeping a dead Robinhood constant on a DogeOS contract would be misleading. Nothing in the repo reads it from this contract. |
| `description` | "ETH / USD - Robinhood Testnet 46630" → "DOGE / USD - DogeOS Chikyu Testnet 6281971" | Yes (verbatim) | Acceptable. String constant, ABI-exposed, informational only. `GraduationOracle` does not read it. Matches the plan string exactly. |
| `SOURCE_VERSION` | "mwz-rh46630-eth-usd-aggregator-v1" → "mwz-dogeos6281971-doge-usd-aggregator-v1" | Yes (verbatim) | Acceptable. Informational; matches the plan string exactly. |

Unchanged in this hunk and verified as such: `LOCAL_REHEARSAL_CHAIN_ID = 31337`, `decimals = 8`, `version = 1`. `decimals = 8` is load-bearing for the consumer (see Trust model) and is pinned by the test.

### Hunk 2 (lines 39–48): constructor chain lock

| Change | Enumerated? | Assessment |
|---|---|---|
| Removed `if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);` | Yes | Acceptable. The line was a belt-and-braces guard in the original: the next check (`chainid != TESTNET && !localAllowed → WrongChain`) already rejects 4663, so the removed line was never the *only* thing standing between the contract and a mainnet deploy. On DogeOS there is no mainnet id to name. The remaining allow-list check is strictly tighter than any deny-list: the only chain ids that can ever hold a deployed instance are 6281971 and 31337 (the latter only with the flag). In particular 4663, 56, 1 and every other id are refused. The removal does not widen the reachable set. |
| `ROBINHOOD_TESTNET_CHAIN_ID` → `DOGEOS_TESTNET_CHAIN_ID` in the allow-list check | Yes | Acceptable; this is the rename from hunk 1 applied at its single use site. The condition's shape is unchanged. |

Unchanged and verified: `ZeroUpdater`, `InvalidAnswer` on `initialAnswer <= 0`, the `localAllowed` computation (requires **both** the flag and `chainid == 31337`, so passing `allowLocalRehearsal = true` on 6281971 does not set `localRehearsal`, and passing it on any other chain does not bypass the lock), the three immutable writes and the initial `_writeRound`.

### Hunk 3 (lines 54–60): `updateAnswer` NatSpec

| Change | Enumerated? | Assessment |
|---|---|---|
| `@notice` "positive ETH/USD answer" → "positive DOGE/USD answer" | No (NatSpec) | Acceptable. Comment only; the function signature, modifier, check and body are identical. Not changing it would leave a comment that contradicts `description`. |

### Diff conclusion

All three hunks are either (a) the four enumerated changes from the plan, (b) the contract rename the file name implies, or (c) NatSpec rewordings whose only effect is to keep the published documentation truthful about (a). No hunk touches storage layout, access control, arithmetic, the ABI of the AggregatorV3 read functions, or the event. The NatSpec edits were not in the plan's enumerated list; they are accepted because a comment that still said "Robinhood", "ETH/USD" or "refuses 4663" on this contract would be a documentation defect that an auditor would flag, and the plan's "line-for-line" clause is about behaviour, which is preserved.

## Reentrancy

**Finding: not applicable — no external calls, no value transfer, no reentrancy surface. No guard is needed and none is present, which is correct.**

- The contract makes zero external calls. There is no `call`, `transfer`, `send`, `delegatecall`, interface call, or token interaction anywhere in it. It has no `receive`/`fallback` and is not `payable` in any function, so it cannot hold DOGE.
- `updateAnswer` → `_writeRound` writes storage and emits an event. `emit` is not a call.
- `latestRoundData`, `getRoundData` and all constant/immutable getters are `view`/`pure` and read only this contract's own storage.
- Cross-contract: `GraduationOracle.nativeUsdPrice()` calls `priceFeed.latestRoundData()` and `priceFeed.decimals()` as `view` STATICCALLs. A STATICCALL cannot modify state, so even a malicious feed could not reenter the consumer; this feed does not try.

Nothing to fix.

## CEI

**Finding: checks-effects-interactions is satisfied trivially; every function is checks then effects, with no interactions.**

- `constructor`: checks (`ZeroUpdater`, `InvalidAnswer`, `WrongChain`) → effects (three immutables, then `_writeRound`, which writes `_latestRoundId`, `_rounds[1]`, and emits). No interaction.
- `updateAnswer`: check (`onlyUpdater` modifier runs before the body, then `InvalidAnswer`) → effect (`_writeRound`). No interaction.
- `_writeRound`: effects in a safe order — the new `roundId` is computed, `_latestRoundId` is advanced, then the round struct is written, then the event is emitted. A reader calling `latestRoundData` between those two SSTOREs is impossible (no external call between them; the EVM executes the transaction atomically), so there is no window in which `_latestRoundId` points at an unwritten round.
- `getRoundData`: check (`RoundUnavailable` when `updatedAt == 0`) after a storage read; `view`.

Nothing to fix.

## Reachable states

The state is: three immutables (`updater`, `certifiedChainId`, `localRehearsal`), `_latestRoundId`, and `_rounds`. Reachable states, by actor:

**Constructor (deployer, once).**
- Reverts, leaving no contract: `updater_ == 0` (`ZeroUpdater`); `initialAnswer <= 0` (`InvalidAnswer`); `chainid ∉ {6281971} ∪ ({31337} if `allowLocalRehearsal`)` (`WrongChain`).
- Success: exactly one of two states.
  - On 6281971: `certifiedChainId = 6281971`, `localRehearsal = false` (regardless of the flag — `localAllowed` requires `chainid == 31337`), `_latestRoundId = 1`, `_rounds[1] = {initialAnswer, t, t, 1}`.
  - On 31337 with the flag: `certifiedChainId = 31337`, `localRehearsal = true`, same round state.
- There is **no state in which the contract exists with `_latestRoundId == 0`**. Round 1 always exists at the end of construction, with a positive answer and `updatedAt > 0`. This is what makes `latestRoundData` safe to call at any time (it cannot return a zero round) and what makes `GraduationOracle.nativeUsdPrice()`'s `updatedAt == 0` branch unreachable through this feed.
- The deployer has no post-construction role. The contract has no owner.

**Updater (`updater`, forever).**
- The only mutating entry point is `updateAnswer(int256)`. Precondition: `msg.sender == updater`, `newAnswer > 0`. Effect: `_latestRoundId += 1`, `_rounds[new] = {newAnswer, now, now, new}`. Invariants that hold in every reachable state:
  - `_rounds[i].updatedAt > 0` for all `1 ≤ i ≤ _latestRoundId`, and `== 0` for all other `i` (the mapping is only ever written at `_latestRoundId` after increment; nothing deletes).
  - `_rounds[i].answer > 0` for all written `i`.
  - `_rounds[i].answeredInRound == i`, `startedAt == updatedAt`.
  - `_rounds[i].updatedAt ≤ _rounds[j].updatedAt` for `i < j` (block timestamps are non-decreasing; equal within one block).
  - Round ids are strictly increasing by exactly 1 per successful update; a revert does not consume an id.
- There is no `pause`, no `setUpdater`, no `selfdestruct`, no upgrade path. The updater cannot be rotated, revoked or added to. This is a deliberate copy of the Robinhood design and is the central fact of the Trust model section.

**Readers (anyone).**
- `latestRoundData()` never reverts; returns the latest round. `getRoundData(id)` reverts `RoundUnavailable` for `id == 0` and for any `id > _latestRoundId`; otherwise returns the stored round, echoing the requested `id` as the first return value (the named return `id` is shadowed by the explicit `return (roundId, …)`; this is identical to the original and harmless because `roundId` is the argument).
- `decimals()`, `version()`, `description()`, `SOURCE_VERSION()`, the chain constants and the immutables are constant for the contract's life.

**Unreachable by construction:** a negative or zero answer in any round; a round with `updatedAt` in the future (it is always `block.timestamp` at write time, so for the consumer `updatedAt > block.timestamp` can never be true); a round with `answeredInRound < roundId`; a gap in round ids.

## Overflow

**Finding: no exploitable overflow or underflow. Solidity 0.8.24 checked arithmetic applies to every operation; the one theoretically overflowable expression is unreachable in practice and fails closed.**

- `roundId = _latestRoundId + 1` (`uint80`): checked. Overflow would revert `updateAnswer` with a panic once `_latestRoundId == 2^80 − 1 ≈ 1.2 × 10^24`. At one update per ~3 s DogeOS block, forever, that is ~10^7 updates per year, so ~10^17 years. Unreachable. If it were reached the oracle would freeze at its last round and `GraduationOracle` would start reverting `StalePrice` after 3600 s — fail closed, not wraparound. The plan singled out the `uint80` round id; it is fine.
- `int256 answer`: only `> 0` is enforced. There is no upper bound. Consequence for the consumer: `GraduationOracle` casts to `uint256` (safe because `answer > 0` is checked there too) and multiplies by `10^(18−8) = 10^10`. `unsignedAnswer * 1e10` overflows `uint256` only if `answer > ~1.16 × 10^67`, which a fat-fingered or malicious push could technically send (`int256` max is ~5.8 × 10^76). The result is a checked-arithmetic revert inside `nativeUsdPrice()`, which `LaunchFactoryGen7._curveForTarget` catches and converts to `OraclePriceUnavailable` — campaign creation fails closed. Not an exploit; same behaviour as the original.
- `GraduationOracle.nativeTargetForUsd`: `Math.mulDiv(usdAmount, 1e18, price, Ceil)`. `usdAmount ≤ MAX_GRADUATION_TARGET = 1e24`, so the 512-bit intermediate is at most 1e42; `mulDiv` handles it without overflow and only reverts if the result exceeds `uint256`, which needs `price < 1e42 / 2^256`, i.e. `price` would have to be 0 — already rejected by `InvalidPrice`.
- `GraduationOracle.graduationReached`: `mulDiv(nativeBalance, price, 1e18)`. Not used by gen-7 (the gen-7 campaign graduates on `sold == curveSupply`, see Trust model), so irrelevant to DogeOS; noted for completeness.
- `block.timestamp - updatedAt` in the consumer: cannot underflow through this feed, because `updatedAt` is a past `block.timestamp` and the consumer checks `updatedAt > block.timestamp` first anyway.
- Timestamps are stored in `uint256`; `uint64(block.timestamp)` truncation is not used here (it is used in gen-7, out of scope).

Nothing to fix.

## Griefing

Who can hurt whom, and what bounds it.

**1. Non-updater callers.** Cannot change anything. `updateAnswer` reverts `UnauthorizedUpdater` for every other address, including the deployer (pinned by the test). Reads are free and unbounded, but `view` calls cost the caller gas only. There is no storage growth an outsider can cause: `_rounds` grows only by the updater's successful calls, one slot-set per round, paid by the updater. No griefing vector.

**2. Updater stops pushing (key lost, worker down, Binance down).** The oracle keeps returning the last round; it is the *consumer* that enforces freshness. After `maxPriceAge = 3600 s`, `GraduationOracle.nativeUsdPrice()` reverts `StalePrice`, and `LaunchFactoryGen7._curveForTarget` turns that into `OraclePriceUnavailable`, so **`createCampaign` fails closed**. Existing campaigns are unaffected: a native-quote gen-7 campaign reads the oracle exactly once, at creation, to size its curve, and graduates on `sold == curveSupply` without touching the oracle again (`LaunchCampaignGen7._checkGraduationDue`, "Effects only, no external call"). The quote-token branch of `_graduationRequest` that reads `nativeUsdPrice()` at graduation is the stock path, which DogeOS does not deploy (plan "Named exceptions"). So the blast radius of a stalled updater is: no new coins for as long as it is stalled, with a 3600 s grace. That is visible, bounded, and the spec's "stays fresh for 24 h with nobody touching it" DoD exists precisely to catch it.

**3. Updater pushes a wrong price (bug in the push worker, bad source tick, or a compromised key).** This is the real griefing path. Mechanics, for a campaign created while the price is wrong by a factor `k`:
- `nativeTargetForUsd(150e18) = ceil(150e18 · 1e18 / price)`. With the true price `p` and a pushed price `k·p`, the DOGE target becomes `(150 / p) / k`.
- `k > 1` (price too high): the coin graduates after raising `$150 / k` worth of DOGE. The curve and the V3 pool are seeded at a tiny market cap. Whoever knows the price is wrong can buy out the curve for almost nothing and own a graduated coin. On testnet the DOGE is faucet DOGE, so the "loss" is other testers' faucet DOGE and a broken rehearsal.
- `k < 1` (price too low): the coin needs `$150 / k` of DOGE to graduate and may never do so. It is a stuck curve; its parameters are immutable (`virtualNative`, `virtualToken`, `curveSupply` are fixed at create). The only remedy is to create a new coin.
- Campaigns created *before* or *after* the wrong window are untouched, because the oracle is read once per campaign.

What bounds it:
- **Time.** A single wrong push is usable by `createCampaign` for at most 3600 s unless the pusher keeps pushing. An attacker holding the key can of course keep pushing, so the staleness window bounds *persistence of a one-off bad value*, not the *magnitude* of a continuously-fed bad value. The plan's phrase "bounded by the GraduationOracle staleness window" is true for the one-off and the stall cases and must not be read as an economic cap on a live compromise.
- **Curve rails, not economics.** `LaunchFactoryGen7.curveForMarketCap` reverts `TargetOutOfRangeAtPrice` when `marketCapNative < MIN_MARKET_CAP_NATIVE = 1e15` (0.001 DOGE; needs a pushed price above about $150,000 per DOGE for a $150 target) or when the derived `virtualNative > MAX_VIRTUAL_NATIVE = 1e30` (roughly a pushed price below $10^-10 per DOGE). These are sanity rails spanning ~15 orders of magnitude; they stop absurd values from producing degenerate curves, they do not stop a 10× or 100× wrong price. There is **no per-round deviation limit in the oracle** and no on-chain cross-check against a second source. That is the same as the Robinhood original and the plan mandates line-for-line parity; it is recorded here as a known property, not fixed.
- **Target allow-list.** On 6281971 a campaign's `graduationTarget` must be `$150`, `$30,000` or `$50,000` (`isGraduationTargetAllowedForChain`), capped at `$1,000,000`. The oracle cannot change which USD target is allowed, only how much DOGE that target maps to.
- **Scope of the key.** The updater `0x7dBDFe829309B4170346CF7e4496094CD126E9c1` holds no other role (spec "Keys and ownership"); it is on the keeper's and payout watchdog's `FORBIDDEN_KEEPER_ADDRESSES` (spec gate 1, "the DogeOS deployer, the updater and the route authority"), so a compromised updater cannot also run graduation or payouts. The deployer key, which owns the factory, never shares a machine with it (the deployer key is never put in Coolify; the updater key is).
- **Chain lock.** The contract cannot exist on any chain but 6281971/31337, so a mistake here cannot touch BNB, Robinhood or Solana money.

**4. Updater pushes at a high rate.** Each push is ~3 SSTOREs plus an event, paid by the updater. It can fill `_rounds` with as many rounds as it pays for; `getRoundData` cost is O(1) regardless. No effect on readers.

**5. Front-running the push.** A `createCampaign` can land in the same block before or after an `updateAnswer`. Both prices are "fresh" by the oracle's definition; the creator gets whichever is current. With a push cadence of ≤30 min and a deviation trigger (spec §4), the discrepancy is the source's intra-interval move, which on testnet is immaterial. Noted, not a defect.

## Trust model

**What the feed is.** A single-writer, append-only price log. Its correctness is exactly the correctness of whoever holds the updater key. There is no aggregation, no deviation bound, no second signer, no heartbeat enforcement on-chain, no pause, no key rotation. It is a testnet stand-in for a Chainlink-style aggregator, used because Chikyū has no DOGE/USD feed.

**Who holds the key.** `DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY` for `0x7dBD…E9c1`, kept in gitignored `config/dogeos.local` locally and, per the spec, in the TEST indexer's Coolify environment for the automatic push worker. That makes it a **hot key**: it lives on an internet-connected service and signs without a human. A hot key is the correct choice for a feed that must be refreshed at least every 30 minutes (the staleness window is 3600 s), and the wrong choice for anything that holds value — which this key does not. It holds gas DOGE only.

**What it can do.** Exactly one thing: publish a positive `int256` as the next DOGE/USD round. It cannot move funds, cannot change the factory, cannot pause anything, cannot graduate anything (it is on `FORBIDDEN_KEEPER_ADDRESSES`).

**What a wrong price does.** Derived in Griefing §3: it mis-sizes the bonding curve of every campaign *created while the wrong value is current* — too-high price ⇒ premature, cheap graduation; too-low price ⇒ a curve that cannot sell out. Those campaigns are mis-sized forever. It does not affect campaigns already created, does not affect graduation of existing campaigns, does not move anyone's DOGE by itself, and on testnet the DOGE at stake is faucet DOGE.

**What a stopped key does.** No new campaigns after 3600 s, fail closed, everything else unaffected.

**Decimals and scaling (load-bearing).** `decimals() == 8`. `GraduationOracle` normalises by `answer * 10^(18−8)`. A pushed value must therefore be `round(usd * 1e8)`; `$0.25` is `25_000_000`. If the push worker ever sent an 18-decimal value, the oracle would accept it (it only checks `> 0`), `nativeUsdPrice()` would be 10^10 too high, and every campaign created in that window would graduate at ~`$1.5 × 10^-8` of DOGE. The oracle cannot detect that; the push worker must own the conversion, with a test (spec gate 1 lists "never ≤ 0, cadence and deviation"; the 8-decimal conversion needs an explicit unit assertion there — see Verdict). The test file pins `nativeUsdPrice() == INITIAL_ANSWER * 10^10`, which proves the consumer's scaling for the correctly-formatted case.

**Recovery if the key is compromised — the important limitation.** The oracle itself offers none: `updater` is immutable. The consumer-side remedy is `LaunchFactoryGen7.setGraduationOracle(newOracle)`, which is `onlyOwner whenMutable`, and `whenMutable` reverts `FactoryLocked` as soon as `_campaigns.length != 0`. **Once the first DogeOS campaign has been created, the factory's `graduationOracle` can never be changed.** A compromised or lost updater key after that point can only be handled by (a) accepting that creation goes `OraclePriceUnavailable` after 3600 s and the launchpad is effectively frozen for new coins, or (b) deploying a new factory (new `deployments/dogeos/testnet.json`, re-wiring the API/indexer/frontend). On Chikyū testnet, (b) is a redeploy of faucet-funded contracts and is acceptable. On any chain with real money this would be a blocking finding against the *system*, not the oracle: a mainnet deployment must use a governed/aggregated feed (Chainlink-class) or a `GraduationOracle` variant whose feed is rotatable, and that decision belongs to the mainnet plan, not to this testnet gate. The same limitation already exists on Robinhood 46630 with the original contract.

**Mitigations that must hold operationally (not enforced by the contract).**
1. The push worker signs only with the updater key, refuses any chain but 6281971 and refuses a key whose address is not `oracle.updater()` (spec §4). The push converts to 8 decimals and never writes `≤ 0`.
2. The worker skips, logs and alarms when the source fails rather than pushing a stale or default value.
3. A health check reads `latestRoundData()` and compares it with the live source; a deviation beyond a set band or an age beyond ~45 min pages someone before the 3600 s window expires.
4. The updater key never gains any other role; `FORBIDDEN_KEEPER_ADDRESSES` keeps it out of the keeper and payout watchdog, with a test.
5. The deployer (factory owner) key stays off the TEST indexer host so a host compromise yields only the updater.

**Test coverage, audit view.** `test/DogeosTestnetDogeUsdOracle.spec.ts` (11 passing on 2026-10-10) covers: chain refusal on 31337 without the flag; deploy with the flag and the recorded immutables, strings and version; absence of the Robinhood getters; `decimals == 8`; `ZeroUpdater`, `InvalidAnswer(0)`, `InvalidAnswer(-1)` at construction; `UnauthorizedUpdater` for a stranger and for the deployer; `InvalidAnswer(0 / -1)` on update with the previous round intact; rounds 1→2 with `answeredInRound == roundId`, `startedAt == updatedAt`, non-decreasing `updatedAt`, and the event; `getRoundData` for 1 and 2, `RoundUnavailable` for 0 and 3; `GraduationOracle(feed, 3600).nativeUsdPrice()` scaling and `StalePrice` after 3601 s. Gaps that matter to this audit, none of which blocks:
- **Acceptance on 6281971 is not tested.** Hardhat cannot change `block.chainid` at runtime, so only the 31337 branch of the allow-list is exercised. The positive 6281971 branch is proven by gate 3 (fork of Chikyū, which must run with `chainId: 6281971`) and gate 4 (the real deploy). The negative branch "flag set on a chain ≠ 31337 is still refused" is likewise untested for the same reason; it is correct by inspection (`localAllowed` requires both).
- **No test from the pushed 8-decimal value through to the DOGE target.** `nativeTargetForUsd(150e18)` should equal `600e18` at `$0.25`; the suite stops at `nativeUsdPrice()`. The arithmetic is `GraduationOracle`'s, already covered elsewhere for gen-7, but one assertion here would pin the end-to-end unit (8 dec → 18 dec → DOGE) for the DogeOS pair specifically. Recommended for the push-worker task, not required for this gate.
- **The staleness boundary is tested at 3601 s only.** An assertion that `3600 s` exactly still reads would pin the `>` versus `>=` semantics. Minor.
- `IncompleteRound` and `InvalidPrice` in the consumer are not reachable through this feed (see Reachable states) and need no test here.

## Verdict

The DogeOS oracle is a faithful copy of the Robinhood testnet oracle with the four enumerated changes and nothing else of substance. The NatSpec rewordings, which the plan did not enumerate, are accepted: they only make the published documentation true for this contract and the removed mainnet branch. The contract has no external calls and therefore no reentrancy surface; every function is checks-then-effects; every reachable state keeps a positive answer, a non-zero `updatedAt` and `answeredInRound == roundId`; the only overflowable expression (`uint80` round id) is unreachable and fails closed; and a non-updater cannot affect it at all.

The risks that remain are properties of the design the spec asked for, not defects in the copy: a single hot updater key with no on-chain deviation bound, an immutable updater, and a consumer whose feed pointer locks on the first campaign. On Chikyū testnet with faucet DOGE, with the key scoped to this one role and the push worker's guards and health checks in place, those are acceptable. They are recorded above so that a mainnet plan does not inherit them unexamined: a real-money deployment needs an aggregated or governed feed, and a way to rotate the feed on the factory.

Required follow-ups carried to later tasks (none blocks this gate): the push worker's unit test must assert the 8-decimal conversion explicitly; the health check must alarm before the 3600 s window; gate 3's fork must run with `chainId: 6281971` so the positive chain branch is actually executed before the real deploy.

Verdict: PASS
