# Robinhood Testnet via Localhost

This is the developer/browser acceptance path for MemeWarzone Robinhood Chain testnet (`46630`). It keeps the frontend, frontend API, indexer API, PostgreSQL database, bonding scanner, and Robinhood V3 indexer local while transactions are sent to the real Robinhood testnet.

This supplements `docs/robinhood-testnet-acceptance-runbook.md`. Production BNB/Solana services, Supabase, Ably, telemetry, and Topaz indexing are deliberately excluded from this profile.

## 1. Prerequisites

Use the PR branch:

```bash
git checkout feat/robinhood-chain-phase0-3
git pull
```

Install dependencies if needed:

```bash
npm install
npm install --prefix frontend
npm install --prefix realtime-indexer
```

PostgreSQL 16+ must be available locally.

Create the ignored local config:

```bash
cp config/robinhood-local.env.example config/robinhood.local
```

Set only your local PostgreSQL connection in `config/robinhood.local`, for example:

```text
DATABASE_URL=postgresql://postgres:<LOCAL_PASSWORD>@127.0.0.1:5432/memewarzone_robinhood_local
```

## 2. Real Robinhood testnet deployment

The localhost launcher intentionally refuses full transaction acceptance until this file exists:

```text
deployments/robinhood/testnet.staged.json
```

Hardhat loads `.env` then `config/robinhood.local`. Put 46630 RPC and testnet-only deployer/route-authority/acceptance wallet keys in `config/robinhood.local`. Keep `ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=false` there and enable it only on the lifecycle command. Never commit those keys.

```bash
export ROBINHOOD_TESTNET_RPC_URL='https://rpc.testnet.chain.robinhood.com'
export PRIVATE_KEY_DEPLOY='<funded testnet deployer private key>'
export ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY='<testnet route authority private key>'
export ROBINHOOD_ROUTE_AUTHORITY_ADDRESS='<address derived from the route authority key>'
```

Deploy and independently verify the fail-closed staged protocol:

```bash
export ROBINHOOD_STAGE_DEPLOYMENT_FILE='deployments/robinhood/testnet.staged.json'
export ROBINHOOD_TEST_NATIVE_USD_PRICE='3000'
npx hardhat compile
npx hardhat run scripts/deploy-robinhood-testnet-stage.ts --network robinhoodTestnet
npx hardhat run scripts/verify-robinhood-testnet-stage.ts --network robinhoodTestnet
npx hardhat run scripts/deploy-robinhood-testnet-auxiliary.ts --network robinhoodTestnet
```

The manifest must remain staging-only and the factory must still be disabled at this point.

## 3. Scripted on-chain lifecycle acceptance

Fund the testnet-only creator, buyer, and trader wallets with Robinhood testnet ETH, then export their private keys according to the main runbook.

Run the scripted lifecycle before browser acceptance:

```bash
export ROBINHOOD_ACCEPTANCE_ENABLE_LIVE='true'
npx hardhat run scripts/test-robinhood-testnet-lifecycle.ts --network robinhoodTestnet
```

This is the explicit action that may enable the staged testnet factory for acceptance. It must prove factory 4 / campaign 3 signing, immediate create, scheduled create, pre-`launchAt` rejection, post-`launchAt` buy/sell, bonding buy/sell, `$6` graduation, locked V3 NFT, native adapter buy/sell, 80/20 harvest, then `setCreatePaused(true)`. Local Hardhat rehearsal of this script is **not** Robinhood testnet acceptance; `accepted` may become true only when `provider.chainId == 46630`.

## 4. Start Robinhood testnet through localhost

Keep the route-authority private key exported in the shell:

```bash
export ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY='<same testnet route authority key>'
```

Then run the one-command local launcher from the repo root:

```bash
node frontend/scripts/start-robinhood-testnet-local.mjs
```

The launcher:

1. requires the real `46630` staged manifest and UPVoteTreasury;
2. validates the isolated local PostgreSQL target;
3. applies all committed migrations to the dedicated local database;
4. auto-loads factory, treasury, registry, locker, oracle, UPVote, and V3 addresses from the manifest;
5. starts the local realtime-indexer API on `127.0.0.1:3002`;
6. starts the dedicated Robinhood bonding/factory scanner;
7. starts the Robinhood V3 post-graduation indexer;
8. starts the local frontend API on `127.0.0.1:3001`;
9. starts Vite on `127.0.0.1:5173`;
10. force-disables BNB/Solana RPC workers, Topaz indexing, production Ably, production Supabase, and telemetry.

Open:

```text
http://127.0.0.1:5173
```

## 5. Wallet setup

Use a browser wallet containing only testnet funds.

Add/switch to Robinhood Testnet:

```text
Chain ID: 46630
RPC: https://rpc.testnet.chain.robinhood.com
Native asset: ETH
```

Do not use a production treasury or production admin wallet for localhost acceptance.

## 6. Browser acceptance order

Run these in order so failures are attributable:

1. Select Robinhood independently from BNB/Solana.
2. Connect wallet on `46630` and verify the UI remains Robinhood/ETH.
3. Create a draft.
4. Publish Prepare Mode.
5. Arm notification.
6. Deploy Now.
7. Repeat with a Scheduled Launch.
8. Pre-grad buy.
9. Pre-grad sell.
10. UpVote.
11. Confirm campaign/token metadata in Command Center.
12. Confirm chain-specific recruiter/squad attribution.
13. Confirm Robinhood League and Airdrop surfaces use ETH and do not show BNB state.
14. Trade until the `$6` test graduation threshold is reached.
15. Confirm the same token page survives graduation.
16. Confirm V3 pool discovery and permanent NFT lock.
17. Post-grad buy/sell through the Robinhood V3 test stack.
18. Confirm chart, trade feed, price, volume, market cap, liquidity, and holders update from V3 trades.
19. Confirm no BNB/Solana campaigns or indexer state appear in Robinhood views.
20. Re-run/restart localhost and confirm scanner cursors resume without duplicate trades.

## 7. Safety boundary

This localhost flow is still testnet-only. It does not authorize Robinhood mainnet `4663`, does not make mock V3 production-safe, does not enable production Robinhood creation, and does not merge PR #145.
