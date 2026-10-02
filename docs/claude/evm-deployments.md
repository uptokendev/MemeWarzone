# BNB and Robinhood: testnets, mainnet inputs, mainnet deployments (2026-09-23/24)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

## 4d. Both testnets deployed and driven end to end (2026-09-23)

Founder: "There is no launch on BNB or Robinhood so we need to do whatever it
takes to get it right and deploy on mainnet when ready." Nothing live means
nothing to protect, so the acceptance records pinned to the previous
generations are superseded rather than sacred.

### What is deployed, closed, and proven

**BSC testnet (97)** — bound to the *authoritative* 30 bps Topaz.

| | |
|---|---|
| BnbBasicLaunchFactory | `0xFb8159f46BAB4e214F658c2c8f5CfF76C102E848` |
| PermanentLpLocker | `0xdb3E9A2aa097c95e65ED67bfB9ACc58Dd2c776d1` |
| LaunchCampaign impl | `0xE0e3b38e2F9EE0CCb416f81FD6E19e6aF2B56975` |
| BnbQuoteLaunchCampaign | `0x6132b87fd2648ef2818831501d6AB6dA4ec2A435` |
| BnbQuoteGraduationAdapter | `0xc6FcfAaceF6A64998af523eb8124877de4Cce782` |
| PostGradLeagueTreasuryV2 | `0x8A8aCCAe4E2dA530A7A1AB7CA3fDD5014DaDE401` |
| ArenaWarPoolTreasuryV2 | `0x014816B8063ae091d5EFEFcA181ca2aF53A16813` |
| CreatorRegistry | `0x13D803b58E3Dd43650f53Bd7BBe4f430E850859f` |
| TopazRouterAdapter (30 bps) | `0x13537C6273dF312067cE775AAf9635c217A931fd` |
| TreasuryRouterV3 | `0x529C0c4AC803325F9D7a736eF2067D1C0e1C0ed4` |

**Robinhood testnet (46630)** — factory `0xde9f7055f768A6A1AFBCD5263be64961241927a4`,
locker `0x387E178ac36d386ed648E282F377Cb9Ce2B9F8A9`, war pool
`0xE6Dd149E7E447dAfB1527784252f1A1873c64B74`, league
`0x4Ce88dCd64631AFb7E321Ff1f49DC1b4F423fE74`, stock adapter
`0x52e45372C7a191814039D0089ba79808f435b2d3`, native swap adapter
`0x1295966E4C250f612F7347fd42196ADd0673D7F0`, CreatorRegistry
`0x77ca02849c0AcdC8BDFF81E2BcC0062411846D78`, RiskRegistry
`0x3D79cFeF21eF34eD7e499d702C2D77A5d8dAaa34`.

Both end closed: `createPaused` true, war pool deposits paused. `enableLive`
has no inverse, so a factory that has been live stays `live=true` and **create
is the only gate** — do not read `live` as "open".

### The launchpad runs end to end on BSC testnet against real Topaz

Authorized create → buy → sell → creator fee claim → graduation into the real
30 bps Topaz → post-graduation buy and sell on that pool → LP principal
unchanged → harvest. Proven by transfer logs, not by events: the pool paid the
locker 11999999999949 WBNB, the locker paid the creator 9599999999959 and the
protocol vault 2399999999990. Exactly 80/20, nothing parked, second harvest
collects nothing.

Harness: `scripts/test-bnb-real-topaz-testnet-lifecycle.ts` with
`reports/bnb-real-topaz-testnet-stage.json`.

### The battle system runs end to end on **both** chains

`scripts/canary-arena-war-pool.ts` — one real battle: open, both sides stake,
a boost priced by a signed `BoostQuote`, resolution by the resolver's EIP-712
signature, then all three claims. Identical results on 97 and 46630:

```
entry 0.004 -> league 0.0008 (20%)  protocol 0.0002 (5%)  prize 0.003 (75%)
boost 0.001 -> protocol 0.0001 (10%)  prize 0.0009 (90%)
```

