# Go-live, step by step

A short checklist for the founder and the Safe signers. It follows `docs/release/GO_LIVE_ALL_CHAINS.md`
(the runbook) and adds nothing to it except three items marked NEW. When a step says "runbook 2.7", the
exact read-backs are there. Commands below are copied from the runbook; do not change them.

Who does what:

- **Founder terminal**: every mainnet send. Never Claude (decision E17).
- **Safe signers**: two of three, every admin call on BNB and Robinhood. Before signing any batch, run
  the check in runbook 2.9 (every line must say `OK`).
- **Coolify**: env changes and redeploys. `VITE_*` changes need an app rebuild.
- **Supabase**: SQL editor, staging first, then production.
- **Claude checks**: read-only checks only (curl, chain reads, `BEGIN READ ONLY` queries).

Already done, skip: the migration bundle `docs/release/all-chains-migrations.sql` (staging and production,
2026-10-01) and the 48 h vote battle migration `20261001_000001`.

## A. Before the day

If something is wrong in this phase: nothing is visible to users yet, so stop and ask. Stop switches are
in runbook section 4.

| # | Who | What | You should see |
|---|---|---|---|
| A1 | Founder terminal | Create the eight keys and secrets (runbook 1.1 table, exact commands there). None may be the deployer or a Safe owner. Files `chmod 600`. Secrets go in your password manager, never in git or chat. | Five key files (three Solana, two EVM) plus three `openssl rand -hex 32` secrets written down |
| A2 | Founder terminal | Fund them: collector ~0.5 SOL, config payer ~0.3 SOL, referral owner ~0.05 SOL; EVM keeper and creator-choice operator 0.02 BNB and 0.005 ETH each | `solana balance <pubkey> --url <mainnet rpc>` and `cast balance <address> --ether --rpc-url <rpc>` show the amounts |
| A3 | Founder terminal | Solana referral accounts, one per quote (runbook 1.2, full list in `docs/dbc/release/SOLANA_DBC_GO_LIVE.md` section 1): `SOLANA_RPC_URL=<mainnet rpc> DBC_REFERRAL_OWNER_KEYPAIR="$(cat ~/.config/memewarzone/dbc-referral-owner.json)" node scripts/dbc/create-referral-account.mjs` (dry run, then add `--send`), then the `spl-token create-account` lines for USDC, USDT and the four xStocks | `spl-token accounts --owner <referral owner>` shows six accounts. Write the JSON map (quote mint to referral account) |
| A4 | Founder terminal | Re-read both deployer balances the day before | BNB at least 0.00162 BNB. Robinhood: top up to 0.01 ETH if gas is above 0.05 gwei (**to verify** on the day) |
| A5 | Founder terminal | Fork rehearsal, the day before: `npx hardhat compile`, then `BSC_MAINNET_RPC=<paid BSC RPC> npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network bscForkRehearsal` and `ROBINHOOD_MAINNET_RPC_URL=<paid RH RPC> npx hardhat run scripts/rehearse-evm-gen6-mainnet-fork.ts --network robinhoodForkRehearsal` | Both exit 0; `deployments/fork-rehearsal/<network>/rehearsal-report.json` says accepted |
| A6 | Founder terminal | Move the old deployment records (the four `git mv` lines in runbook 1.5), one commit on `release/all-chains` | Committed. Robinhood's stock script refuses without this |
| A7 | Founder terminal | EVM fees stack, BNB then Robinhood (runbook 1.6, full command there, starts with `cast chain-id` which must print 56 / 4663). Deploys router V4, creator vault V2 and the holder distributor. Nobody routes to them yet. **Never run it twice on a chain.** | Read-backs in EVM 2.1 pass (router admin is the Safe, `CREATOR_TRADE_BPS` 560). `deployments/<chain>/mainnet.evmgen-fees.json` and the batch A file committed |
| A8 | Founder terminal | Verify the fees stack on the explorers (runbook 1.7): `ONLY=TreasuryRouterV4,CreatorRewardsVaultV2,RewardDistributor npx hardhat run scripts/verify-mainnet-contracts.ts --network bscMainnet` and `ONLY=TreasuryRouterV4,CreatorRewardsVaultV2,RewardDistributor node scripts/sourcify-verify.mjs 4663` | BscScan and the Robinhood explorer show verified source |
| A9 | Supabase | **NEW.** Grok's social feed: run `db/migrations/20261001_000002_social_posts.sql` in the SQL editor on staging (`vrnsbguutnwgtekcexls`), then on production (`ellkfgoxnzykxqybajtn`). It is `IF NOT EXISTS`, safe to paste twice | `select to_regclass('public.social_posts');` returns `social_posts` on both |
| A10 | Coolify | **NEW.** App service (`app.memewar.zone`): paste the nginx config from "App security headers" below as the custom nginx configuration, redeploy the app | `curl -sI https://app.memewar.zone/ \| grep -i frame` shows `frame-ancestors 'none'`; `curl -sI https://app.memewar.zone/embed/chart/101/x \| grep -i frame` shows the crypticpump line |
| A11 | Founder | Book two of the three Safe owners for the whole opening session (BNB then Robinhood, several hours) | Two names, one time slot |
| A12 | Founder | Find out which Coolify resources auto-deploy on a push to the live branch (**to verify**, runbook section 6 item 2) | Written down, including the Solana graduation keeper and resolve-due worker |

