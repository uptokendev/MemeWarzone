# DogeOS — MemeWarzone brief

Source of truth for bringing DogeOS onto MemeWarzone as a fourth EVM family (same product as BNB and Robinhood, native **DOGE**, plus MyDoge via the DogeOS SDK).

Captured 2026-09-30 from DogeOS (Hoff, Sira / `@sira_web3`) and founder Patrick. Folder lives under `docs/build_plans/` (gitignored by default); this PR force-adds it.

**Status 2026-09-30:** Phase A (chain identity, native DOGE, no SDK, no contracts) is on `grok/dogeos-chikyu`. Phase B waits on Sira’s `clientId`. No on-chain send. Staging SQL is `db/migrations/20260930_000001_dogeos_chain_identity.sql` (founder applies production).

| Companion | Purpose |
|---|---|
| [coolify-env-skeleton.env](./coolify-env-skeleton.env) | App / API / indexer env names, modeled on the Robinhood 4663 Coolify block |
| [build-plan.md](./build-plan.md) | Phased implementation |

---

## Locked product contract

DogeOS is protocol-identical to BNB and Robinhood at the product/rules layer. Chain-specific code may change how a transaction is executed. It does not change what the transaction means.

A creator, trader, recruiter, or squad member switching BNB → Solana → Robinhood → DogeOS sees the same flows, rules, protections, thresholds, statuses, reward logic, pages, and terminology. The things that differ:

- native asset: **DOGE**
- wallet: DogeOS SDK (MyDoge + browser wallets + social login) on this chain; existing EIP-6963/MetaMask path stays for BNB and Robinhood
- explorer, RPC, DEX implementation (DEX still unnamed)
- chain-specific transaction details (zkEVM fees, finality tags)

Chikyū is permanent staging. Mainnet, when it exists, is a config promotion, not a cleanup that deletes testnet.

Bonding stays in **native DOGE**. Graduation liquidity stays configurable until Hoff names the DEX and the canonical wrapper. Quote-token faucet assets are not graduation markets.

---

## Network — DogeOS Chikyū Testnet

There is no mainnet and no announced launch date. Hoff: Chikyū should not reset. Upcoming testnet upgrade may use `evmVersion: "osaka"`; today `prague` is recommended.

| Field | Value |
|---|---|
| Name | DogeOS Chikyū Testnet |
| Chain ID | `6281971` |
| Native | DOGE (18 decimals — SDK + docs) |
| HTTP RPC | `https://rpc.testnet.dogeos.com` |
| WS RPC | `wss://ws.rpc.testnet.dogeos.com` |
| Unifra public RPC | `https://dogeos-testnet-public.unifra.io/` |
| Unifra console | `https://console.unifra.io/` |
| Explorer (SDK default) | `https://dogeos-testnet.l2scan.co` |
| Explorer (Blockscout) | `https://blockscout.testnet.dogeos.com` |
| Verify API | `https://dogeos-testnet.l2scan.co/api` (Blockscout-style) |
| Faucet | `https://faucet.testnet.dogeos.com` |
| Dev portal | `https://portal.testnet.dogeos.com` |
| Docs | `https://docs.dogeos.com` |
| Developer quickstart | `https://docs.dogeos.com/en/developers/developer-quickstart` |

Hardhat verify custom chain:

```
apiURL: https://dogeos-testnet.l2scan.co/api
browserURL: https://dogeos-testnet.l2scan.co/
```

Foundry: `--verifier-url https://dogeos-testnet.l2scan.co/api/ --verifier blockscout --chain-id 6281971`.

---

## Official faucet tokens (this Chikyū cycle)

Temporary testnet assets. Do not assume they survive as canonical mainnet wrappers. Decimals / proxy-admin were not supplied; we asked only for ERC-20 behaviour, decimals, and address stability for the current cycle.

