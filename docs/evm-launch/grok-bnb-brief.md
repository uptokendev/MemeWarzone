# Grok brief, EVM generation (BNB 56): graduation adapters that survive a pre-made pool

Read first: `docs/evm-launch/EVM_LAUNCH_GENERATION_PLAN.md` (decisions E1-E10, C5, C7) and
`docs/evm-launch/spec/C7-bnb-adapters.md` (the spec you build to; its section numbers are used below).

## Branch rules (hard)

- Your own clone of `github.com/uptokendev/MemeWarzone`. Never the founder's working copy
  (`/mnt/e/network/Zakelijk/MemeWarzone`).
- Branch `grok/evm-bnb-adapters` from `origin/build/evm-launch-staging`. One pull request into
  `build/evm-launch-staging`. Never merge. Never push `build/*` or `fix/*`.
- No mainnet and no testnet transactions, of any kind. A local hardhat fork of BSC mainnet is the only
  chain you touch.
- Run every test yourself and paste the output into the PR. A test that reports pending or skipped
  counts as not run.
- Your commits carry no Claude `Co-Authored-By` trailer.

## Audit rules (verbatim from CLAUDE.md §1)

> **Contracts are written to pass a real audit on the first pass.** EVM contracts are immutable once
> deployed — there is no upgrade to fix a miss, so the audit happens before deployment, not after.
> Every change to a money path states its reentrancy guard, its checks-effects-interactions ordering,
> which states can and cannot reach it, what happens on over/underflow, and how it can be griefed. A
> new external function on a treasury is audited as a diff before it is tested, and tested before it
> is deployed. Write it so an external auditor finds nothing, not so it passes our tests.

## Parallel work (so you know what moves under you)

Claude builds, at the same time, on other branches: the campaign and factory (graduation calls your
adapter through `IGraduationAdapterV2`, approves `memeMax`, sends the pool native as `msg.value`, and
enables MEME transfers right before the call), the new treasury router, the creator vault and both
lockers, and the Robinhood adapters. Your tests use a harness campaign in `contracts/test/` that does
exactly what the interface section says. Pull `build/evm-launch-staging` before you open the PR and
rebase on it; conflicts in files outside your scope mean you edited something that is not yours.

## Scope

Yours:
- `contracts/integrations/BnbQuoteGraduationAdapter.sol` (new version, same file or a new V2 file).
- A new `contracts/integrations/BnbNativeGraduationAdapter.sol`.
- A shared internal library for the pool repair (spec section 4), for example
  `contracts/integrations/lib/TopazPoolRepair.sol`.
- Tests: unit tests against the Topaz mocks and the BSC mainnet-fork tests (spec section 8).
- In `scripts/deploy-bnb-quote-generation.ts`: only the lines that deploy, bind and read back the two
  adapters, and the on-chain Topaz pre-checks (spec section 9).

Not yours (Claude owns them; do not edit, even to make a test pass): `LaunchCampaign.sol`,
`BnbQuoteLaunchCampaign.sol`, `LaunchFactory.sol`, `BnbBasicLaunchFactory.sol`, every `TreasuryRouter*`,
every `CreatorRewardsVault*`, `PermanentLpLocker.sol` (Claude is changing its harvest: from this generation every harvest sells the
MEME-side fees for WBNB before the 80/20 split, decision E9; build against its registration interface,
which does not change),
`TopazRouterAdapter.sol`, `scripts/deploy-evm-treasury-router-v3.ts`, anything Robinhood. If your work
needs a change there, write it in the PR under "Needs from Claude" and build against a test-only
harness campaign in `contracts/test/`.

## The problem, in two lines

Anyone can create the MEME/WBNB or MEME/QUOTE Topaz pool before graduation, send it a little WBNB or
QUOTE and call `sync()`. Today the quote adapter reverts `FinalPoolAlreadyExists`
(`BnbQuoteGraduationAdapter.sol:257-259`) and the native path reverts inside the Topaz router
(`Router.sol:88`), so the coin never graduates (spec section 2).

## Facts to build on (verified, spec section 1)

