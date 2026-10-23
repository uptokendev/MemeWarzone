# Payout watchdog: founder steps

What it is: a small robot key that may do two things in the Safe's name and nothing else. Every week it approves the
holder payout batch of each creator vault, but only after it has rebuilt that batch itself from the chain and found it
identical. And it keeps the weekly payout ids of the holder and airdrop distributors authorized 12 weeks ahead. It cannot
move Safe money, change anything else, or stop you: the Safe signers keep full control, can still veto any holder batch for
24 hours, and can switch the robot off with one Safe transaction. Why and how it is bounded:
`docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md`.

Do it chain by chain: BNB (56) first, then Robinhood (4663). Every step below is a separate go. All commands are for the WSL
terminal, from the repository folder.

## 1. Make the watchdog wallet (one per chain)

A NEW key that has never been used for anything else. Not the operator key, not the airdrop key, not the deployer, not a Safe
owner key: the script and the indexer refuse those.

```bash
cast wallet new
```

Write down the address and keep the private key in the password manager as "MWZ payout watchdog BNB" (and a second one for
Robinhood).

## 2. Give it gas

Send it a little native token from any wallet: 0.01 BNB on BNB, 0.003 ETH on Robinhood. It sends about 3 to 6 small
transactions a week (about 100,000 gas each), so this lasts a long time. The Finance page warns when its transactions fail.

## 3. Optional: check the module code and rehearse on a fork

```bash
npx hardhat run scripts/verify-zodiac-roles-mastercopy.ts
npx hardhat test test/PayoutRolesModule.fork.spec.ts --network bscForkRehearsal
npx hardhat test test/PayoutRolesModule.fork.spec.ts --network robinhoodForkRehearsal
```

The first proves the Zodiac Roles code on both chains is the published, audited one. The fork tests run the whole thing
against the real Safe on a local copy of the chain; nothing is sent anywhere.

## 4. Create the module and the Safe batch

BNB:

```bash
PAYOUT_WATCHDOG_ADDRESS_56=0x<watchdog address from step 1> CONFIRM_PAYOUT_ROLES=I_UNDERSTAND_MAINNET \
  npx hardhat run scripts/deploy-payout-roles-module.ts --network bscMainnet
```

Robinhood:

```bash
PAYOUT_WATCHDOG_ADDRESS_4663=0x<watchdog address> CONFIRM_PAYOUT_ROLES=I_UNDERSTAND_MAINNET \
  npx hardhat run scripts/deploy-payout-roles-module.ts --network robinhoodMainnet
```

This uses the deployer key you use for every deploy, only to pay for creating the module (the module belongs to the Safe from
its first instruction). If you would rather not use the deployer key, add `PAYOUT_ROLES_DEPLOY_IN_BATCH=1`: then the Safe batch
creates the module itself.

It writes two files per chain:

- `deployments/bnb/mainnet.payout-roles.safe-batch.json` (Robinhood: `deployments/robinhood/...`): the Safe batch;
- `deployments/bnb/mainnet.payout-roles.json`: the record, including `permissionTable` (what the robot may do, per contract)
  and `allowances` (how much it may authorize per week).

The module address is the same on both chains: `0xEeeE0082257bc4A3189e38f0a2881f129E101c70`.

## 5. Sign the Safe batch

In the Safe app, Transaction Builder, drag in the `.safe-batch.json`. Check:

- the calls go to the module address above, except the `authorizeBatch` calls (to the distributors, the Safe's own 12-week
  runway) and the very last call, `enableModule`, to the Safe itself;
- `assignRoles` names the watchdog address from step 1;
- the caps in the batch description match the record (BNB: 32 BNB holders, 5 BNB airdrop; Robinhood: 9.3 ETH, 1.5 ETH).

Two owners sign, one executes. From this moment the robot may act, but nothing runs yet.

## 6. Database (once, in the Supabase SQL editor, production project)

