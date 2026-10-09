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