Checked against balances that moved, not against the event. `claimWinner` is
callable only by `winnerPayout` and pays `msg.sender`, so the winner's gas has
to be added back; `claimProtocol`/`claimLeague` are permissionless and are sent
by a third party so the recipient's balance moves by the payout alone;
`claimLeague` rejects a zero epoch. Deposits are closed again unconditionally.

### Five deployment bugs, every one of them mainnet-reaching

1. **Two Topaz addresses, not one.** `LaunchFactory`'s constructor calls
   `poolFactory()`; `BnbQuoteGraduationAdapter`'s calls `defaultFactory()` and
   `weth()`. On BNB mainnet the adapter `0x5c3135Df…` answers only the first
   and Topaz's router `0x1E98c822…` only the second. The profile pinned one
   address for both, so the factory constructor would have reverted on mainnet.
2. **`setCreatorRegistry` / `setRiskRegistry` do not exist.** The setter is
   `setRegistries(creator, risk)`.
3. **Nothing registered the factory as a launch recorder.** `createCampaign`
   calls `creatorRegistry.recordLaunch` behind `onlyLaunchRecorder`, so an
   unregistered factory cannot create one campaign.
4. **The testnet Topaz we first reused charges 100 bps.**
   `PermanentLpLocker.REQUIRED_POOL_FEE_BPS` is 30 and `lockPosition` reverts on
   anything else, so that generation would have graduated nothing — failing
   *after* a campaign had already sold out. BSC testnet has two Topaz
   deployments and nothing in the addresses says which is which. **The
   authoritative one is `deployments/bscTestnet/minimal-topaz.json`**: router
   `0xa241AEd1…`, pool factory `0xb9F2b64D…`, WBNB `0xcd2c3492…`, 30 bps. The
   100 bps one is router `0xe559d936…` / pool factory `0xE3434671…`.
5. **The locker was never authorized on the treasury router, and that fails
   silently.** Both lockers route the protocol's share of every LP harvest
   through `TreasuryRouterV3.routeLpToken` behind `authorizedLpLocker`, and both
   wrap it in try/catch on purpose — a treasury that refuses money must not be
   able to brick a harvest. So an unauthorized locker does not revert: it pays
   the creator in full, parks the protocol share in `pendingProtocolToken`,
   emits `HarvestPaymentPending`, and reports success. Every surface a
   deployment looks at reads healthy; only the protocol vault, which nobody
   watches, stays at zero. On BSC testnet it stranded 38.223939265110348711
   tokens and 0.000005999999999996 WBNB. `retryPendingProtocolToken` is
   permissionless, so it is recoverable — after authorizing, every parked unit
   landed in the vault to the last digit.

The wiring lives in **one** place, `scripts/lib/evmLpLockerWiring.ts`, and both
deploy scripts call it. It handles all three real cases: a fresh router takes
one call; a router that has served a previous generation needs
propose → `upgradeDelay` → accept and the script says how long; a router whose
admin is not the deployer — **which is what mainnet is** — gets its transactions
printed with the consequence named.

Bugs 1–3 were invisible because the rehearsal deployed the registries and never
handed them to the factory or drove a create. 4 and 5 are invisible to any
rehearsal at all: only a real graduation and a real harvest show them.

### Things that will waste time if forgotten

- **BSC RPCs load-balance and lag.** A read straight after a confirmed
  transaction can land on a node a block behind. It aborted one deployment with
  all the gas spent. `readBack` in the deploy script retries; do the same in any
  new script rather than treating the first read as truth.
- **Robinhood's V3 side has no equivalent fee trap** — its locker reads
  `feeTier` off the adapter instead of pinning one. Deployed stack agrees at
  3000 with tick spacing 60.