Run the contents of `db/migrations/20261008_000050_payout_watchdog_state.sql`. It only adds the heartbeat table the Finance
page reads.

## 7. Coolify: the indexer service

Add (BNB shown; the same with `_4663` for Robinhood):

```
PAYOUT_WATCHDOG_ENABLED_56=true
PAYOUT_WATCHDOG_ROLES_56=0xEeeE0082257bc4A3189e38f0a2881f129E101c70
PAYOUT_WATCHDOG_PK_56=<watchdog private key from step 1>
PAYOUT_WATCHDOG_AIRDROP_DISTRIBUTOR_56=<main airdrop distributor, printed by step 4>
PAYOUT_WATCHDOG_AIRDROP_CAP_WEI_56=<printed by step 4>
```

The vaults are the ones the operator already uses (`EVM_CREATOR_VAULT_V2_56`, and `EVM_GEN7_CREATOR_VAULT_56` once gen-7 is
live); they must carry their start block (`0xaddr@block`). Leave `PAYOUT_WATCHDOG_SEND` unset for one day: the robot then
checks everything and logs what it would do, but signs nothing. The Finance page shows "runs in dry run".

On the API service add `PAYOUT_WATCHDOG_EXPECTED_56=true`, so the Finance page shouts if the robot never reports.

## 8. Switch it on

When the dry-run day looked right (Finance page: no watchdog alerts; indexer log lines `[payout-watchdog] tick` with
`dry-run` decisions), set `PAYOUT_WATCHDOG_SEND=true` on the indexer and redeploy it.

From then on, every Monday: the operator proposes, the robot approves within a minute or two, the operator pays out 24 hours
later. You only hear about it when something is off:

- "holder batch ... does NOT match the chain; not approved": the robot refused. Verify it yourself with
  `scripts/evm-holder-batch-verify.mjs` (command in the alert) and either veto or sign batch H by hand as before.
- "the payout watchdog ... is down": no heartbeat for 15 minutes. Until it is back, the weekly Safe steps are yours again.
- "allowance used up" / "refused by the module": the robot could not extend a runway; renew by hand with the existing
  `make-*-calls.mjs` scripts, or look at what changed.

## 9. When gen-7 is deployed

Run step 4 again on that chain (the gen-7 record is picked up automatically) and sign the new batch: it adds the gen-7 vault
and distributors to the same module. Note: it also resets each allowance to its starting amount. Then add
`PAYOUT_WATCHDOG_GEN7_AIRDROP_DISTRIBUTOR_<id>` and `PAYOUT_WATCHDOG_GEN7_AIRDROP_CAP_WEI_<id>` (printed) on the indexer.

## The off switch

```bash
PAYOUT_ROLES_MODE=disable npx hardhat run scripts/deploy-payout-roles-module.ts --network bscMainnet
```

writes `deployments/bnb/mainnet.payout-roles.disable.safe-batch.json`: one call, `disableModule`. Sign and execute it and the
robot can do nothing at all (its key loses every power at once). Remove `PAYOUT_WATCHDOG_SEND` on the indexer afterwards so it
stops trying. To turn it back on, run step 4 again and sign.

## Gen-8 (2026-10-22): the robot approves the weekly gen-8 holder batch

Gen-8 has its own vault (`MwzCreatorChoiceVault` `0xaf11784a69964A576716a5e4b514341F4437CAd3`, same address on BNB and
Robinhood) and its own holder distributor (`0x3E0A03A723C691f20e4021A575bF7742D605335A`). Every Monday the operator proposes
last week's holder batch there. The robot rebuilds that batch itself from the chain with the same hold-through rule the
operator uses (4 secret checks in the week, lowest balance, at least 0.01% of the supply at every check) and approves it
only when every wallet, amount, the total, the claim deadline and the root are identical. It also keeps the gen-8 holder
distributor's weekly ids authorized 12 weeks ahead. It can do nothing else (permission table:
`docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md`, section "Gen-8").

