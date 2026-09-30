# DogeOS build plan

Work branch: `grok/dogeos-chikyu` off `build/robinhood-full-expansion`. One PR into that branch. Do not merge to `main`. Do not push to `build/cross-chain-stabilization-rh-base` unless the founder asks.

Parity contract and facts: [README.md](./README.md). Env names: [coolify-env-skeleton.env](./coolify-env-skeleton.env).

No on-chain send without an explicit founder go. No production DB writes — hand over SQL.

---

## Phase A — chain identity (this PR)

Landed on `grok/dogeos-chikyu`. No contracts, no SDK login, no Coolify live flag.

1. Registry: `dogeos-testnet`, chain ID `6281971`, native `DOGE`, explorer L2Scan, RPC env `VITE_PUBLIC_RPC_6281971`.
2. `isDogeosChainId` / `isEvmChainId` includes 6281971. `getNativeSymbol` / `nativeSymbolFor` / graduation `nativeSymbol` return `DOGE`. Provider key `dogeos-basic`. Native launch quote on 6281971.
3. DOGE/USD reader (Binance `DOGEUSDT`, same shape as BNB/ETH/SOL) wired into `arenaNativeUsdFeed`.
4. Hardhat network `dogeosTestnet` (RPC from `DOGEOS_TESTNET_RPC_URL` / `DOGEOS_TESTNET_RPC`).
5. Indexer: `ENV.DOGEOS_RPC_HTTP_6281971`, `CHAINS` + `factoryDiscovery` rows gated on a usable RPC (empty = absent, same as 4663).
6. `.env.example` placeholders. Coolify skeleton in this folder (addresses empty).
7. MWL / arena identity lists include 6281971. Generation-pair table gets a 6281971 slot only when a factory exists — leave empty until Phase C.
8. Tests that pin chain lists and native symbols.
9. Staging SQL migration adding `6281971` to chain CHECKs (founder applies production).

`$6` graduation allowlist on `LaunchFactory` waits for Phase C so we do not change money-path bytecode until we are compiling for a DogeOS deploy.

## Phase B — MyDoge SDK

Depends on a real `VITE_DOGEOS_CLIENT_ID`.

1. `npm install @dogeos/dogeos-sdk@4.0.0 wagmi` in `frontend/`.
2. `WalletConnectProvider` only on the DogeOS connect path. BNB/RH keep EIP-6963.
3. Wrap SDK EIP-1193 `currentProvider` as `EvmWalletSession`.
4. Theme SDK modal to Warzone dark. Metadata: MemeWarzone, `https://app.memewar.zone`.
5. MyDoge badge from `currentWallet.info.name` once confirmed.
6. Register origins with Sira. Test login, signing, network switch, balances.

## Phase C — contracts (closed)

Reuse the current EVM generation. Native path only (no Robinhood stock campaign).

1. Compiler stays 0.8.24 unless Chikyū rejects it; then a DogeOS-only 0.8.30/prague profile.
2. Allow `$6` test graduation on chain id 6281971.
3. Deploy script sibling of Robinhood generation: factory, campaign impl, router V3 + vaults, locker, league, war pool, registries. Owner = deployer EOA (no Safe on Chikyū).
4. Native graduation adapter **after** Hoff names the DEX.
5. Lands `createPaused`, `live=false`, war-pool deposits paused. Never `enableLive` in the script.

## Phase D — Chikyū canary

Same proofs as BSC testnet / RH46630: create → buy → sell → creator claim; one battle (open, both stakes, signed boost, resolve, three claims); indexer continuity. Graduation + harvest when the DEX adapter exists.

## Phase E — app, indexer, Coolify

Fill the skeleton addresses. Generation pairs `4/3` (or whatever the factory reports). Arena flags, vote treasury, recruiter ledger `dogeos` + `6281971`. Opt-in `VITE_ALLOWED_CHAIN_IDS` on staging first.

## Phase F — mainnet

When DogeOS publishes a chain ID, Safe, canonical wrapper, DEX, and EVM target. Config promotion of the same code. Chikyū stays.
