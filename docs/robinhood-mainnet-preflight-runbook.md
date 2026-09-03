# Robinhood RH-S14 — Mainnet Preflight Runbook

## Scope

Prepare Robinhood mainnet chain `4663` for independent production verification without activating MemeWarzone creation, Stock graduation, Stock trading, Stock UI, or Beat the Market.

This phase does **not** deploy from CI and does **not** activate production. Production keys and real 4663 addresses must never be committed.

## Locked source and isolation rules

- Use the exact release-candidate source SHA that passed Robinhood testnet acceptance and the current release gates.
- Production chain is `4663`; accepted testnet is `46630`.
- Factory generation is `4`; campaign generation is `3`; liquidity kind is `2`.
- Never reuse an address from `deployments/robinhood/testnet.accepted.json`.
- Never use mock V3, mock WETH, mock oracle, or any controlled testnet contract in production.
- Route authority must be distinct from the production admin/deployer.
- BNB and Solana deployment state remains untouched.

## Required state before manifest preparation

Real production deployment inventory must provide:

- positive deployment block;
- production admin / multisig;
- separate production route authority;
- all required protocol, treasury, V3 and adapter addresses;
- production ETH/USD oracle;
- at least one canonical Stock Token route with approved oracle, pool, quoter/router and fee tier.

Use `config/robinhood-production-inventory.example.json` as the schema only. Do not put private keys in that file.

## Generate a dark production candidate

Keep the real inventory outside source control, for example:

```bash
export ROBINHOOD_PRODUCTION_CANDIDATE_SHA='<40-character-release-sha>'
node scripts/prepare-robinhood-production-manifest.mjs \
  /secure/path/robinhood-production-inventory.json \
  deployments/robinhood/mainnet.candidate.json \
  "$ROBINHOOD_PRODUCTION_CANDIDATE_SHA"
```

The builder itself forces these values and does not accept overrides from the inventory:

```text
supportEnabled=false
creationEnabled=false
stockMarketsEnabled=false
stockGraduationEnabled=false
stockEthRoutingEnabled=false
stockMarketUiEnabled=false
beatTheMarketEnabled=false
factoryLive=false
createPaused=true
securityDefaultsLocked=true
requireRouteAuthorization=true
requireAuthorizedTrading=true
stock.stockRoutesEnabled=false
```

Stock registry entries are also rewritten with:

```text
enabledForGraduation=false
enabledForTrading=false
```

If the inventory is incomplete, reuses accepted `46630` addresses, uses an invalid source SHA, shares admin and route authority, lacks oracle/route evidence, or fails any existing production-manifest invariant, generation stops without writing a valid candidate.

## Offline structural proof

Run both proof suites:

```bash
node --test scripts/prove-robinhood-production-manifest.test.mjs
node --test scripts/prepare-robinhood-production-manifest.test.mjs
```

Then verify the generated candidate against the accepted testnet freeze:

```bash
node scripts/prove-robinhood-production-manifest.mjs \
  deployments/robinhood/mainnet.candidate.json \
  deployments/robinhood/testnet.accepted.json \
  "$ROBINHOOD_PRODUCTION_CANDIDATE_SHA"
```

## Read-only 4663 verification

Only after the candidate exists and the dedicated production RPC is available:

```bash
export ROBINHOOD_MAINNET_RPC_URL='<dedicated-4663-rpc>'
node scripts/verify-robinhood-production-live.mjs \
  deployments/robinhood/mainnet.candidate.json \
  deployments/robinhood/testnet.accepted.json \
  "$ROBINHOOD_PRODUCTION_CANDIDATE_SHA"
```

The verifier is read-only. It checks deployed code, factory generations, adapter and locker wiring, route/trading authorization, V3 fee support, Stock routes and fresh positive oracle evidence. It requires the factory to remain dark and create-paused.

## Canary boundary

Passing structural and read-only verification is **not activation**.

Before any flag changes, separately prove:

1. production oracle identity and freshness;
2. approved Stock acquisition route liquidity and route health;
3. mainnet canary while creation and public Stock surfaces remain disabled;
4. rollback / feature-disable procedure;
5. indexer, database and realtime chain isolation for `4663`;
6. wallet/browser application acceptance on the exact candidate SHA.

Only after those gates should a separate activation procedure be reviewed. Do not make activation a side effect of manifest generation or verification.

## Committed mainnet manifest

`deployments/robinhood/mainnet.json` remains the intentionally empty/dark placeholder until a real production deployment has been independently verified. Do not replace it with a candidate merely because offline preflight passes.
