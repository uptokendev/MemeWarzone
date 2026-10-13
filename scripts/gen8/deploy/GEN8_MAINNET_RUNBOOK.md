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

After the deploy the key must hold no owner, operator, signer, pauser, or distributor. The BNB display factory keeps the deployer address in an immutable slot. That slot can call `setHook` once. The deploy does that call, and the postflight proves a second call reverts. Sweep any leftover BNB and ETH back afterwards. The leftover is a balance, not a role.

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

Rollback: the contracts cannot be deleted. Leave `createPaused` true. Gen-7 is still open, so production launches keep using gen-7. Do not point LIVE env at the new addresses.

## 4. Safe batches (founder signs, after the address exists)

Contract addresses depend on the deployer nonce. Regenerate the signing files once, with the funded address, before anyone opens Safe. Nonce 0 if the key has never sent a transaction.

```
node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 56 --deployer 0xTHE_ADDRESS --nonce 0
node scripts/gen8/deploy/write-gen8-mainnet-batches.mjs --chain 4663 --deployer 0xTHE_ADDRESS --nonce 0
```

Each chain gets four unsigned Safe Transaction Builder files under `deployments/{bsc,robinhood}/mainnet-batches/`, and a readable decode next to each:

1. `mainnet.gen8.setup` — creates stay paused. Vault operator `0x20652bdb1d986220fEc30f4733587F279403E773`, caps copied from live gen-7 (BNB 0.65 / 6.5 / 6 h / 50 bps / 32 ether; Robinhood 0.19 / 1.9 / 6 h / 50 bps / 9.3 ether), holder and airdrop distributors, splitter operator, airdrop operator `0xdcf07EB07e6D6722c246161e7530dc905F9eaA50`.
2. `mainnet.gen8.roles` — selector `0xc62732bb` (`approveHolderBatch(bytes32,bytes32,uint256,uint64)`) on the gen-8 choice vault. `applied: false`. The Roles module `0xEeeE0082257bc4A3189e38f0a2881f129E101c70` has no code on 56 or 4663, and this Safe has no modules, so the batch cannot land until that module is deployed and enabled by the existing payout-roles process. This blocks holder-batch approvals. It does not block a paused deploy.
3. `mainnet.gen8.opening-day` — `setCreatePaused(false)` on gen-8 and `setCreatePaused(true)` on the gen-7 factories (BNB `0x948463E91d63a7A51cEeC0342735D1B738044aea`, Robinhood `0x399E529c0C6888543E6501FD137ac49CA3E1Df58`). Existing gen-7 coins keep trading. Leave this unsigned until the founder says go.
4. `mainnet.gen8.set-create-signer` — spare `setCreateSigner`. The argument is `0xb989…`. Signing it unchanged is a no-op. The Safe UI can edit the address. Do not put the zero address.

Sign setup first, on both chains. Then read the five cap getters on the gen-8 choice vault (`maxBuyPerTx`, `maxBuybackPerCoinWeek`, `minBuyInterval`, `maxImpactBps`, `maxHolderBatchPerWeek`) and match them to the setup decode. A second deploy is refused once `mainnet.gen8.json` exists.

Rollback after setup: leave creates paused. The Safe can set the vault operator paused. Gen-7 is untouched.

Holder payouts still need a batch authorization on the holder `RewardDistributor` (`authorizeBatch` before `createBatch`). The Roles file above does not grant that. Widening it is a separate decision.

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
4. Founder runs the deploy on 56, reads postflight, then 4663.
5. Regenerate the four Safe batches per chain with that address. Sign setup only.
6. Founder pastes `PROD_APPLY.sql` in production.
7. Founder sets LIVE env from the two coolify files and redeploys.
8. Push `release/evm-gen8` if the checks passed, point TEST at it, browser-check the four coins, then the founder merges to live when they want. Creates still paused.
9. Opening-day batch only when the founder says go.

The battle `is_active` fix stays parked. Graduated coins still cannot enter battles. Solana program upgrades stay in the combined release and are not part of this deploy. The external audit stays deferred.
