# Payout watchdog Safe module (Zodiac Roles v2.1.0): audit

Founder decision 2026-10-08: "Safe module: yes", in place of a gen-7 vault contract change (that WIP stays parked;
gen-7 keeps the unchanged `CreatorRewardsVaultV2`). No contract of ours changes. What is added is a configuration of an
existing, audited third-party module on the treasury Safe, a new key, and off-chain code that decides when that key acts.

The problem it solves: two Safe steps recur and get forgotten when busy.

- every week, per creator vault (gen-6, gen-7): `CreatorRewardsVaultV2.approveHolderBatch(batchId, root, total)`
  (`onlyAdmin`, admin = the Safe, immutable), without which `executeHolderBatch` reverts `NotApproved`;
- every ~12 weeks, per distributor (holder gen-6 / gen-7, airdrop main / gen-7): `RewardDistributor.authorizeBatch`
  (`onlyOwner` = the Safe) for the deterministic batch ids of the coming weeks.

## Components

| What | Where |
|---|---|
| Policy as code (conditions, allowances, the Safe batch, permission table) | `scripts/lib/payoutRolesPolicy.ts` |
| Deploy proxy + write the Safe batch + record; the off-switch batch | `scripts/deploy-payout-roles-module.ts` (`PAYOUT_ROLES_MODE=disable`) |
| Vendored, verified mastercopy data | `scripts/lib/zodiac/roles-v2.1.0.json`, `scripts/lib/zodiacRoles.ts` |
| Mastercopy verification | `scripts/verify-zodiac-roles-mastercopy.ts` |
| ABI surface for the Transaction Builder encoder (no logic) | `contracts/interfaces/zodiac/IZodiacRolesV2.sol` |
| Watchdog: rules, chain, config, loop | `realtime-indexer/src/evm/payoutWatchdog*.ts` (registered in `main.ts`) |
| Heartbeat table | `db/migrations/20261008_000050_payout_watchdog_state.sql` |
| Alerts that know about the watchdog | `frontend/api/lib/financeHolderBatchAlerts.js`, `frontend/scripts/weekly-airdrop/authorizationHorizon.mjs`, `frontend/api/lib/financePayouts.js` |
| Tests | `test/PayoutRolesPolicy.spec.ts` (local, real Roles bytecode), `test/PayoutRolesModule.fork.spec.ts` (56 and 4663 forks, real Safe), `realtime-indexer/src/evm/payoutWatchdog.test.ts`, the two frontend test files |
| Test-only Safe stand-in | `contracts/mocks/MockModuleAvatar.sol` |

## Trust model

| Party | Holds | Can |
|---|---|---|
| Safe owners (2 of 3: `0x1A367016…`, `0x913d2Bd9…`, `0xEE0B64C4…`) | the treasury Safe `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7` (1.4.1, singleton `0x29fcB43b…`, no modules before this) | everything they can today, plus: own the Roles module (scope, revoke, re-assign, allowances), disable it on the Safe in one transaction, veto any holder batch until it executes, revoke any distributor authorization |
| Watchdog key (NEW, one per chain, own address) | the `payout-watchdog` role on the Roles module | exactly the calls in the permission table below, in the Safe's name, value 0, call only |
| Creator-choice operator `0x20652bdb…` (unchanged) | `operator` on both creator vaults | propose / execute holder batches, buybacks, syncs (bounds in `docs/evm-launch/creator-choice-operator.md`) |
| Airdrop operator `0xdcf07EB0…` (unchanged) | `airdropOperator` on the community vaults | `fundAirdropBatch` into ids the Safe (or now the watchdog) authorized |
| Roles module (Gnosis Guild code, audited) | nothing of its own | forwards an allowed call to the Safe's `execTransactionFromModule`; refuses everything else |

The watchdog key is refused when it equals any other key the deployment knows: the deploy script refuses the creator-choice
operator, the airdrop operator, both import payout operators, the deployer, the testnet deployer, the route authority, the
Safe, every Safe owner, each vault's current `operator()`, each community vault's `airdropOperator()` and the signer of the
deploy run; the indexer refuses to start the watchdog on a chain when `PAYOUT_WATCHDOG_PK_<id>` equals any `*_PRIVATE_KEY` /
`*_PK` variable in its environment, the same static list, the Safe owners or the on-chain operators.

## Mastercopy verification (done 2026-10-08)

