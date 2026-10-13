# Gen-8 mainnet runbook

Paused deploy on BNB chain 56 and Robinhood chain 4663. Nothing in this file is a signature, and nothing here is a permission to send. The founder runs the send from their own terminal after they say go. Gen-7 stays open until the opening-day batch, and that batch stays unsigned until the founder says go.

Worktree: `/home/patrick/mwz-wt/evm-gen8` on branch `prep/evm-gen8-mainnet`.
Safe (both chains): `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7`.
Create signer: `0xb989A99823eA96552c3E3198A40CdBF682EDf1aA`.
Old testnet deployer, refused by the script: `0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714`.

## Fork proof (already done, local only)

A local anvil copy of each mainnet, deployer nonce 0, impersonated. No broadcast. `deployments/{bsc,robinhood}/mainnet.gen8.json` was not written.

| Chain | Txs | Gas used | Gas price measured | Deploy | Deploy plus one retry |
| --- | --- | --- | --- | --- | --- |
| BNB 56 | 13 | 18,595,216 | 50,000,000 wei (0.05 gwei) | 0.0009297608 BNB | 0.0018595216 BNB |
| Robinhood 4663 | 11 | 17,743,412 | 20,050,000 wei | 0.0003557554106 ETH | 0.0007115108212 ETH |

Postflight after the deploy passed: owners and admins are the Safe, `createPaused` is true, the create signer is `0xb989…`, oracle / hook / lens / splitter wiring matches, and the deployer holds none of the live role slots. On BNB the display factory hook is set and a second `setHook` reverts. The Safe was then impersonated on the fork only, the setup batch was applied, and the gen-7 cap numbers matched.

The rehearsal batches under `deployments/*/fork-rehearsal/` use an anvil address. Do not sign them. They are gitignored.

The Safe pays for the setup batch. That gas is not in the deployer figure.

## Same address on both chains

A CREATE address is `keccak256(rlp([deployer, nonce]))`. The chain id is not part of it. The same deployer at the same nonce produces the same address on BNB and on Robinhood.

That is what the BNB setup file was showing. On the nonce-0 rehearsal, the BNB choice vault and the Robinhood launcher are both the deployer's nonce 6, so both are `0x67AF3De471644eaEC8fb1674338F60Fa9fd31b19`. The BNB setup batch calls that address because it is the BNB vault. The same bytes are the Robinhood launcher. The file was the BNB batch. It was not a Robinhood launcher copied into the BNB file.

The same nonce matches on these other pairs too. BNB has two extra transactions (the display factory and its one-time `setHook`), so later contracts shift by two. The hook does not match: it is CREATE2, and its init code includes that chain's PoolManager.

| Nonce | BNB | Robinhood |
| --- | --- | --- |
| 0 | swap sim | swap sim |
| 1 | display factory | community vault |
| 5 | splitter | reserve lock |
| 6 | choice vault | launcher |
| 7 | reserve lock | lens |
| 8 | launcher | escrow |
| 9 | lens | holder distributor |
| 10 | escrow | airdrop distributor |

The real deploy does this again when both chains start at nonce 0 on the same key. Leave the nonces alone. The Safe batch carries the chain id, and the signing files are built from that chain's deploy record after the send. A Robinhood batch checked against the BNB record is refused. `scripts/gen8/deploy/gen8-mainnet-batches.test.mjs` covers the shared nonce and that refusal.

## 1. Fresh deployer (founder)

In the founder's own terminal. The agent only receives the address. If a command prints a private key or a seed phrase, do not paste it into chat.

```
mkdir -p "$HOME/.mwz-keys"
chmod 700 "$HOME/.mwz-keys"
cast wallet new "$HOME/.mwz-keys" mwz-gen8-deployer
cast wallet address --keystore "$HOME/.mwz-keys/mwz-gen8-deployer"
```

Send the address only.

Fund that address, one chain at a time, from a wallet the founder already controls:

- BNB: the measured deploy plus one retry is **0.0018595216 BNB** at 0.05 gwei. BSC gas is often higher. At 3 gwei the same 18,595,216 gas twice is about 0.112 BNB. Send **0.2 BNB**.
- ETH on Robinhood: the measured deploy plus one retry is **0.0007115108212 ETH** at the gas price above. Send **0.01 ETH**.

After the deploy the key must hold no owner, operator, signer, pauser, or distributor. The BNB display factory keeps the deployer address in an immutable slot. That slot can call `setHook` once. The deploy does that call, and the postflight proves a second call reverts. The leftover BNB and ETH are a balance, not a role. Sweep them to the Safe after that chain's postflight, in section 3.

## 2. Preflight (founder, read-only)

