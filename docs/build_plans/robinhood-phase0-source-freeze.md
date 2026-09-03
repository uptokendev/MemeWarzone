# Robinhood Chain Phase 0 — Source Freeze and Parity Baseline

Date: 2026-08-26
Branch: `feat/robinhood-chain-phase0-3`
Original base branch: `main`
Original source-freeze commit: `88cddda34a90d00ba02a95bf064843eafc2763fc`

## Purpose

Robinhood Chain must be a protocol-parity expansion, not a fork of MemeWarzone product behavior. Chain-specific code may change transaction execution, RPC, explorer, DEX, oracle, wrapped-native asset, and deployment addresses. It must not change the meaning of launch, trade, graduation, rewards, claims, security, or user-visible state.

The branch remains merge-safe by keeping all Robinhood work additive where practical and by comparing this branch against current `main` after each implementation batch.

## Release invariant

A user switching between BNB, Solana, and Robinhood should experience the same MemeWarzone rules. The chain adapter changes *how* an operation executes, not *what* the operation means.

## Protocol parity matrix

| Capability | BNB | Solana | Robinhood requirement |
| --- | --- | --- | --- |
| Draft Mode | accepted | accepted | same |
| Prepare Mode | accepted | accepted | same |
| Direct Deploy | accepted | accepted | same |
| Scheduled Deploy | accepted | accepted | same |
| Ticker reservations | chain-scoped | chain-scoped | chain-scoped |
| Production graduation tiers | $15K / $30K / $50K | $15K / $30K / $50K | $15K / $30K / $50K |
| Test graduation tier | test environment only | test environment only | test environment only |
| Creator cooldown | enforced | enforced | same |
| Live-token limit | enforced | enforced | same |
| Creator buy lock/cap | enforced | enforced | same |
| Wallet/cluster risk | enforced | enforced | same |
| Bonding fee semantics | protocol-defined | protocol-defined | same |
| Treasury/reward routing | native BNB | native SOL | native ETH |
| UpVotes | same product | same product | same product |
| Recruiters | multichain identity | multichain identity | same identity |
| Squads | shared product | shared product | same product |
| Airdrops | chain-native | chain-native | chain-native ETH |
| Leagues | chain-scoped | chain-scoped | chain-scoped |
| Claims | chain-native | chain-native | chain-native ETH |
| Graduation | Topaz adapter | Meteora adapter | Robinhood DEX adapter |
| Post-grad continuity | War Trade Room | War Trade Room | War Trade Room |
| LP/position fee claims | supported | supported | same product behavior |
| Command Center | shared | shared | shared |

## Environment contract

Runtime environments are explicit:

- `local`
- `staging`
- `production`

Robinhood staging uses chain ID `46630`.
Robinhood production uses chain ID `4663`.
Both use ETH as native gas currency.

Hard rules:

1. Staging must never resolve a production deployment manifest.
2. Production must never resolve a test deployment manifest.
3. Testnet is permanent pre-production infrastructure; it is not removed after QA.
4. Staging and production use separate signer keys, RPC credentials, database credentials, realtime namespaces, and privileged secrets.
5. Production activation is a manifest/config promotion on the same accepted source commit, not a testnet-removal refactor.

## Merge-safety procedure

At every RH phase gate:

1. Fetch current `main` and record its SHA.
2. Compare current `main` against the last inspected main SHA.
3. Before editing an existing file, fetch that file from current `main` and inspect any main-side changes.
4. Classify every overlapping hunk as compatible, conflict-prone, or unrelated.
5. If current-main changes are disjoint, refresh the feature branch onto current `main` without inventing conflict resolution.
6. If current-main changes overlap a Robinhood target, examine the semantic difference before rebasing or editing.
7. Compare current `main...feat/robinhood-chain-phase0-3` after each batch.
8. Classify every PR diff file as Robinhood-required or unrelated.
9. Re-run BNB/Solana regression gates after any existing runtime file changes.

No phase is complete if unrelated behavior changes are present in the branch diff.

## Initial phase scope

### RH-0 — Source freeze and parity matrix

Status: complete foundation.

### RH-1 — Environment framework

Status: foundation implemented.

Implemented:

- explicit `local | staging | production` runtime type;
- chain registry with Robinhood 4663/46630 known but creation-disabled;
- deployment manifest validation;
- environment mismatch rejection;
- creation-readiness guard.

### RH-2 — Permanent staging infrastructure

Status: repository preparation implemented; Coolify operations still external.

Repository work includes separate staging/production environment templates and disabled Robinhood deployment manifests. Actual Coolify services and secrets are an operations action and are not committed to source control.

Required services:

- staging frontend
- staging API
- staging indexer

Required isolation:

- signer
- RPC
- database
- Ably namespace/credentials
- allowed origins
- deployment manifests

### RH-3 — Generic EVM refactor

Status: foundation in progress; no Robinhood runtime activation.

Implemented so far:

- generic EVM wallet/network adapter knows 56/97/4663/46630;
- active frontend EVM chains remain exactly 56/97;
- BNB wallet-switch parameters are parity-tested;
- Robinhood wallet parameters are constructible but inactive;
- generic EVM indexer chain-config boundary knows Robinhood but active indexer chains remain exactly 56/97;
- an RPC variable alone cannot activate Robinhood indexing;
- dedicated Robinhood foundation CI compiles/tests frontend and indexer boundaries;
- existing `chainConfig.ts` was deliberately restored to current-main content after a diff check detected an unsafe oversized rewrite.

Still deliberately not changed:

- live chain selectors;
- current BNB indexer scanning engine;
- production BNB/Solana manifests;
- existing contract implementations;
- Topaz graduation path.

### RH-4 — Contract chain-assumption audit

Status: read-only audit complete enough to define RH-5 boundary; see `robinhood-rh4-contract-assumption-audit.md`.

The main coupling is Topaz-specific graduation/liquidity handling, not `block.chainid` itself. Chain IDs in authorization domains remain security-critical and should stay.

### RH-5 — Robinhood graduation adapter

Status: blocked on verified Robinhood graduation venue contracts/pool primitive.

Do not select a third-party testnet DEX merely because it exists. The adapter ABI must be reviewed against both the accepted Robinhood venue and the existing Topaz behavior before `LaunchCampaign` is changed.

## CI note — existing dependency-install baseline

The existing frontend PR proof and the first Robinhood foundation proof both stopped at `npm ci` before any source test or build step executed. The Robinhood PR does not modify `frontend/package.json`, `frontend/package-lock.json`, `realtime-indexer/package.json`, or `realtime-indexer/package-lock.json`, so that install failure is not a Robinhood source diff.

The dedicated Robinhood foundation workflow therefore uses `npm install --package-lock=false` only to exercise source tests/builds without altering committed lockfiles. The existing main PR gate remains unchanged and its `npm ci` failure remains visible; this branch does not hide or rewrite that baseline issue.

## Current official Robinhood network facts

- Robinhood Chain mainnet chain ID: `4663`
- Robinhood Chain testnet chain ID: `46630`
- Native gas asset: `ETH`
- Mainnet public RPC: `https://rpc.mainnet.chain.robinhood.com`
- Testnet public RPC: `https://rpc.testnet.chain.robinhood.com`
- Mainnet explorer: `https://robinhoodchain.blockscout.com`
- Testnet explorer: `https://explorer.testnet.chain.robinhood.com`

Public RPCs are development/fallback endpoints only; production should use provider-backed endpoints with independent failover.