| Symbol | Address | Notes |
|---|---|---|
| WDOGE | `0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE` | **Not** the canonical native wrapper. Hoff: testnet asset; no standard deposit/withdraw assumption. |
| LBTC | `0x29789F5A3e4c3113e7165c33A7E3bc592CF6fE0E` | |
| WETH | `0x1a6094Ac3ca3Fc9F1B4777941a5f4AAc16A72000` | |
| USD1 | `0x25D5E5375e01Ed39Dc856bDCA5040417fD45eA3F` | |
| USDC | `0xD19d2Ffb1c284668b7AFe72cddae1BAF3Bc03925` | |
| USDT | `0xC81800b77D91391Ef03d7868cB81204E753093a9` | |

---

## SDK / MyDoge Wallet

This is the one product difference versus BNB and Robinhood.

| Item | Value |
|---|---|
| Package | `@dogeos/dogeos-sdk@4.0.0` |
| Docs | https://docs.dogeos.com/en/sdk |
| Demo | https://github.com/DogeOS69/dogeos-sdk-demo |
| Register / client ID | https://sdk.dogeos.com/register |
| Peers | React ≥18, React DOM ≥18, **wagmi ≥2** (peer even if we only use SDK hooks) |

Sira first sent `@dogeos/dogeos-sdk@3.3.0-beta.3`. Hoff/Sira later: use **v4**. v4 release notes: improved login/session handling, restored EVM balance / gas-estimation / transaction-count reads, Dogecoin balance queries.

### How it works

- Dedicated SDK connector (Hoff). Not a raw WalletConnect session from MyDoge, and not a bare EIP-1193 injected provider from MyDoge.
- Wallet aggregator: MyDoge Wallet + major browser wallets + social login (email, Google, X). DogeOS manages authentication. Keep the registered `clientId`. Do not pass custom Google/X client IDs or service overrides.
- Embedded-wallet users keep the **same address across DogeOS apps**.
- Opening a dApp from the MyDoge mobile wallet can connect automatically.
- Production login/wallet services stay production even when the configured chain is Chikyū.
- `clientId` is public (browser bundle). Each app origin must be registered including scheme, hostname, and port. `http://localhost:5173` and `http://localhost:3000` are different origins. `localhost` and `127.0.0.1` are different hosts.
- Founder signed up. Sira will issue MemeWarzone **development, staging, and production** client IDs.

### Integration shape (agreed)

Do not replace MetaMask/EIP-6963 on BNB or Robinhood.

When the selected chain is DogeOS, Connect opens `WalletConnectProvider` / `openModal()`. The SDK’s EVM `currentProvider.request()` is EIP-1193 and becomes the existing `EvmWalletSession`, so create / buy / sell stay on the current transaction path.

`useAccount().currentWallet?.info?.name` is the candidate “this is MyDoge” identifier. Confirm the exact string at integration. `useConnectors()` exposes EVM / Dogecoin / Solana provider families.

### Deep links

Hoff: individual-dApp deep links are not supported yet; the functionality is mostly in place and will land later. Not a launch blocker. Users can open MemeWarzone through MyDoge Explorer and auto-connect.

### MyDoge perks (founder)

- Auto-connect when opened from MyDoge
- Connected-wallet badge when the SDK reports MyDoge
- Native DOGE branding on this chain
- Later: deep links to specific MemeWarzone pages

Explorer exists (Hoff: the earlier “no explorer in the wallet” note was a miscommunication). SDK default explorer is L2Scan.

---

## Infra, fees, finality

### RPC

Hoff: public RPC will be rate-limited and will likely still support WebSockets. For developer / production usage, use an infrastructure partner. Candidates before launch: **Unifra, dRPC, Ankr**. Keep the public RPC as emergency fallback only.

Exact HTTP/WS rate limits, `eth_subscribe` set, and `eth_getLogs` range: not published. Ask Unifra/dRPC/Ankr for dedicated endpoints.

### Block tags (Hoff: they work)

Founder indexer policy (not a delayed on-chain tx; this is when the backend treats an event as irreversible):

| Tag | Use |
|---|---|
| `latest` | Show a trade immediately as provisional |
| `safe` | Live charts, standings, provisional reward calculations |
| `finalized` | Graduation records, reward accruals, battle settlement, claims |