The module below is for gen-8 only. Do it per chain, BNB (56) first, then Robinhood (4663). Each step is a separate go. All
commands are for the WSL terminal, from the repository folder.

### G1. Make the watchdog wallet (in your own terminal)

```bash
cast wallet new
```

A new key, used for nothing else. Keep it in the password manager as "MWZ payout watchdog BNB" (a second one for
Robinhood). Send it 0.01 BNB / 0.003 ETH for gas from any wallet.

### G2. Optional: rehearse on a local fork (sends nothing anywhere)

```bash
BSC_MAINNET_RPC=https://bsc-dataseed.bnbchain.org BSC_FORK_REHEARSAL_URL=http://127.0.0.1:8792 \
  npx hardhat test test/PayoutRolesModuleGen8.fork.spec.ts --network bscForkRehearsal
ROBINHOOD_FORK_REHEARSAL_URL=http://127.0.0.1:8793 \
  npx hardhat test test/PayoutRolesModuleGen8.fork.spec.ts --network robinhoodForkRehearsal
```

It deploys the module on a copy of the chain, has the real Safe owners execute the batch, and shows that the robot reaches
the gen-8 approval and the distributor authorization and is refused everywhere else.

### G3. Create the module and the Safe batch

BNB:

```bash
PAYOUT_WATCHDOG_ADDRESS_56=0x<watchdog address from G1> \
PAYOUT_ROLES_GEN6_VAULT_56=none PAYOUT_ROLES_GEN7_VAULT_56=none \
PAYOUT_ROLES_AIRDROP_DISTRIBUTOR_56=none PAYOUT_ROLES_GEN7_AIRDROP_DISTRIBUTOR_56=none \
PAYOUT_ROLES_GEN8_VAULT_56=0xaf11784a69964A576716a5e4b514341F4437CAd3 \
CONFIRM_PAYOUT_ROLES=I_UNDERSTAND_MAINNET \
  npx hardhat run scripts/deploy-payout-roles-module.ts --network bscMainnet
```

Robinhood: the same with `_4663` everywhere and `--network robinhoodMainnet`.

Any key may pay the gas of creating the module (the module belongs to the Safe from its first instruction). To use no key at
all, add `PAYOUT_ROLES_DEPLOY_IN_BATCH=1`: the Safe batch then creates the module itself.

The module address is `0xEeeE0082257bc4A3189e38f0a2881f129E101c70` on both chains. The script refuses a watchdog address that
is the operator, the deployer, the route authority, a Safe owner or the paying key.

### G4. Import and sign the Safe batch

Transaction Builder, drag in `deployments/bnb/mainnet.payout-roles.safe-batch.json` (Robinhood: `deployments/robinhood/...`).
Check, measured on the fork (19 calls):

- 1 to 6 go to the module `0xEeeE…0c70`: `scopeTarget` (the gen-8 vault), `scopeFunction` with selector `0xc62732bb`
  (approveHolderBatch with the claim deadline), `scopeTarget` (the gen-8 distributor `0x3E0A…335A`), `setAllowance`,
  `scopeFunction` with selector `0xa2885b55` (authorizeBatch), `assignRoles` naming the watchdog address from G1;
