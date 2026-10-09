# Test stack env for `build/evm-gen7` (testnets 97 and 46630)

Written 2026-10-09 from `deployments/bscTestnet/testnet.gen7.json`, `deployments/robinhood/testnet.gen7.json`,
`deployments/*/testnet.import-fee-vault.json` and `deployments/robinhood/testnet.native-swap-adapter-v2.json`.
These are ADDITIONS or CHANGES to the env the test API, indexer and app already have. Keys are never written
here: `<secret>` values go straight into Coolify. Order after setting: indexer, then API, then app (rebuild).

Start blocks: BNB gen-7 factory 135763617 (fees stack deployed just before it; no events before the factory),
Robinhood gen-7 factory 131592000 (first factory setter at 131592712). Import vaults: 97 at 135763855,
46630 at 131595355.

## Database (staging)

Done 2026-10-09: `database/staging_apply_2026_10_04_catchup.sh apply` (15 files incl. analytics rollups,
holder batches per vault, watchdog state); read-only check afterwards: nothing missing, `evm_holder_batches` keyed
(chain_id, vault_address, week_id). `20261008_000020_import_creator_fees.sql` was already on staging.

## Indexer

| Name | Value |
|---|---|
| `FACTORY_ADDRESS_97` | `0xc82cE828F3e5C7B9D75CF27bcd6f2Dca067fa122` |
| `FACTORY_ADDRESS_46630` | `0xAFe0931A9C355f6502a4711A8aDAb17Bcc887420` |
| `SUPPORTED_FACTORY_ADDRESSES_97` / `_START_BLOCKS_97` | append `0xc82cE828F3e5C7B9D75CF27bcd6f2Dca067fa122` / `135763617` to the existing lists |
| `SUPPORTED_FACTORY_ADDRESSES_46630` / `_START_BLOCKS_46630` | append `0xAFe0931A9C355f6502a4711A8aDAb17Bcc887420` / `131592000` |
| `EVM_GEN7_ROUTER_97` | `0x8104Aefade6e709AC7390e5BC6004553C9a3f0bE@135763617` |
| `EVM_GEN7_CREATOR_VAULT_97` | `0x1dEaCe42107c005502D1fAdac0768ad994AeE2E6@135763617` |
| `EVM_GEN7_HOLDER_DISTRIBUTOR_97` | `0x1E70e12AAB572f17F0F3edA4a194D8643E4A3a49@135763617` |
| `EVM_GEN7_COMMUNITY_VAULT_97` | `0xa5D36eB36b46D0a8f1D6e1162a54183F48AF331C` |
| `EVM_GEN7_ROUTER_46630` | `0xCAEAD59159DC3f1Ed49e92A189Ac549FC50A41a9@131592000` |
| `EVM_GEN7_CREATOR_VAULT_46630` | `0xf17BAa78684c28C749A1a9491eBbE95C0d968899@131592000` |
| `EVM_GEN7_HOLDER_DISTRIBUTOR_46630` | `0x62920101e8c2BF3a99ED870e5FE9728c6EE9d0A8@131592000` |
| `EVM_GEN7_COMMUNITY_VAULT_46630` | `0x81e08aF4D18ca9338c53a2fE8bEf55E37ee5d750` |
| `EVM_GEN5_LP_LOCKERS_97` | append `0xB4E8C52e1b57e3460A966960a24d944c923Dcf55@135763617` (keeper harvest) |
| `EVM_GEN5_LP_LOCKERS_46630` | append `0x1dbbb94F046e0A47c5499a781066E4b0c16486B5@131592000` |
| `IMPORT_FEE_EVM_WORKER_ENABLED` | `true` |
| `IMPORT_FEE_EVM_CHAINS` | `97,46630` |
| `IMPORT_FEE_PAYOUT_SEND` | `false` for the first day (dry run), then `true` |
| `IMPORT_FEE_PAYOUT_OPERATOR_PK_97` | `<secret>` the key of `0xCB83b1297E4198e37bBf050eE9Cb6E87E8252aD1` (operator on the 97 vault) |
| `IMPORT_FEE_PAYOUT_OPERATOR_PK_46630` | `<secret>` the key of `0x03F9deC9961033c0CaA7a66373B004D36D375e83` |
| `IMPORT_FEE_VAULT_97` / `IMPORT_FEE_VAULT_START_BLOCK_97` | `0x9BBacC8DefDc48ECE6254Eb110D7f1CC0ffCFC38` / `135763855` |
| `IMPORT_FEE_VAULT_46630` / `IMPORT_FEE_VAULT_START_BLOCK_46630` | `0x69aDe0154bF38b86F538d07046D131CC2A6150B6` / `131595355` |
| `PROTOCOL_REVENUE_VAULT_ADDRESS_97` | `0xa1b2e68469d042d3A641251851825AdAcD4291B5` (testnet protocol vault; needed for the expiry sweep) |
| `PROTOCOL_REVENUE_VAULT_ADDRESS_46630` | `0xf14dbfC92BCF313362668bD9fea42F9a23f0712b` |