The Roles proxy delegates every call to the mastercopy `0x9646fDAD06d3e24444381f44362a3B0eB343D337` (24,401 bytes), which
links two libraries by address (`Integrity 0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049`, `Packer 0x61C5B1bE435391fDd7BC6703F3740C0d11728a8C`)
and stores condition trees through the ERC-2470 singleton factory `0xce0042B868300000d44A59004Da54A005ffdcf9f`. All of them
were verified; `scripts/verify-zodiac-roles-mastercopy.ts` repeats every step:

1. **Two independent publications agree.** GitHub `gnosisguild/zodiac-modifier-roles`, `packages/evm/mastercopies.json` at
   commit `1ddde84db9024c6c1898d1f4cf5dabded3e824f1` (sha256 `a80d737a…a224`), entry `Roles 2.1.0` (address, salt
   `0x00…00`, factory ERC-2470, creation bytecode, constructor args `(1,1,1)`, standard-JSON compiler input, solc
   `0.8.21+commit.d9974bed`); and npm `@gnosis.pm/zodiac@4.0.3` (`KnownContracts.ROLES_V2 "2.1.0"` = the same address,
   `initData/RolesV2.js` = the same init code and salt, byte for byte).
2. **CREATE2.** keccak of each init code through the ERC-2470 factory and its salt gives exactly the published address,
   for Roles, Integrity, Packer and the ModuleProxyFactory (`0x000000000000aDdB49795b0f9bA5BC298cDda236`, init code and salt
   from `@gnosis.pm/zodiac` `initData/ModuleProxyFactory.js`). A CREATE2 address commits to the init code.
3. **Runtime.** The init code executed on a local EVM yields runtime with keccak
   `0x87911cbc…07fa7ec` (Roles), `0xee8ec55e…10d495` (Integrity), `0xd22ba4e0…3f087d` (Packer), `0x01623cbc…c5f21e`
   (factory); libraries embed their own address after the leading PUSH20, which equals their canonical address on chain.
4. **On chain.** `eth_getCode` at all five addresses (plus the ERC-2470 factory, keccak `0xc4d5542b…ca807`) has exactly those
   hashes on **56, 4663, 97 and 46630** (and Ethereum mainnet for Roles).
5. **Source.** solc 0.8.21 (binary sha256 `f2857a89…a81df`, the one binaries.soliditylang.org lists) compiling the published
   sources reproduces the published creation bytecode **byte for byte, metadata hash included**, for all three, when
   compiled as it was built (libraries unlinked, then linked to their addresses; with `settings.libraries` in the input the
   executable code is identical and only the CBOR metadata hash differs, because the metadata records that setting).
6. **Audits** of these sources: G0 Group (Apr 2023), Omniscia (May 2023), Omniscia v2.1 (Nov 2023), G0 Group v2.1 (Nov 2023)
   (`packages/evm/docs/Audit01..04`; the README states all issues resolved as of `a19c0ebd`).

The deploy script calls `assertZodiacCode` first and refuses a chain whose code at any of these addresses differs.

## Permission table (exact)

One role, key `0x7061796f75742d7761746368646f670000000000000000000000000000000000` (`encodeBytes32String("payout-watchdog")`).
Each listed target has function-level clearance (`scopeTarget`): only the scoped selector passes, every other selector is
`FunctionNotAllowed`, every unlisted address is `TargetAddressNotAllowed`. Every scoped function has
`ExecutionOptions.None`: any `value > 0` is `SendNotAllowed`, any delegatecall `DelegateCallNotAllowed`.

| Chain | Target | Function | Roles condition (on chain) |
|---|---|---|---|
| 56 | gen-6 CreatorRewardsVaultV2 `0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66` | `approveHolderBatch(bytes32,bytes32,uint256)` (`0x55c6e279`) | `total <= 32 BNB` (vault `limits().holderBatchPerWeek`) |
| 56 | gen-6 holder RewardDistributor `0xD106198Ca83c26f4B43c9DF7368F134f0Cd46cc1` | `authorizeBatch(bytes32,uint256,uint64,uint64)` (`0xa2885b55`) | `maxAmount <= 32 BNB` AND `maxAmount` within allowance: refill 32 BNB / week, max 64, start 64 |
| 56 | main airdrop RewardDistributor `0xF170a2C97953754c2C1105E2AcC522Bc8e764D75` | `authorizeBatch` | `maxAmount <= 5 BNB` AND allowance: refill 10 BNB / week (2 ids), max 20, start 20 |
| 56 | gen-7 vault / holder / airdrop distributors | as above | same caps as gen-6 (the gen-7 deploy copies them); added by re-running the script once gen-7 exists |
| 4663 | gen-6 CreatorRewardsVaultV2 `0xEDCC2667365F116b9971Cc02f198470BE23a5651` | `approveHolderBatch` | `total <= 9.3 ETH` |
| 4663 | gen-6 holder RewardDistributor `0x0Bf17e4bF2Ef1f4737d1e8cF95170D814e36A023` | `authorizeBatch` | `maxAmount <= 9.3 ETH`; allowance refill 9.3 / week, max 18.6, start 18.6 |
| 4663 | main airdrop RewardDistributor `0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D` | `authorizeBatch` | `maxAmount <= 1.5 ETH`; allowance refill 3 / week, max 6, start 6 |
| 4663 | gen-7 vault / holder / airdrop distributors | as above | same caps as gen-6 |

