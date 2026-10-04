# BNB and Robinhood contracts: audit before deployment (2026-09-23)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

## 4c. BNB and Robinhood contracts — audit before deployment (2026-09-23)

Mandate: BNB and Robinhood behave exactly as Solana, EVM-adapted. Contracts are
immutable once deployed, so the audit is a precondition, not a review.

**EVM suite: 683 passing, 0 failing.** It was 618 passing / 67 failing.

### Four contract bugs, all found before deployment

1. **`setCoreRouting` bricked the launchpad.** `LaunchFactory.leagueReceiver` was
   `immutable` while `feeRecipient` was not. `LaunchCampaign` only takes the
   unified routing path when they are equal, and the factory stamps every
   campaign `strictFeeRouting: true` -- so the first treasury-router migration
   left them permanently apart and every campaign created afterwards reverted
   `FeeRoutingFailed` on every buy and sell. Reachable by a routine admin action.
   They now move together in one transaction.
2. **A Live war pool that was never resolved locked every wei.**
   `ArenaWarPoolTreasuryV2` stored `resolveDeadline` and never read it; the only
   exits from Live needed a signed outcome. `settleExpiredPool` is permissionless
   and deadline-gated. Boosts were a pool aggregate with funders only in events,
   so the per-wallet `boosts` mapping and `refundBoost` had to land in the same
   change or expiry would have stranded them.
3. **`cancelOpenPool` had a discretionary branch.** `pool.ownerA` or the owner
   could close a pool before its deadline, and `openTournamentPool` sets `ownerA`
   to the creator -- so a tournament creator could close a pool already holding
   other people's entry fees. Removed, matching the Solana rule. Both remaining
   exits are permissionless and gated on deadlines fixed at open time.
4. **Robinhood stock graduation could never complete.**
   `RobinhoodStockTokenGraduationAdapter` minted the LP position straight to the
   locker, but `NonfungiblePositionManager.mint` uses `_mint`, not `_safeMint`,
   so `onERC721Received` -- the locker's only way to record a position -- never
   fired. Every graduation reverted `PositionMissing`, on every retry.
   `RobinhoodUniswapV3GraduationAdapter` already documented the trap and minted
   to itself before safe-transferring in; the stock adapter now does the same.
   Those are the only two position mints in the codebase.

**Three of the four were invisible behind the broken test suite.** The suites
that would have caught them were failing for unrelated reasons, so nobody could
see them. That is the argument for fixing tests before an audit, not after.

### Two facts that change the BNB deployment

- **The existing treasury router cannot serve the new contracts.**
  `0xe157a6FDf19CAB61f2ECa048966f137A3240a921` has no `creatorRewardsVault()`,
  and `TreasuryRouterV3._routeTrade` requires it. A new `TreasuryRouterV3` is a
  mandatory part of the deployment set. Production is fine today only because the
  deployed campaign implementation `0xbe3caF64…` predates `strictFeeRouting`.
- **Pausing the treasury router halts all trading.** Under strict routing a fee
  that cannot route reverts the trade instead of escrowing into `pendingNative`.
  No fee limbo, but it is an operational property worth knowing.

### The V3 fee model, now pinned

A trade fee pays the creator **5%**, taken from what was the protocol's: on a
2 BNB fee, protocol takes 0.85 where the old model took 0.95. League is 37.5%,
split weekly/monthly. Finalize fees carry no creator or league share.
Conservation is asserted across all six destinations for every profile.

### Why the suite was broken

Fixtures deployed `TreasuryRouter` V1 where the factory demands V3's
`routeTrade`/`routeFinalize`; against V1 the call reverts with no reason at all,
which was 54 of the 67. Then `RouteAmounts` gained a `creator` field and league
split weekly/monthly, so balance helpers reading only the weekly vault saw 30% of
the league and none of the creator -- a correctly routed fee looked like lost
money. `deployConfiguredTreasuryRouter` stays on V1 because the V1 router specs
are its subject; campaign and factory fixtures use `…V3`. Switching the shared
one silently stopped testing V1 and cost five passing tests before I caught it.

### The BNB deployment, in order

Two scripts, and they are not interchangeable. Running both factories would put
two active factories in front of users.