Not on testnets: the payout watchdog (`PAYOUT_WATCHDOG_*`): 97 and 46630 have no Safe (the deployer is admin), so
holder batches there are approved by the deployer as today.

## API

| Name | Value |
|---|---|
| `VITE_FACTORY_ADDRESS_97` and `FACTORY_ADDRESS_97` | `0xc82cE828F3e5C7B9D75CF27bcd6f2Dca067fa122` (the create signer reads the `VITE_` name first) |
| `VITE_FACTORY_ADDRESS_46630` and `FACTORY_ADDRESS_46630` | `0xAFe0931A9C355f6502a4711A8aDAb17Bcc887420` |
| `EVM_GEN7_ROUTER_97`, `EVM_GEN7_CREATOR_VAULT_97`, `EVM_GEN7_HOLDER_DISTRIBUTOR_97`, `EVM_GEN7_COMMUNITY_VAULT_97` | same values as the indexer |
| `EVM_GEN7_ROUTER_46630`, `EVM_GEN7_CREATOR_VAULT_46630`, `EVM_GEN7_HOLDER_DISTRIBUTOR_46630`, `EVM_GEN7_COMMUNITY_VAULT_46630` | same values as the indexer |
| `EVM_GEN7_LOCKER_97` | `0xB4E8C52e1b57e3460A966960a24d944c923Dcf55` (LP fee harvest crank) |
| `EVM_GEN7_LOCKER_46630` | `0x1dbbb94F046e0A47c5499a781066E4b0c16486B5` |
| `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_97` | `0xa5D36eB36b46D0a8f1D6e1162a54183F48AF331C` (airdrop pool total) |
| `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_46630` | `0x81e08aF4D18ca9338c53a2fE8bEf55E37ee5d750` |
| `IMPORT_FEE_VAULT_97` / `IMPORT_FEE_VAULT_START_BLOCK_97` | as the indexer |
| `IMPORT_FEE_VAULT_46630` / `IMPORT_FEE_VAULT_START_BLOCK_46630` | as the indexer |
| `IMPORT_SWAP_FEE_ROUTER_97` | `0x6685726f147562de5815229Aa9f85F94cB903fa5` (Topaz fee router, attribution) |

## Weekly airdrop job (if it runs on the test stack)

| Name | Value |
|---|---|
| `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_97` / `REWARD_DISTRIBUTOR_ADDRESS_GEN7_97` | `0xa5D36eB36b46D0a8f1D6e1162a54183F48AF331C` / `0x24B25154aBC6E2777A881db67e9289FaEf7372fC` |
| `COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_46630` / `REWARD_DISTRIBUTOR_ADDRESS_GEN7_46630` | `0x81e08aF4D18ca9338c53a2fE8bEf55E37ee5d750` / `0xD3237DA9014816c27dAc8bfFbF9f8b3a58588540` |

Set both of a pair or neither. On testnets the gen-7 pot's airdrop operator is the deployer.

## App (build-time `VITE_*`, then rebuild)

| Name | Value |
|---|---|
| `VITE_FACTORY_ADDRESS_97` | `0xc82cE828F3e5C7B9D75CF27bcd6f2Dca067fa122` |
| `VITE_FACTORY_ADDRESS_46630` | `0xAFe0931A9C355f6502a4711A8aDAb17Bcc887420` |
| `VITE_SUPPORTED_FACTORY_ADDRESSES_97` / `_46630` | the existing lists plus the gen-7 factory, so gen-6 coin pages keep resolving |
| `VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_97` | `0x5AD66B63989379888294b904eA4973826305077A` |
| `VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_46630` | `0xE3890bC30Bf0D47c3f2BfBf168998D0515Bbe803` |
| `VITE_IMPORT_SWAP_FEE_ROUTER_97` | `0x6685726f147562de5815229Aa9f85F94cB903fa5` (Topaz-only imports on 97 trade with the 1% fee; unset = no in-app swap) |
| `VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_46630` | `0xbD23Ad6bb1D79f1e61A5BB8f8a386f35Af6FC151` (fixed swap adapter) |
| `VITE_ALLOWED_CHAIN_IDS` | must include `97` and `46630` on the test app |

Leave `VITE_TREASURY_ROUTER_ADDRESS_<id>` and `VITE_PERMANENT_LP_LOCKER_ADDRESS_<id>` as they are: they are display
only and gen-6 coins still use the gen-6 ones; gen-7 coins read their own from the factory.

## Check after the redeploy

- Indexer log: the gen-7 factories appear in the scan; `[evm-grad] enabled` lines for 97 / 46630.
- API: `GET /api/evm/campaign-state?chainId=97&campaign=<a gen-7 coin from reports/bnb-testnet-gen7-lifecycle.json>`
  answers `economics.generationKind: "gen7"`.
- App: the create page on 97 / 46630 shows "Graduation market cap" with $30K / $50K / $150.