The caps are read from the chain at deploy time (holder: each vault's `limits().holderBatchPerWeek`; airdrop: the main pot's
current authorization max, the value of `scripts/lib/gen7AirdropPot.ts mainAirdropCap`), recorded in
`deployments/<chain>/mainnet.payout-roles.json` together with the full table, and printed in the batch description. The
allowance numbers above are the defaults (`PAYOUT_ROLES_ALLOWANCE_MAX_WEEKS=2`, `..._INITIAL_WEEKS=2`, period one week).
Selectors `0x55c6e279` / `0xa2885b55` (checked against the signatures in `test/PayoutRolesPolicy.spec.ts`). Allowance keys:
`keccak("mwz-payout-watchdog:authorizeBatch:<chainId>:<distributor lowercase>")`, one per distributor.

The Safe batch (one Safe transaction): `scopeTarget` + `scopeFunction` per vault; `scopeTarget` + `setAllowance` +
`scopeFunction` per distributor; `assignRoles(watchdog, [role], [true])`; the Safe's own `authorizeBatch` calls that fill
each distributor's runway to 12 weeks (only ids not yet authorized, consumed, created or revoked); `Safe.enableModule(roles)`
last. Measured on both forks: 70 calls (with gen-7, 52 of them runway), 4.32 M gas. Without gen-7 (mainnet today) about
26 calls.

The Roles proxy: `ModuleProxyFactory.deployModule(mastercopy, setUp(abi.encode(Safe, Safe, Safe)), keccak("mwz-payout-watchdog-roles-v1"))`.
Owner, avatar and target are the Safe from the proxy's first instruction (the initializer runs in the deploy transaction).
The address is CREATE2 of the initializer, so it is the same on 56 and 4663: **`0xEeeE0082257bc4A3189e38f0a2881f129E101c70`**
(measured on both forks). Anyone may deploy it first; the result is the same contract with the Safe as owner, and the script
reuses it after checking its code and owner/avatar/target. Deploying costs the deployer gas only; it holds no role.

## What Roles enforces on chain, what only the watchdog enforces

| Rule | Enforced by |
|---|---|
| Only the listed targets; only `approveHolderBatch` on vaults and `authorizeBatch` on distributors | Roles (scopeTarget / scopeFunction) |
| No value, no delegatecall | Roles (ExecutionOptions.None) |
| `total <= weekly holder cap` on approval | Roles (LessThan) |
| `maxAmount <= per-id cap` on authorization | Roles (LessThan) |
| At most `maxWeeks` weeks of authorizations available at any time, one week added per week | Roles (WithinAllowance, own key per distributor) |
| Approval only of a batch the operator proposed, with that exact root and total, not vetoed or executed | the vault (`approveHolderBatch` reverts `BadBatch`) |
| The 24 h veto window and the Safe's veto after an approval | the vault (`executeHolderBatch` waits for `executableAt`; `vetoHolderBatch` until executed) |
| A consumed or created id cannot be authorized again | the distributor (`BatchAuthConsumed` / `BatchExists`) |
| The proposed root is the right one: same census (Transfer logs), exclusions, allocation, minimum payout, merkle tree | **watchdog only** (`verifyHolderProposal`) |
| Batch id follows `keccak("mwz-weekly-airdrop:<chain>:<week>:<program>[:pot]")` for the right week | **watchdog only** (Roles cannot hash a week string) |
| `publishAfter` = the week's end, `publishDeadline` = `publishAfter + 6 days` | **watchdog only** (Roles cannot compare two parameters) |
| Never re-authorize an authorized (live) id, nor one the Safe revoked | **watchdog only** (`authorizeBatch` overwrites an unconsumed authorization) |
| Snapshot block after the week's secret moment, exclusions at most 20% of a coin's eligible supply | **watchdog only** |