On `prep/evm-gen8-mainnet`, after the address is funded:

```
node scripts/gen8/deploy/preflight-gen8-mainnet.mjs --deployer 0xTHE_ADDRESS
```

The script exits 1 if a check fails. It refuses the old deployer. It checks chain id, the fresh balance, the Safe, canonical V4 code (Universal Router runtime exactly 24380 bytes), wrapped native, oracle age and price, gen-7 owner and that gen-7 creates are still open, and that the four payout vaults accept 1 wei from the Safe.

## 3. Deploy (founder, their terminal)

One chain at a time. The script prompts for the keystore password on that terminal. It does not print the key. It refuses a loopback RPC, the old deployer, the Safe, and the create signer. It writes `deployments/{bsc,robinhood}/mainnet.gen8.json` only after the send, with status `deployed-create-paused`.

```
cd /home/patrick/mwz-wt/evm-gen8
export GEN8_DEPLOYER_KEYSTORE="$HOME/.mwz-keys/mwz-gen8-deployer"
export CONFIRM_EVM_GEN8_MAINNET=I_UNDERSTAND_MAINNET
node scripts/gen8/deploy/deploy-gen8-mainnet.mjs --chain 56
```

Repeat with `--chain 4663` after BNB postflight has passed.

The script runs its own preflight, deploys with launches paused, passes the Safe as owner and admin in the constructors, and on BNB calls `setHook` once. Postflight then proves the Safe owns every ownable contract, `createPaused` is true, the create signer is `0xb989…`, and the deployer holds no live role.

After that postflight has passed, sweep the deployer's leftover native to the Safe `0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7`. One chain at a time, from the founder's terminal. The keystore password stays on that terminal. Do not paste the key or the password into chat. Read the balance, subtract the transfer gas (21000), and send the rest. A native transfer at 3 gwei costs 0.000063 of that chain's native. If the send reverts for insufficient funds, lower the value and send again.

```
ADDR=$(cast wallet address --keystore "$HOME/.mwz-keys/mwz-gen8-deployer")
cast balance "$ADDR" --rpc-url https://bsc-dataseed.bnbchain.org
cast send 0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7 \
  --rpc-url https://bsc-dataseed.bnbchain.org \
  --keystore "$HOME/.mwz-keys/mwz-gen8-deployer" \
  --value AMOUNT_IN_WEI
```

Robinhood uses `https://rpc.mainnet.chain.robinhood.com` and the same Safe. Do this only after that chain's postflight. The deploy still needs the gas before then.

Rollback: the contracts cannot be deleted. Leave `createPaused` true. Gen-7 is still open, so production launches keep using gen-7. Do not point LIVE env at the new addresses.

## 4. Safe batches (founder signs, after the deploy record exists)

Do not predict addresses. The writer refuses `--deployer` and `--nonce`. It reads `deployments/bsc/mainnet.gen8.json` or `deployments/robinhood/mainnet.gen8.json`, and only a record with status `deployed-create-paused`. It encodes the batch from that record, compares every chain id, call, `to`, and address argument with the record, and refuses on any difference. It then reads the files back and checks again.

```
node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 56
node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 4663
```

Each chain gets three unsigned Safe Transaction Builder files under `deployments/{bsc,robinhood}/mainnet-batches/`, and a readable decode next to each:

1. `mainnet.gen8.setup` — creates stay paused. Vault operator `0x20652bdb1d986220fEc30f4733587F279403E773`, caps copied from live gen-7 (BNB 0.65 / 6.5 / 6 h / 50 bps / 32 ether; Robinhood 0.19 / 1.9 / 6 h / 50 bps / 9.3 ether), holder and airdrop distributors, splitter operator, airdrop operator `0xdcf07EB07e6D6722c246161e7530dc905F9eaA50`.
2. `mainnet.gen8.opening-day` — `setCreatePaused(false)` on gen-8 and `setCreatePaused(true)` on the gen-7 factories (BNB `0x948463E91d63a7A51cEeC0342735D1B738044aea`, Robinhood `0x399E529c0C6888543E6501FD137ac49CA3E1Df58`). Existing gen-7 coins keep trading. Leave this unsigned until the founder says go.
3. `mainnet.gen8.set-create-signer` — spare `setCreateSigner`. The argument is `0xb989…`. Signing it unchanged sets the same signer again. A later rotation is a new batch. Do not edit this checked file.

There is no Roles batch. The Roles module `0xEeeE0082257bc4A3189e38f0a2881f129E101c70` has no code on 56 or 4663, and this Safe's module list was empty. Do not deploy that module for gen-8. Do not write `mainnet.gen8.payout-roles.json`.