### App security headers

Custom nginx configuration for the Coolify app service. Copy it exactly:

```
server {
    listen 80;
    listen [::]:80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    location /embed/chart/ {
        add_header Content-Security-Policy "frame-ancestors 'self' https://crypticpump.com https://www.crypticpump.com" always;
        rewrite ^ /index.html break;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files $uri =404;
    }

    location / {
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        try_files $uri $uri/ /index.html;
    }
}
```

Check after the redeploy:

```
curl -sI https://app.memewar.zone/ | grep -i frame
# content-security-policy: frame-ancestors 'none'   (and x-frame-options: DENY)
curl -sI https://app.memewar.zone/embed/chart/101/x | grep -i frame
# content-security-policy: frame-ancestors 'self' https://crypticpump.com https://www.crypticpump.com
```

The chart embed is the only page another site may frame. Every other page refuses to be framed.

## B. Go-live day

Do these in order. Each step can stop without harm until the opening session (B6). Tick a step only after
its check passes.

If something is wrong in this phase: runbook section 4 (4.1 Solana DBC, 4.2 EVM per chain, 4.3 app or API).

| # | Who | What | You should see |
|---|---|---|---|
| B1 | Coolify | Set service env, everything off or dry run (runbook 2.2, full tables there). API: `DBC_LAUNCH_ENABLED=false`, `RUNTIME_ENVIRONMENT=production`, collector, config payer, creator vault and API secret. Indexer: DBC secrets, referral JSON map, every `_SEND` flag `false`, EVM keeper and choice `ENABLED_<id>=false`, plus `ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663=0xCaf681a66D020601342297493863E78C959E5cb2`. App: `VITE_DBC_LAUNCH_ENABLED=false`, `VITE_DRAFT_PUSH_LIVE_ENABLED=true`, `VITE_RUNTIME_ENVIRONMENT=production`, `VITE_DBC_REFERRAL_TOKEN_ACCOUNTS` | All names present in Coolify. Factory addresses unchanged for now |
| B2 | Founder terminal | Write down the current live head: `git rev-parse origin/build/cross-chain-stabilization-rh-base` (needed for rollback, runbook 4.3) | A commit hash on paper |
| B3 | Founder terminal | Fast-forward the live branch: `git fetch origin`, then `git merge-base --is-ancestor origin/build/cross-chain-stabilization-rh-base origin/release/all-chains && echo FAST-FORWARD-OK`, then `git push origin origin/release/all-chains:build/cross-chain-stabilization-rh-base`. Never `--force` | `FAST-FORWARD-OK`, push accepted. If git refuses, the live branch moved: stop and find out why |
| B4 | Coolify | Redeploy in this order: indexer, then API, then app (all at once is acceptable, every flag is off) | Three green deploys |
| B5 | Claude checks | Smoke checks (runbook 2.4): `curl -s https://api.memewar.zone/health` and `curl -s https://indexer.memewar.zone/health`; `curl -s https://api.memewar.zone/api/dbc/launch-config`; indexer log; open the app, a BNB, Robinhood and Solana coin, the Create page; a small buy on an existing Solana coin | Both `sourceCommit` = release head; launch-config `disabled: true`; log `[dbc-fee] enabled { send: false … }` and `[evm-choice] disabled`; no DBC option on Create; old coins trade |
| B6 | Coolify | **NEW, canary mode.** API: `CREATE_CANARY_WALLETS=<your Solana wallet>,<your EVM wallet>` (comma-separated; EVM any case, Solana exact), redeploy API. Every create path then answers 403 `CREATE_CANARY_ONLY` to any other wallet; drafts still save | `GET https://api.memewar.zone/api/launch-status` returns `{"canary":true}`; Create page shows "Launches open soon". **To verify**: a non-listed wallet gets `CREATE_CANARY_ONLY` on each chain |
| B7 | Coolify, then founder | DBC canary (runbook 2.5): API `DBC_LAUNCH_ENABLED=true`, app `VITE_DBC_LAUNCH_ENABLED=true`, redeploy API then app. Launch one coin: SOL pairing, $15K, fee choice keep. After 60 s buy 0.02 SOL, sell half. Search the coin by address in Jupiter or Phantom swap | One wallet signature to launch; Jupiter routes it on the curve; indexer shows the trades, the fee accrual and a `[dbc-fee]` dry-run route |
| B8 | Safe signers | **Opening session, BNB first.** Batch A: `deployments/<chain>/mainnet.evmgen-fees.A.safe-batch.json` (10 calls). Check with 2.9, sign, execute. EVM creation on the site is closed from now until batch H | Old factory `createPaused()` true; community vault `router()` = new router; vault `limits()` shows the caps |
| B9 | Founder terminal | Generation: BNB per EVM 2.3 (`deploy-bnb-quote-generation.ts` with `BNB_TREASURY_ROUTER=<router V4>`); Robinhood per EVM 2.8 | `FACTORY_GENERATION` 6, `CAMPAIGN_GENERATION` 5, `createPaused` true, `live` false, 0 campaigns |
| B10 | Founder terminal, then Safe | Batch B: `EVMGEN_BATCHES_ONLY=1 EVMGEN_VAULT_OPERATOR=<creator-choice operator address> npx hardhat run scripts/deploy-evm-treasury-router-v4.ts --network bscMainnet` (`robinhoodMainnet` for 4663). Check with 2.9, sign, execute | Locker authorized and primary; vault `factory()` = new factory; vault `operator()` = the new operator key |
| B11 | Founder terminal | Ownership to the Safe (EVM 2.5). Robinhood: `OWNABLE_CONTRACTS=<factory>,<CreatorRegistry>,<RiskRegistry>` | `owner()` is the Safe on each |
| B12 | Founder terminal, then Safe | **Robinhood only, before H:** `npx hardhat run scripts/deploy-robinhood-stock-campaign-implementation.ts --network robinhoodMainnet`, then the Safe executes `deployments/robinhood/mainnet.R5-stock-campaign-implementation.safe-batch.json`. Batch Q (nine stock routes) now or later | `stockCampaignImplementation()` = new implementation. Missing this before the first coin locks stock bindings out forever |
| B13 | Founder terminal | Explorer verification of every new contract (EVM 4) | Verified source on both explorers |
| B14 | Coolify | New addresses on API, indexer and app (runbook 2.7 G, EVM 5.1 to 5.3). Indexer: `EVM_GRADUATION_KEEPER_ENABLED_<id>=true` and `EVM_CREATOR_CHOICE_ENABLED_<id>=true`, both `_SEND` still `false`. Redeploy indexer, API, app | Log `[evm-grad] enabled { chainId: 56, send: false, … }` and `[evm-choice] enabled { chainId: 56, send: false, … }`; `node scripts/verify-live-app-bundle.mjs https://app.memewar.zone` finds the new addresses (**to verify** that the script knows them, runbook 6 item 7) |
| B15 | Safe signers | Batch H opens the new factory: build with `scripts/make-safe-batch.ts` from the calls file in runbook 2.7 H (BNB: `enableLive`, `setCreatePaused(false)`, and pause `0xc378221E…`; Robinhood: the first two only). `enableLive` cannot be undone | New factory `live()` true, `createPaused()` false; all old factories `createPaused()` true |
| B16 | Founder | EVM canary right after H (runbook 2.7 I): one coin, $15,000 target, 1% first buy (BNB fee choice keep, Robinhood holders). After 60 s buy about 0.01 BNB / 0.003 ETH, sell half. If it fails: `setCreatePaused(true)` | Fee 2%; router split league 37.5%, creator vault 5.6%, community 15%, protocol 41.9%; `campaign-state` shows generation 5; indexer `factory_generation = 6`; BNB creator claim equals the sum of `TradeFeeAccrued` |
| B17 | | Repeat B8 to B16 for Robinhood. Set Robinhood's `_ENABLED` flags only once it reaches B14 | Same checks on 4663 |
| B18 | Coolify | Public opening, when the DBC and both EVM canaries pass: remove `CREATE_CANARY_WALLETS` from the API (or set it empty), redeploy API. Then announce | `GET /api/launch-status` returns `{"canary":false}`; the Create page banner is gone |
| B19 | Coolify | Switch indexer workers to sending, one flag at a time, redeploy and watch before the next: `DBC_FEE_ROUTING_SEND`, `DBC_GRADUATION_SEND`, `DBC_CREATOR_CHOICE_SEND`, `EVM_GRADUATION_KEEPER_SEND`, `EVM_CREATOR_CHOICE_SEND` (runbook 2.10) | One DBC claim and route land with vault deltas matching the split; graduation logs `send: true` and idle; keeper logs `[evm-grad] enabled { send: true }`; turn on `EVM_CREATOR_CHOICE_SEND` only after the first week commitment is published (`GET https://api.memewar.zone/api/evm/creator-choice?chainId=<id>`) |