- **The mainnet-fork proofs had never once executed.** Both reported *pending*
  on every run. One needed three signers where the fork config made two; both
  died on the first read because straight after forking `"latest"` is still the
  remote block and EDR will not execute on a historical block of a chain it has
  no hardfork history for. Mine one local block first. The V3 fee-stack proof
  now passes against real 30 bps Topaz on a mainnet fork. The older lifecycle
  fork proof needs an external anvil (`--network bscMainnetFork`) and a fast
  archive RPC; on a public endpoint it exceeds 40 minutes and it certifies the
  *old* production factory, not this generation.
- **Creator gating now applies on all three chains.** One wallet, one launch per
  24h, three live campaigns on the default tier. Canary runs that need several
  launches need several wallets. `CreatorGatingChainParity` pins the EVM tiers
  to Solana's `TIER_COOLDOWN_SECONDS 86_400` and 3/5/10.

### Robinhood: accepted (2026-09-23)

The locker's timelocked authorization was accepted after `upgradeDelay`
(`acceptAuthorizedLpLocker` `0x11a68b95…`, `setPrimaryLpLocker` `0x3de8a69a…`),
and `scripts/test-robinhood-testnet-lifecycle.ts` ran against the new
generation with `deployments/robinhood/testnet.staged.new-generation.json`:
**`accepted: true`.** Create, scheduled create, pre-launch rejection,
post-launch scheduled trade, pre-grad buy/sell, creator claim, $6 graduation,
permanent V3 lock (position 3, pool `0x3dC5648d…`), native post-grad buy/sell,
80/20 harvest (creator 240000000000 / protocol 60000000000 — the proof the
locker authorization took), create paused after, indexer continuity.

Two things only running it showed:

- **The harness itself had drifted.** `RobinhoodV3NativeSwapAdapter` gained a
  `deadline` argument in the audit and the harness kept the old shape; the
  first run died *after* graduation with the chain in perfect health. A
  harness the freeze forbids from running cannot drift visibly.
- **Creator cooldown is real now.** A re-run with the same creator wallets
  would have been refused (`CreatorCooldown`, 24h), so the second run used two
  throwaway creators funded 0.01 each from the testnet deployer. Plan wallets
  for any canary that launches more than once a day.

The acceptance freeze is re-issued for the new generation:
`deployments/robinhood/testnet.accepted.json` pins factory `0xde9f7055…`, tree
`8832ad77…`, start block 123211064 (`ACCEPTED_5B_SHA` /
`ACCEPTED_FACTORY_START_BLOCK` in `scripts/robinhoodTestnetFreeze.mjs`). The
superseded `0xF170a2C9` record stays archived beside it. The freeze again
forbids lifecycle runs on 46630 — that is the point; the next generation cut
moves the pin the same way.

### Mainnet inputs, verified on chain (2026-09-23)

**Deployer `0x77F96A7d…` funded:** 0.1716 BNB on 56, 0.1030 ETH on 4663.
Measured gas (real bytecode): BNB 28.39M units deployer-paid, Robinhood
31.56M. Both chains report ~0.05 gwei; hardhat pins no gasPrice, so deploys
pay what the node reports. The Safe `0x1edcEdf5…` has code on both chains.

**BNB mainnet** — every reused input checked: Topaz adapter `0x5c3135Df…`
(`poolFactory()`) and Topaz router `0x1E98c822…` (`defaultFactory()`/`weth()`)
agree on pool factory `0x65E6cD0e…` and WBNB; volatile fee **30 bps**;
`GraduationOracle 0x9D204406…` reads Chainlink BNB/USD `0x0567F232…` (8 dec,
updates every ~33 s, so its 3600 s max age is fine); `CreatorRegistry
0x8194FB37…` and `RiskRegistry 0x92b1494C…` are Safe-owned; the four existing
vaults (weekly `0xC9286EE3…`, monthly `0xF62A09de…`, recruiter `0x40ac5cD7…`,
protocol `0xc2d4E6f8…`) all accept plain value (`receive()`), so a new
`TreasuryRouterV3` can pay them — strict routing would otherwise revert every
trade. Route authority is `0xb989A998…` (production `ROUTE_AUTHORITY_PRIVATE_KEY`
derives to it; matches the profile pin).