### zkEVM facts (docs)

- Bytecode-equivalent EVM for typical Solidity. Scroll-like L2.
- Max reorg depth **17**. Absolute ordering after a proof + Dogecoin withdrawal fulfillment.
- `COINBASE` / `block.coinbase` = pre-deployed fee vault.
- `DIFFICULTY` / `PREVRANDAO` = 0.
- `SELFDESTRUCT` reverts (will later follow Ethereum).
- No EIP-4844 opcodes (`BLOBHASH`, `BLOBBASEFEE`). No EIP-4788 beacon root.
- Unsupported precompiles (calls revert): RIPEMD-160 (`0x3`), blake2f (`0x9`), point evaluation (`0x0a`). `modexp` inputs ≤ 32 bytes (`u256`). Supported: `ecPairing`, `ecRecover`, `identity`, `ecAdd`, `ecMul`.
- Sequencer aims to order by tip; under low congestion, first-come-first-served.

### Fees (all native DOGE)

`totalTxFee = executionFee + dataAndFinalityFee`

- Execution: `gas_used * effective_gas_price` (same as Ethereum).
- Data and finality: calldata posted to Ethereum DA + Dogecoin bridge. Estimated via Scroll `L1GasPriceOracle` at `0x5300000000000000000000000000000000000002` (`getL1Fee(bytes)`). Once the sequencer processes a tx, the L1 fee is locked.

Fees collect in `L2FeeVault`. `COINBASE` returns that vault.

### Solidity / compiler

| Source | Position |
|---|---|
| DogeOS docs | Prague-compatible. Avoid Solidity **&lt; 0.8.30**. Use `evmVersion: "prague"`. |
| Hoff | Use the latest Solidity. Prague today; Osaka after the next testnet upgrade. Older compilers are acceptable. |
| This repo | Hardhat `solidity.version = "0.8.24"`, no `evmVersion` pin. |

Do not retarget BNB or Robinhood artifacts. Stay on 0.8.24 for the shared contract set. If a Chikyū deploy proves the zkEVM rejects that bytecode, add a **DogeOS-only** compiler profile (`0.8.30` + `prague`) without rebuilding existing chain artifacts.

### Safe / ownership

Safe is **not** on Chikyū. Hoff: Safe will be on mainnet. Testnet ownership stays on a deployer EOA until then. Everything still lands closed (`createPaused`, war-pool deposits paused), same as BNB/RH testnet.

### DEX / graduation

Hoff: several DEXes are being built; he will connect MemeWarzone with one when ready. Founder asked for anti-sniper security. Do not invent an adapter. Native factory can deploy without it; nothing graduates until the DEX exists.

### Oracle

Chainlink CCIP has been listed on Chikyū in a Chainlink expansion note. An on-chain **DOGE/USD Data Feed** address is unconfirmed. `GraduationOracle.maxPriceAge` is immutable. App-side native USD can use Binance `DOGEUSDT` the same way BNB/ETH/SOL already do.

---

## Test funds

Patrick sent Sira `0xb989A99823eA96552c3E3198A40CdBF682EDf1aA`. Sira sent a bunch of test DOGE (and pointed at WDOGE).

That address is the **production EVM route authority**. Keep it as the faucet recipient unless the founder says otherwise. Do not make it the DogeOS deployer or a protocol wallet. Prefer a dedicated Chikyū deployer key; reuse `0xb989…` as route authority once that role exists on DogeOS.

---

## Hoff / Sira answers (2026-07-14 → 07-15)

Q: MyDoge → dApp connection flow?  
A: Dedicated SDK. Sira shares access.

Q: Mobile deep links / return-to-dApp?  
A: Not supported yet; mostly in place; later.

Q: Dev / staging / production client IDs?  
A: Yes. Sira.

Q: Can the SDK say the wallet is MyDoge?  
A: Asked of Sira. Integration candidate: `currentWallet.info.name`.

Q: RPC rate limits, subscriptions, `eth_getLogs`?  
A: Public RPC rate-limited, likely WS. Use Unifra / dRPC / Ankr for real work. Exact numbers not published.