1. **`scripts/deploy-evm-treasury-router-v3.ts`** — `TreasuryRouterV3` plus its
   vaults, and nothing else. This is the one proven on BSC testnet (router
   `0x529C0c4A…`, all four vaults wired and read back). The router's admin is
   the Safe on mainnet, so the four vault-wiring calls come back as Safe
   transactions rather than EOA calls. It refuses to invent placeholder vaults
   on a mainnet profile: a placeholder is an `AcceptingReceiver`, which takes
   league fees and can never pay them out, and nothing about that fails loudly.

   **Not `scripts/deploy-bnb-mainnet-v3-cutover.ts`.** It deploys the same
   router and vaults *plus* a plain `LaunchFactory` and campaign implementation
   that the quote generation supersedes — a second factory in front of users and
   wasted mainnet gas. It has never been run and stays for
   `prove-bnb-mainnet-v3-cutover.test.mjs`, which pins its shape.
2. **`scripts/deploy-bnb-quote-generation.ts`** — everything from the factory up:
   `LaunchCampaign` impl, `BnbQuoteLaunchCampaign` impl, `BnbBasicLaunchFactory`
   (which deploys its own locker), `BnbQuoteGraduationAdapter` (needs that
   locker, so it cannot come earlier), `PostGradLeagueTreasuryV2`,
   `ArenaWarPoolTreasuryV2`. Takes the router from step 1 as input.

Everything lands closed: `createPaused` true, `live` false, war pool deposits
paused, and the script never calls `enableLive`. Quote routes, ownership
transfer to the Safe, and going live are separate deliberate steps.

**The script refuses a router that cannot serve strict routing.** It probes
`creatorRewardsVault()` and the other five vaults and refuses with the
consequence named. BNB mainnet's current router fails that check — which is the
point, since pointing the new factory at it would brick the generation on day
one. A paused router is refused for the same reason.

Rehearsed on a throwaway chain by `test/BnbQuoteGenerationDeploy.spec.ts`, which
drives the same wiring in the same order, asserts the end state including that
`createCampaign` is rejected, and proves both refusals fire.

### Still to do on BNB

Superseded by `evm-deployments.md`: both steps have now run on BSC testnet against real Topaz,
and the launchpad and battle system are proven there end to end. What remains
is in `evm-deployments.md` "Still to do".



### ProtocolRevenueForwarder: LP protocol 20% (2026-10-04, built and tested, NOT deployed)

The gen-6 lockers route the LP protocol 20% as WBNB/WETH through `TreasuryRouterV4.routeLpToken` into
`ProtocolRevenueVault`, which only forwards native and has no ERC20 path: that share is stuck once it lands.
Fix: `contracts/ProtocolRevenueForwarder.sol` becomes the router's `protocolRevenueVault`. Native in is
forwarded to the existing vault in the same call (operator fill, overflow to the Safe, unchanged); wrapped
native waits for a permissionless `flush()` that unwraps and forwards; other ERC20s leave only to the Safe
(`withdrawToken`). No setters, no storage besides the reentrancy flag.

- Safe steps per chain: PF1 `proposeProtocolRevenueVault(forwarder)`, >= 3600 s, PF2 `acceptProtocolRevenueVault()`
  (`scripts/make-protocol-forwarder-batches.ts`). Rollback: same pair with the old vault (`ROLLBACK=1`).
- Deploy: `scripts/deploy-protocol-revenue-forwarder.ts` (dry run by default, eth_call-simulates the constructor).
- Gas: +~10,970 per routed protocol share (every buy, sell, create first buy, graduation). Harvest unchanged.
- Residual risk until PF2 executes: a public `harvest()` after a gen-6 graduation sends the 20% to the old vault,
  permanently. On 2026-10-04 no gen-6 coin had graduated on either chain (only the hidden canaries exist).
- After PF2: finance registry `protocol` entry and the "LP share stuck" warnings in
  `frontend/api/lib/financeFeeRoutingEvm.js` / `financeFeeRoutingOwnership.js`, vault `Deposit.from` becomes the
  forwarder for router routes, lift the API harvest pause (`LP_HARVEST_PAUSED_CHAIN_IDS`), add the forwarder to
  `config/verification/mainnet-contracts.json`.