**Robinhood mainnet** — nothing of ours exists (`contracts: {}`). The canonical
Uniswap addresses (`0x1F98431c…` etc.) hold a 2109-byte placeholder that
answers every call with empty data — **not V3**. The real deployment, from
developers.uniswap.org and verified on chain (NPM and router both report the
factory and the same WETH9; fee tier 3000 → spacing 60):

| | |
|---|---|
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Chainlink ETH/USD proxy | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` (8 dec, aggregator `0x6091E64e…`) |

**The ETH/USD feed has an 86,400 s heartbeat** and was 121 minutes old when
read. `GraduationOracle.maxPriceAge` and the stock adapter's
`maxOracleAgeSeconds` are both **immutable**, and both were 3600 — on this
feed every price read would revert stale for most of the day. The Robinhood
scripts now default to 90,000 s on 4663 (`RH_MAX_ORACLE_AGE_SECONDS` to
override) and refuse a value the live feed already exceeds, before anything
immutable is written.

**Prerequisites are their own step:** `scripts/deploy-robinhood-prerequisites.ts`
deploys the oracle, weekly `TreasuryVaultV2`, `CharityTreasury`,
`MonthlyLeagueTreasury` (cap **30000**, mirroring BNB mainnet; rootPoster and
weekly operator left zero for the Safe, also mirroring BNB), recruiter and
protocol vaults, and `RobinhoodUniswapV3GraduationAdapter`, then prints the
exact env for the router and generation steps. Rehearsed in
`RobinhoodPrerequisitesDeploy.spec.ts`.

**Arena signers:** the API reads `ARENA_WAR_POOL_RESOLVER_KEY` and
`ARENA_BOOST_QUOTE_SIGNER_PRIVATE_KEY` (+ `_ADDRESS`); **neither is set in any
env**. Both roles have `onlyOwner` setters on the war pool, so they do not block
the deploy — deploy with a placeholder and let the Safe `setResolver` /
`setBoostQuoteSigner` once the key exists. `protocolReceiver` has no setter and
defaults to the Safe.

**Robinhood's config default graduation target was 10** — allowed on no chain.
Fixed per chain (30,000 mainnet / 6 testnet), checked against the factory's
own view before it is set. The accepted testnet factory still carries 10; the
app passes a per-campaign target so it is not on the app path.

### BNB mainnet — DEPLOYED (2026-09-23)

Every step ran from the founder's terminal (the auto-mode classifier refuses
mainnet sends from the agent, correctly); every state below was read back from
chain independently of the script that wrote it. 21 deployer transactions,
0.00144 BNB. All closed: `createPaused` true, `live` false, war pool deposits
paused. **Everything is owned by the Safe** `0x1edcEdf5…`; the deployer keeps
only the quote adapter's `admin` (immutable, no transfer), which is what
configures quote routes.

| | |
|---|---|
| TreasuryRouterV3 | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` (admin Safe) |
| CommunityRewardsVault | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e` |
| CreatorRewardsVault | `0x72A963682B261195EB43F8f75e0515ab279EbD14` |
| BnbBasicLaunchFactory | `0x632061cA786f7B585Bbd46A792FDA92B02f70671` |
| PermanentLpLocker | `0xdd41E0d13c637657A28b60F860205048221F325A` |
| LaunchCampaign impl | `0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238` |
| BnbQuoteLaunchCampaign impl | `0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7` |
| BnbQuoteGraduationAdapter | `0xfdF80819CCaE7103165c2EAd9057BA7Eb2fa8aee` (admin deployer) |
| PostGradLeagueTreasuryV2 | `0xD9E381408A4e361C66D8b1e657583bdE6c52402d` |
| ArenaWarPoolTreasuryV2 | `0xe69a6a41363a48179beaB9b1E6122885bbFe8C65` |

Reused: Topaz adapter `0x5c3135Df…`, Topaz router `0x1E98c822…`, oracle
`0x9D204406…`, BNB/USD feed `0x0567F232…`, CreatorRegistry `0x8194FB37…`,
RiskRegistry `0x92b1494C…`, the four existing vaults, route authority
`0xb989A998…`. Arena resolver `0x2b72A9E6…`, boost signer `0xFCA7DF58…` (both
EOAs, **unfunded** — the resolver pays gas for `resolve`).

Safe batches (in `deployments/bnb/`, generated from the ABI by
`scripts/make-safe-batch.ts`): B2 vault setters, safeTx `0x12f50c4e…`,
executed `0xf16be625…`; B4 launch recorder + locker authorization + primary,
safeTx `0x443fa345…`. **Several of these addresses coincide with Robinhood
testnet addresses** (`0x632061cA…` was RH testnet WETH, `0xfdF80819…` its V3
factory, `0xe69a6a41…` its graduation router) — same deployer, same nonces.
Always read the chain, never match an address by eye.

`anyLpLockerAuthorized` is now true on this router: the next locker on it
(any future generation) needs propose → 3600 s → accept.

### Robinhood mainnet — DEPLOYED, WIRED, SAFE-OWNED, CLOSED (2026-09-24)

Same discipline as BNB: founder's terminal, every state read back from chain.
34 deployer transactions, ~0.0009 ETH. All closed. Everything Ownable is the
Safe's (R4 verified: factory, league, war pool, both registries); the deployer
keeps the stock adapter's immutable `admin`. R3b executed (batch
`deployments/robinhood/mainnet.R3b-locker-authorization.safe-batch.json`):
the V3 locker is authorized and primary on the router, read back from chain.
`anyLpLockerAuthorized` is now true here too — the next locker on this router
needs propose → 3600 s → accept.

| | |
|---|---|
| GraduationOracle (maxPriceAge 90000) | `0xe635AA43fE5707561c8c3C655225da5C3e4C2239` |
| TreasuryVaultV2 (weekly) | `0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e` |
| CharityTreasury | `0x72A963682B261195EB43F8f75e0515ab279EbD14` |
| MonthlyLeagueTreasury (cap 30000) | `0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238` |
| RecruiterRewardsVault | `0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7` |
| ProtocolRevenueVault | `0x632061cA786f7B585Bbd46A792FDA92B02f70671` |
| RobinhoodUniswapV3GraduationAdapter | `0xfdF80819CCaE7103165c2EAd9057BA7Eb2fa8aee` |
| TreasuryRouterV3 (admin Safe) | `0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb` |
| CommunityRewardsVault | `0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a` |
| CreatorRewardsVault | `0xD9E381408A4e361C66D8b1e657583bdE6c52402d` |
| LaunchFactory | `0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA` (start block 70863388) |
| LaunchCampaign impl | `0x107231eBDe5DF14Ec0ec419b677d4ac0016DD70d` |
| PermanentV3PositionLocker | `0xe2B3449491E4d5BE73E7E73A4DF9498eD9f3064C` |
| RobinhoodStockTokenGraduationAdapter (maxOracleAge 90000) | `0xa48723e35061380Feb6D269f7c26D6E426F83efc` |
| RobinhoodV3NativeSwapAdapter | `0xffF3aFBC7853d4B20F523d69c146169Ef4C3c1DF` |
| PostGradLeagueTreasuryV2 | `0x5D5CC19B5BE86BA28b8164f85883F17843B69810` |
| ArenaWarPoolTreasuryV2 (runtime `0xa902d91e…`) | `0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C` |
| CreatorRegistry / RiskRegistry | `0xDc77CAACDEB6affA0a5791f62BBB958D99Edc58B` / `0xe10e9c26D7CA80390831884CA17919E22fF44938` |
| UPVoteTreasury (2026-09-24; owner Safe, receiver = ProtocolRevenueVault) | `0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa` (start block 71340669) |

Reused: Uniswap V3 factory `0x1f7d7550…`, position manager `0x73991a25…`,
SwapRouter02 `0xCaf681a6…`, WETH9 `0x0Bd7D308…`, Chainlink ETH/USD
`0x78F3556b…`. Route authority `0xb989A998…` (production). **The first seven
addresses collide with BNB mainnet's** (same deployer, nonces 0–6): the
oracle here is the router there. Chain-pair every address.

### Still to do

- ~~Two code gaps found 2026-09-24 that defeated the release silently~~ **fixed
  2026-09-24, not yet on the live branch** (details and the corrected per-service
  env in `docs/build_plans/go-live-runbook.md` §C2/§D): (1) the create-authorization
  gate expected campaign generation 2 on 56 and 4/2 on 4663 while both new mainnet
  factories report **4/3** on chain (old BNB 3/2) — the rule is now a per-chain
  list of allowed factory/campaign *pairs* (`isSupportedGenerationPair`; BNB
  3/2, 4/2, 4/3; Robinhood 4/3), so legacy scheduled factories keep working;
  (2) the indexer's `CHAINS`/`factoryDiscovery` gained 4663 mirroring 46630;
  (3) launchpad UP-vote ingest accepts 4663 (`votes-ingest.js`,
  `arenaVoteTreasury.js`) for the Robinhood `UPVoteTreasury` still to deploy;
  (4) the `resolve-due` worker accepts an inline keypair JSON. Also:
  `memewar.zone` is a Netlify landing page; the app is `app.memewar.zone` on
  Coolify, so `VITE_*` live on the **app service**.
- **UP votes → capped protocol wallet (founder decision 2026-09-24).** On BNB the
  `UPVoteTreasury` `0xF6AA6eD3…` forwards to the Safe, not the vault: one Safe tx
  `setFeeReceiver(0xc2d4E6f8…)`. Robinhood gets its own `UPVoteTreasury(owner =
  Safe, feeReceiver = 0x632061cA…)`. **Both `ProtocolRevenueVault`s have the $10k
  cap but no operator and no overflow set** — `setOperatorFill` from the Safe on
  both chains is required before the doors open (operator address: founder).
- **Robinhood mainnet battles are no longer gated in code.** `arenaWarPoolEscrow.js`
  used to refuse 4663 outright; it now takes `ARENA_WAR_POOL_TREASURY_V2_ADDRESS_4663`
  like every other chain, V2-only, runtime hash enforced. The staging authority map
  (`arenaTournamentBuyInV2.mjs`) points at today's testnet war pools, and
  `frontend/.env.example` names the V2 and signer variables. Arena test set 515, 0 failing.
- **Go-live runbook** with every env name and address, the merge order and the
  dashboard switch: `docs/build_plans/go-live-runbook.md` (gitignored dir, on
  disk — `git add -f` if it should travel).
- **Robinhood mainnet**: R1 prerequisites → R2 router (+4 Safe setters) →
  R3 generation (+2 Safe locker calls) → R4 handover. Runbook in
  `docs/build_plans/mainnet-deploy-runbook.md` (gitignored dir, on disk).
- Configure a quote route per approved quote token on each adapter (BNB
  `BnbQuoteGraduationAdapter`, Robinhood stock adapter).
- Then mainnet, as one release with the two Solana upgrades — BNB step 1 is
  `deploy-evm-treasury-router-v3.ts` with the real league vaults supplied and
  the Safe as admin, then `deploy-bnb-quote-generation.ts`; both print the Safe
  transactions they cannot send (vault wiring, launch recorder, locker
  authorization). Robinhood mainnet the same way with its own script.