- Topaz is Velodrome V2. Pool implementation `0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678` (verified on
  BscScan), factory `0x65E6cD0eF5D3467030103cf3d433034E570b5784`, router
  `0x1E98c8226e7d452e1888e3d3d2F929346321c6c3`, WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`,
  volatile fee 30.
- `Pool.mint`: first mint `sqrt(a0*a1) - 1000`, the 1000 goes to `address(1)`; `a = balance - reserve`;
  reserves are `uint256` (do not decode them as `uint112`). No swap is possible while a reserve is 0.
- Before graduation nobody but the campaign can move MEME (`LaunchToken.sol:42-55`), so a pre-made pool
  holds only WBNB or QUOTE and has `totalSupply == 0`. Your code relies on that and fails closed if it
  is not true.
- `PermanentLpLocker` accepts a pool someone else created; it requires `getFee == 30`.

## Build

1. **The repair library**, exactly spec section 4: find or create the pool, require
   `totalSupply == 0`, read balances, `T = mulDiv(bx + N, Mt, N)`, `m = min(T - bm, Mmax)`, transfer `m`
   MEME and `N` of the paired token into the pool, `mint(locker)`, post-checks. Never `skim` or `sync`.
   All of `N` is always deposited.
2. **`BnbNativeGraduationAdapter`**: `nonReentrant`; caller must be `campaignFactory.isCampaign`
   (factory set once, as today `:197-204`); wraps `msg.value` into WBNB; runs the library; LP to the
   locker; holds nothing afterwards; no admin power over funds.
3. **`BnbQuoteGraduationAdapter`**: keep route policy, oracle, liquidity, impact and oracle-deviation
   checks and the acquisition swap (`:242-298`); remove `:257-259`; replace `:300-317` with the library;
   make the USD graduation deviation check one-sided on the post-mint pool price (below target reverts,
   above is allowed); check the pool's QUOTE balance rose by exactly `N` before minting.

## Interface to build against (fixed)

The interface is a real file on `build/evm-launch-staging`: `contracts/interfaces/IGraduationAdapterV2.sol`.
Import it; do not copy or edit it. If you believe it must change, stop and write it under "Needs from
Claude". The text below is the same file, for reading.

```solidity
// One interface for every graduation adapter (BNB Topaz native + quote, Robinhood V3 native + stock).
// Fixed for this build (Claude, 2026-09-30). Do not change it; ask.
interface IGraduationAdapterV2 {
    struct Request {
        address token;              // campaign MEME
        address quoteToken;         // address(0) = native pool
        uint256 memeTarget;         // Mt: MEME that prices the pool at the curve price with no donation
        uint256 memeMax;            // Mmax >= Mt: MEME the adapter may pull from msg.sender (full burn budget)
        uint256 curvePriceWad;      // native per MEME at the curve's last price, 1e18
        uint256 nativeUsdWad;       // oracle price used by quote paths, 1e18 (0 on native paths)
        uint256 deadline;
    }
    struct Result {
        address pool;
        uint256 positionId;         // V3 NFT id; 0 on V2
        uint256 liquidity;          // LP amount (V2) or V3 liquidity, held by the locker
        uint256 memeUsed;           // Mt <= memeUsed <= Mmax
        uint256 pairedUsed;         // native (msg.value) or quote acquired
        uint256 donationFound;      // paired-token balance a third party left in the pool
        uint256 startPriceWad;      // pool price after the mint, paired per MEME, 1e18
        bool repaired;              // an existing pool was found and repaired
        uint256 repairMemeSold;     // V3 repair: MEME sold into a pre-made pool (part of memeUsed)
        uint256 repairProceeds;     // V3 repair: native/quote received for it (put into the position)
    }
    function graduate(Request calldata r) external payable returns (Result memory);
}
```

**Token flow: the adapter pulls.** The campaign approves `memeMax` to the adapter and sends the pool native
as `msg.value`. The adapter moves MEME with `transferFrom(campaign, <pool or NPM path>, m)` and never
holds MEME between calls; the unused allowance is reset to 0 by the campaign after the call. The campaign
enables token transfers inside the same `graduate()` transaction immediately before the adapter call, so
no third party can move MEME before the pool is minted (invariant I1: before the graduation transaction,
no MEME can reach any pool). Native or quote dust is returned to `msg.sender`; the adapter holds nothing
afterwards. The campaign checks every amount by balance delta, not by trusting `Result`.

## Tests

Unit (mocks): every branch of the library, each revert, rounding (price never below target), cap
binding, `bm > 0` and `totalSupply > 0` fail closed.

BSC mainnet fork (`BNB_FORK=1`, `--network hardhat`, mine one block before the first read), with a
test-only harness campaign that holds MEME as token owner: all eleven cases of spec section 8, both
adapters. For each: graduation succeeds, invariants 1-5 of spec section 7 hold, the locker registers
the pool, a buy and a sell through the real Topaz router work afterwards, a harvest against today's `PermanentLpLocker` pays 80/20 (a smoke test only: the new locker's
harvest is tested by Claude). Case 7
(griefer tries to get MEME into the pool) must show every attempt reverting. Case 9 (custom fee)
documents the failure; do not work around it.

## Hand-in checklist (PR description)

- Branch, head commit, every changed file with one line on why.
- Full output of `npx hardhat test` for your specs and of the fork run. Zero pending.
- Gas: graduation gas for each adapter in the baseline case and the synced-donation case, next to
  today's router path from the same fork block.
- A written audit block for every new or changed external function: reentrancy guard, CEI order,
  reachable and unreachable states, over/underflow, griefing (donations, `skim`/`sync` races,
  sandwich).
- "Needs from Claude": every change you need in files outside your scope.
- Anything you could not follow, and why. Plain sentences, no em dashes, no slogans.