Sign setup first, on both chains. Check the chain id in the Safe UI before signing (56, then 4663). Then read the five cap getters on the gen-8 choice vault (`maxBuyPerTx`, `maxBuybackPerCoinWeek`, `minBuyInterval`, `maxImpactBps`, `maxHolderBatchPerWeek`) and match them to the setup decode. A second deploy is refused once `mainnet.gen8.json` exists.

Rollback after setup: leave creates paused. The Safe can set the vault operator paused. Gen-7 is untouched.

Holder payouts are one Safe proposal per batch, from `planGen8HolderWeek` in `realtime-indexer/src/evm/evmGen8HolderBatch.ts` on `release/evm-gen8`. The program is `airdrop_holders_gen8`. The proposal is two calls: `approveHolderBatch(bytes32,bytes32,uint256,uint64)` (selector `0xc62732bb`) on the gen-8 choice vault, and `authorizeBatch` on the holder `RewardDistributor`. `sends` is empty. `safe.applied` is false and `safe.executes` is false. `executeHolderBatch` is not in the proposal. Safe owners sign. Nothing executes by itself. Do not point gen-8 at the gen-6/7 three-argument `approveHolderBatch` helper.

## 5. Production SQL (founder pastes, do not run from a script)

File: `deployments/gen8/PROD_APPLY.sql` (same paste at `docs/build_plans/GEN8_PROD_APPLY.sql`).

Paste into the production Supabase SQL editor, project `ellkfgoxnzykxqybajtn`. Staging already has this. The file is safe to run twice. The last statement is a read-only check. Every column of that check should be true.

If the view patch raises, stop. It refuses to write a half-patched `market_trades_v`.

Rollback: the tables are additive and unread until the LIVE env is set. Leave them. Do not drop them in a hurry.

## 6. LIVE env (founder, after the json records exist)

Paste `deployments/bsc/mainnet.gen8.coolify.env` and `deployments/robinhood/mainnet.gen8.coolify.env`. Replace each placeholder from that chain's `mainnet.gen8.json`. App lines are `VITE_*` with no `@startBlock` (baked at build). API and indexer lines use `@startBlock` on the launcher, the hook, and the splitter. Layout is `v2.1`. Leave the existing 46630 lines.

Redeploy app, API, and indexer. Creates are still paused, so the app can read gen-8 and still cannot launch one.

Rollback: remove the new gen-8 lines and redeploy. Gen-7 env stays.

## 7. Release branch (founder merges when they choose)

`release/evm-gen8` is the app, API, and indexer branch. Push it only as `git push origin HEAD:release/evm-gen8` from `/home/patrick/mwz-wt/gen8-release`. A bare `git push` is refused because the branch has no upstream. Do not push `build/cross-chain-stabilization-rh-base`. That branch auto-deploys production.

Point the TEST app, API, and indexer at `release/evm-gen8` and redeploy before the browser check of G8DIR, G8WAIT, B8DIR, and B8WAIT.

Merge into the live branch only when the founder says so, after the browser check, with creates still paused. Rollback of that merge is a revert commit on the live branch, which auto-deploys. Do not force-push.

## 8. Opening day (unsigned until the founder says go)

Sign `mainnet.gen8.opening-day` on both chains in one sitting, after the browser check on the paused contracts. That opens gen-8 and pauses new gen-7 launches. Coins that already exist keep trading.

Rollback: the Safe calls `setCreatePaused(true)` on the gen-8 launcher and `setCreatePaused(false)` on the gen-7 factory. Coins already launched keep trading either way.

## Order

1. Founder creates the keystore and sends the address.
2. Founder funds 0.2 BNB and 0.01 ETH.
3. Founder runs preflight.
4. Founder runs the deploy on 56, reads postflight, then sweeps leftover BNB to the Safe. Then 4663, postflight, and sweeps leftover ETH to the Safe.
5. Write the three signing batches from each chain's `mainnet.gen8.json`. The writer refuses a predicted address and refuses a batch that differs from that record. Sign setup only. No Roles batch.
6. Founder pastes `PROD_APPLY.sql` in production.
7. Founder sets LIVE env from the two coolify files and redeploys.
8. `release/evm-gen8` is already at `2bdcb6c8`. Point the TEST app, API, and indexer at it and redeploy. Browser-check G8DIR, G8WAIT, B8DIR, and B8WAIT only after both `/health` sourceCommit values are `2bdcb6c8`. The founder merges to live when they want. Creates still paused.
9. Opening-day batch only when the founder says go.

The battle `is_active` fix stays parked. Graduated coins still cannot enter battles. Solana program upgrades stay in the combined release and are not part of this deploy. The external audit stays deferred.