- 7 is `enableModule` on the Safe itself;
- 8 to 19 are the Safe's own `authorizeBatch` calls on `0x3E0A…335A` for the next 12 weeks, each at the cap;
- the cap in the description: 32 BNB on BNB, 9.3 ETH on Robinhood (the vault's `maxHolderBatchPerWeek`).

Two owners sign, one executes.

### G5. Coolify: a SEPARATE watchdog service (names only)

The watchdog key must never sit next to an operator key. The robot therefore runs as its own Coolify service: a copy of the
indexer service (same repository, branch and build from `realtime-indexer/`) that starts only the watchdog loop. In
Coolify: duplicate the indexer service, name it "payout-watchdog", and give it ONLY these variables (names; values from
the indexer service unless noted):

```
INDEXER_ROLE=payout-watchdog
DATABASE_URL                      (the watchdog writes its heartbeat and alerts and reads the leaf files)
ABLY_API_KEY                      (required by the shared env loader; the watchdog publishes nothing)
BSC_RPC_HTTP_56 / ROBINHOOD_RPC_HTTP_4663
EVM_BUYBACK_SEED_SECRET           (the same seed as the operator: the week's check moments come from it)
EVM_HOLDER_MIN_PAYOUT_WEI_56, EVM_HOLDER_CLAIM_WINDOW_DAYS, EVM_HOLDER_EXCLUDED_WALLETS_56
EVM_GEN8_LAUNCHER_56, EVM_GEN8_HOOK_56, EVM_GEN8_POOL_MANAGER_56 (if set), EVM_GEN8_RESERVE_LOCK_56, EVM_GEN8_ESCROW_56,
EVM_GEN8_SPLITTER_56
EVM_GEN8_CHOICE_VAULT_56=0xaf11784a69964A576716a5e4b514341F4437CAd3@<the vault's deploy block>
PAYOUT_WATCHDOG_ENABLED_56=true
PAYOUT_WATCHDOG_LANES_56=gen8
PAYOUT_WATCHDOG_ROLES_56=0xEeeE0082257bc4A3189e38f0a2881f129E101c70
PAYOUT_WATCHDOG_PK_56=<watchdog private key from G1>   (new, only here)
```

Do NOT copy `EVM_GEN8_OPERATOR_KEY*`, `EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY*` or any other key into this service: with
any operator key in its environment the robot sends nothing and raises a critical alert. On the indexer service nothing
changes; with an operator key there it no longer starts the robot (log line `[main] roles`). The robot also checks every
approval of a gen-8 batch: one not made by its own key through the module raises an alert (a Safe-signed one a warning).

`PAYOUT_WATCHDOG_LANES_56=gen8` keeps the robot away from the gen-6 / gen-7 vaults, which this module does not cover. The
block after `@` is the vault's deploy transaction block (the explorer's "Contract Creation"). Optional limits:
`PAYOUT_WATCHDOG_GEN8_CHECK_TOLERANCE_MIN` (30: a check block must be within 30 minutes after the check's secret moment),
`PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS` (2000), `PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS` (200: wallets the operator left out
that are on no current list; each is reported). The heartbeat table needs
`db/migrations/20261008_000050_payout_watchdog_state.sql` (Supabase SQL editor, once, if not done for gen-6/7).
Robinhood: the same with `_4663`. Leave `PAYOUT_WATCHDOG_SEND` unset and deploy the service.

### G6. Switch it on

After one dry-run Monday (watchdog service log `[payout-watchdog] tick` with `approve ... dry-run` and "matches the chain",
no watchdog alert on the Finance page), set `PAYOUT_WATCHDOG_SEND=true` on the watchdog service and redeploy it. From then on the robot approves
the gen-8 batch within a minute or two of the proposal; the operator executes it 24 hours later; the Safe can still veto in
those 24 hours.

### When the robot refuses a gen-8 batch

The alert "gen-8 holder batch ... does NOT match the chain; not approved" means it found a difference and approved nothing.
Check it yourself (reads only, sends nothing):

```bash
read -rs EVM_BUYBACK_SEED_SECRET && export EVM_BUYBACK_SEED_SECRET   # paste the operator's seed; it is not echoed or kept in history
node scripts/evm-gen8-holder-batch-verify.mjs --chain 56 --file <published leaf file URL or .json> \
  --vault-block <the vault's deploy block> --rpc <BNB RPC> --out /tmp/gen8-holders-56.json
```

It runs the robot's own check. "MATCH" writes the Safe batch to sign (the approval, plus `authorizeBatch` if the id is not
authorized yet). "REFUSED" prints the reason and no batch: veto the batch (`vetoHolderBatch`) or find the difference first.
If the operator excluded risk-flagged wallets, pass them with `--risk-excluded 0x..,0x..`.