## C. After

If something is wrong in this phase: runbook section 4. The quickest safe stops are the `_SEND` flags
(nothing is lost, it waits) and `setCreatePaused(true)` on a new factory.

### First 24 hours (runbook section 3)

| Who | What | You should see |
|---|---|---|
| Claude checks | First DBC graduation, when a coin hits its target | Indexer `[dbc-grad]` steps through to done; the DAMM v2 pool trades; creator payout claimable |
| Claude checks | First EVM graduation per chain ($15K / $30K / $50K) | Keeper sends `graduate`; 2.2% to the router, 19.8% `pendingCreatorGraduation`, 78% into the locked pool |
| Claude checks | First harvest per chain (keeper every 6 h) | 80/20 creator/protocol. On BNB the first harvest on a new pool can carry the MEME side until the pool has 30 min of history; that is normal |
| Claude checks | First stock-paired Robinhood coin and first USDC-paired DBC coin | Both never run end to end on mainnet (**to verify**, runbook 6 items 5 and 6) |
| Founder | Key balances, twice a day: collector, config payer, EVM keeper, EVM operator | Top up below 0.1 SOL / 0.005 BNB / 0.001 ETH |
| Claude checks | `node scripts/check-evm-payout-bounds.mjs` after every batch that sets a cap | Exit 0 |
| Claude checks | Old coins: the one coin on `0xc378221E…` and existing Solana launchpad coins | Trade as before |
| Claude checks | Social feed and headers stay as set in A9 and A10 | `/feed` loads; the two `curl -sI` checks still pass |