What the watchdog checks before approving (`realtime-indexer/src/evm/payoutWatchdog.ts verifyHolderProposal`), all from chain
data, the operator's published leaf file used only as hints (which snapshot block, the pot before the minimum-payout rule):
the proposing transaction went to the vault and is `proposeHolderBatch` with the event's id, root and deadline; the
calldata amounts add up to the event's total; the id is last week's for this vault's program; the claim deadline is the
configured window after `executableAt`; the leaf file is internally consistent and names this vault, week, chain, holder
distributor and program, and its campaigns are the calldata's, in order; per coin: choice holders or split in the vault, the
token is the campaign's `token()`, the snapshot block is inside the week and (with the seed) within 12 h after the secret
moment; the token's Transfer logs from the coin's `CampaignChoiceSet` block give the balances at that block (or one of the
next `PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS`, because the operator's DB census may already be a few blocks further), minus DEAD,
zero, the campaign, the vault, the creator (vault cfg), the token, the pool, the vault operator, contracts (EIP-7702
delegations count as wallets), configured and risk-excluded wallets, giving exactly the snapshot's holder count; the
allocation (`allocateToHolders`, the operator's own function) reproduces every leaf's part for that coin; across coins the
minimum payout (`holderLeaves`), the per-campaign amounts (equal to the calldata), the total and the merkle root (equal to
the event's) are rebuilt. Any difference: not approved, critical alert, the Safe signers decide by hand. Missing data (no leaf
file yet, an RPC failure): retried every tick, warning after 2 h.

## Worst cases (numbers from the current caps)

**Watchdog key leaks, alone.** It cannot move money: approval only binds a root the operator proposed (and the honest operator
only proposes the batch it published); an authorization alone moves nothing (only the vault, for an approved root, or the
airdrop operator can call `createBatch`). It can grief, bounded by the allowance: authorize junk ids (no effect), or
overwrite the window or max of an upcoming legitimate id (re-authorizing a live id: e.g. `maxAmount = 1 wei`), making that
week's draw or holder execution revert until the Safe re-authorizes it; at most the allowance's worth of ids per week
(2 weeks of ids: 2 holder ids or 4 airdrop ids per distributor at a time, then 1 / 2 per week). It can re-authorize an id the
Safe revoked (same bound). It cannot veto, change operators, caps, owners, modules, or touch Safe funds. Detection: the
finance runway alerts and the watchdog's own alerts; fix: disable the module or `assignRoles(watchdog, [role], [false])`.

**Watchdog key + creator-choice operator key.** The operator proposes a root that pays itself; the watchdog key approves it;
after the 24 h veto window the operator executes. Bound per vault per week: the vault's weekly holder cap
(`maxHolderBatchPerWeek`) and the coins' actual `holderBalance` (`proposeHolderBatch` debits real balances), and the
distributor authorization the batch id needs (the leaked watchdog can authorize any id within its allowance). So at most
**32 BNB per vault per week on BNB (64 BNB with gen-6 + gen-7), 9.3 ETH per vault per week on Robinhood (18.6 ETH)**, and never
more than what holders are actually owed in the vault (today nothing: the gen-6 vaults hold 0.000022 BNB and 0.0000012 ETH
in total, the creator balance of the one keep coin on each chain). The 24 h veto
window stays: the operator worker raises "the proposal on chain does not match the published leaf file" and the Finance page
shows a proposal the watchdog did not approve; the Safe vetoes.

**Watchdog key + airdrop operator key.** The watchdog authorizes ids with `publishAfter = now` within its allowance and the
airdrop operator funds them with a root of its own from the community vault. Bound per airdrop distributor: the allowance
balance, at most **20 BNB on BNB (2 weeks x 2 ids x 5 BNB) and 6 ETH on Robinhood (2 x 2 x 1.5)**, then 10 BNB / 3 ETH per week,
and never more than the community vault's tracked airdrop balance. For comparison, the airdrop operator alone can already fund
the currently open ids (this week's 2 ids: 10 BNB / 3 ETH per pot); the watchdog key adds at most the allowance.

**All three keys.** The sum of the two lines above per chain, per week, until the Safe acts. No path reaches Safe-held funds,
protocol vaults, league vaults, LP lockers, factories or any other contract.

## How to switch it off

Any of these, from the Safe (one transaction each, 2 of 3 owners):

1. `PAYOUT_ROLES_MODE=disable npx hardhat run scripts/deploy-payout-roles-module.ts --network <bscMainnet|robinhoodMainnet>`
   writes `deployments/<chain>/mainnet.payout-roles.disable.safe-batch.json` = `Safe.disableModule(prevModule, roles)` with
   `prevModule` read from the Safe's current module list. After it the module can do nothing (Safe `GS104`; proven on both forks).
2. `Roles.assignRoles(watchdog, [role], [false])`: the key loses the role; the module stays for a new key.
3. `Roles.revokeTarget(role, target)` for one target, or `setAllowance(key, 0, …)` to stop authorizations on one distributor.

The watchdog notices within one tick (critical "module not enabled" / "does not hold the role" alerts) and sends nothing.
Turning it back on: re-run the script (it reuses the proxy) and sign the batch.

## Audit notes in the house format (money paths)

- No new contract and no change to a deployed one. `IZodiacRolesV2.sol` is an interface (no bytecode);
  `MockModuleAvatar.sol` is test-only.
- Reentrancy / ordering: the watchdog's only transactions are `execTransactionWithRole` into the vault's `approveHolderBatch`
  (state flag only, no external call) and the distributor's `authorizeBatch` (state only). Roles flushes allowance consumption
  before the call and restores it if the call fails (`_flushPrepare` / `_flushCommit`); `shouldRevert = true` makes a failed
  inner call revert the whole transaction, so no allowance is consumed for a refused call.
- States: `approveHolderBatch` succeeds only on status 1 with the exact root and total; `authorizeBatch` only on an id neither
  consumed nor created. The Safe's veto and revoke stay available in every state.
- Overflow: caps are compared as `value < cap + 1` with `cap < 2^255` (builder refuses otherwise); allowances are `uint128`
  (builder refuses larger) and Roles accrues with a clamp to `maxRefill`.
- Griefing: covered above (re-authorizing live ids within the allowance). A third party can deploy the Roles proxy first with
  the same initializer; the result is identical and Safe-owned, the script reuses it. Roles 2.1 also accepts a member's
  signed module transaction relayed by anyone (`moduleTxHash` + signature); the watchdog never signs such messages, so there is
  nothing to replay.

## Residual risks

- Third-party code: Roles 2.1.0, its libraries and the ModuleProxyFactory (verified, audited; the newer `main` branch of the
  repository has not been released as a mastercopy and is not used).
- The watchdog trusts the risk table (`wallet_risk_profiles` / `wallet_clusters`) and `EVM_HOLDER_EXCLUDED_WALLETS` for
  exclusions, as the operator does. A database writer could shift a coin's payout to fewer wallets; the watchdog refuses
  when exclusions remove more than `PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS` (20%) of a coin's eligible supply.
- A risk flag that changes between the snapshot and the check makes the watchdog refuse (critical alert); the Safe signers then
  approve by hand. Safe failure, not a loss.
- The watchdog key sits in the indexer environment next to the operator key. The key-equality refusal prevents one key holding
  both roles, not one host leak exposing both; the worst cases above assume exactly that and are bounded on chain.
- Re-running the deploy script re-sets every allowance to its start balance (`setAllowance` overwrites).
- Testnets: the Zodiac contracts exist on 97 and 46630, but no Safe administers the testnet stacks (their admin is the testnet
  deployer EOA), so the module only applies there once a testnet Safe does (`PAYOUT_ROLES_SAFE_<id>`).

## Proven (2026-10-08)

- `test/PayoutRolesPolicy.spec.ts` (9): pure policy (shapes, encodings, allowance math, refusals, off switch, CREATE2) and the
  deploy script + every negative against the real Roles bytecode on a local chain.
- `test/PayoutRolesModule.fork.spec.ts` on **56** and on **4663** (1 end-to-end test each, real Safe, owners via approveHash +
  MultiSendCallOnly): S0, a real holders coin on the live gen-6 factory, the deploy script, the owners' batch, the real
  operator pass proposing both weekly batches, watchdog dry run (no transaction) then live (2 approvals + 12 authorizations,
  every distributor 13 weeks covered), execution after the veto window, every holder claims; all negatives; the owners'
  disable batch; afterwards `GS104` and a critical module alert.
- `realtime-indexer` `test:payout-watchdog` (14): schedules equal the existing generators', plan, verification
  (match, census lag, 10 tamperings, exclusion bound, missing file), the tick (send, dry run, mismatch + one alert, module /
  role / refusal / allowance alerts, missing data), key refusal, config.