Q: `safe` / `finalized` tags and confirmation policy?  
A: Tags work. Founder policy is the table above (provisional vs irreversible indexing).

Q: Solidity 0.8.30 + prague mandatory?  
A: Latest Solidity. Prague today, Osaka after upgrade. Older is acceptable.

Q: Will Chikyū reset? Mainnet-compatible RC?  
A: Should not reset. No mainnet date.

Q: Token metadata / decimals / proxy?  
A: First team to ask. We clarified we only need decimals, ERC-20 behaviour, and address stability for this cycle.

Q: Is WDOGE the canonical wrapper with deposit/withdraw?  
A: No. Testnet asset.

Q: Safe on Chikyū / mainnet?  
A: Not on testnet. Safe on mainnet.

Q: Larger test DOGE allocation?  
A: Yes. Wallet sent; Sira funded it.

Sira on the SDK: aggregator for MyDoge + browser wallets + social accounts (same address across apps). Opening a dApp from MyDoge mobile can auto-connect.

---

## Contacts

| Who | Role |
|---|---|
| Hoff | DogeOS |
| Sira (`@sira_web3`) | SDK, client IDs, test tokens |
| Patrick | Founder, MemeWarzone |
| Sven | Co-founder, head dev |
| Dough | Marketing |

---

## Coolify env mapping

Robinhood mainnet app block (`docs/build_plans/coolify-env/app.memewar.zone.env` lines 25–45) is the template. Same names, chain suffix **`_6281971`**. Addresses stay empty until a Chikyū deploy. See [coolify-env-skeleton.env](./coolify-env-skeleton.env).

DogeOS-only extras:

```
VITE_DOGEOS_CLIENT_ID=
VITE_PUBLIC_RPC_6281971=https://rpc.testnet.dogeos.com
VITE_WRAPPED_NATIVE_ADDRESS_6281971=   # do not pin faucet WDOGE as canonical
```

`VITE_ALLOWED_CHAIN_IDS` gains `6281971` only on environments that have matching RPC and (later) contract wiring. Same opt-in pattern as Robinhood.

---

## Repo landmines (must fix as identity, not as copy)

These currently treat “not BNB and not Robinhood” as BNB, or throw:

- `frontend/src/lib/chainConfig.ts` — `SupportedChainId` is `56 | 97 | 101 | 4663 | 46630`. `isEvmChainId` omits DogeOS. `getNativeSymbol` falls through to `"BNB"`.
- `frontend/api/lib/chainNative.js` — `nativeSymbolFor` throws on unknown chains.
- `frontend/src/lib/graduationMarketPresentation.mjs` — `nativeSymbol` / `nativeProviderKey` fall through to BNB / `bnb-basic`. `EVM_NATIVE_LAUNCH_CHAIN_IDS` is `{56, 97, 4663, 46630}`.
- `frontend/api/lib/arenaNativeUsdFeed.mjs` — no DOGE reader.
- `frontend/api/lib/arenaMwlChainIdentity.mjs` — chain list `56, 97, 101, 4663, 46630`.
- `realtime-indexer/src/indexer.ts` / `factoryDiscovery.ts` / `env.ts` — no 6281971.
- `hardhat.config.ts` — no `dogeosTestnet` network.
- `contracts/LaunchFactory.sol` — `$6` test graduation only on `97` and `46630`.
- DB CHECKs (e.g. `20260909_000002_arena_mwl_three_chain_identity.sql`, recruiter `20260926_000002`) — no 6281971. Production SQL is founder-applied.

---

## Open blockers (do not invent)

1. Sira: three SDK client IDs + registered origins (`localhost` Vite, staging app, `https://app.memewar.zone`).
2. Hoff: graduation DEX with anti-sniper. Native factory can deploy; graduation cannot.
3. On-chain DOGE/USD feed address (or an agreed testnet mock + `maxPriceAge`).
4. Dedicated Chikyū deployer key.
5. Mainnet chain ID, Safe, canonical WDOGE, mainnet EVM target (prague vs osaka).