### Weekly (Mondays, from 2026-10-05)

| Who | What | You should see |
|---|---|---|
| Safe signers | EVM holder batch, both chains (runbook 5.1): `node scripts/evm-holder-batch-verify.mjs --chain 56 --file "https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<Monday of the week>" --auth-max 32000000000000000000 --out holders-56-<week>.safe-batch.json`, and the same for `--chain 4663` with `--auth-max 9300000000000000000`. Check with 2.9, sign, execute | The script writes a batch only if root, total and vault balance agree. Claims open after the 24 h veto window. Nothing is paid without this step |
| Nobody | Solana DBC holder payouts | Ride the weekly airdrop runner, no Safe step (**to verify** that the Monday task runs for chain 101, runbook 6 item 8) |
| Founder | Balances: EVM keeper and operator, DBC collector and config payer | Above the top-up levels |

### Monthly

| Who | What | You should see |
|---|---|---|
| Founder terminal, then Safe | Unclaimed holder payouts after the 60-day deadline (runbook 5.2), from early December 2026: `HOLDER_RECOVERY_FILE="https://api.memewar.zone/api/evm/holder-batch?chainId=56&weekId=<week>" npx hardhat run scripts/make-holder-recovery-batch.ts --network bscMainnet` (and 4663 / `robinhoodMainnet`) | A Safe batch only when there is something to recover; it refuses before the deadline |
| Founder terminal, then Safe | Airdrop recovery from late November 2026: `npx hardhat run scripts/make-airdrop-recovery-batch.ts --network bscMainnet` (and `robinhoodMainnet`) | One atomic Safe batch |
| Claude checks | Cap review, or when BNB or ETH moves more than 25% from $767 / $2,695: `node scripts/check-evm-payout-bounds.mjs` | Exit 0. To change caps: one-call Safe batch `CreatorRewardsVaultV2.setCaps(...)` (runbook 5.4), and keep `--auth-max` equal to `maxHolderBatchPerWeek` |

## Still marked "to verify" in the runbook

Factory deployed ahead of the day (not rehearsed, do not use); Coolify auto-deploy and redeploy time;
stock-paired coin and USDC-paired DBC coin end to end; app bundle addresses; airdrop runner on chain 101;
Robinhood deployer gas; DBC collector rotation for existing pools; canary refusal for non-listed wallets;
rollback with the trigger change in `20260930_000003`. Details in runbook section 6.
