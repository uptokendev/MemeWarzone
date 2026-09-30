# Doppler option B on Robinhood Chain: fork proof

Runs the real Doppler contracts deployed on Robinhood Chain (4663) through a local fork. Nothing is sent.

```
bash setup.sh
forge test --fork-url https://rpc.mainnet.chain.robinhood.com -vv
```

## What it proved (2026-09-30, block ~76350000)

- Launch fee through RehypeDopplerHookInitializer: 50.0% at launch, 26.0% at 30 s, 2.0% after 60 s,
  on buys (fee taken in the token, sold for ETH in the pool) and sells (fee taken in ETH).
- Our fee beneficiary claims its curve fees after graduation (0.0603 ETH in the run).
- Graduation is permissionless (`Airlock.migrate`) once the price passes the far tick.
- The 22% proceeds split pays exactly: 0.408139 ETH of a 1.855385 ETH raise (21.998%).
- The graduated pool charges 0.25%, its liquidity is locked with recipient 0xdead and stays locked
  ten years on. LP fees pay by share (2 ETH buy: creator 0.00375, us 0.00075).

## Two findings that change the design

1. **The proceeds split reverts today.** DopplerHookMigrator calls its TopUpDistributor
   (`0x46adee7595d48b1Ec53090e9bc78e1E69Fa0eF06`) whenever a split is configured, and
   `canPullUp(DopplerHookMigrator)` is false on chain, so every graduation with a split reverts
   `SenderCannotPullUp()`. Only the Airlock owner (Whetstone's Safe `0x21E2…7A66`) can call
   `setPullUp(migrator, true)`. Without a split, graduation works today.
2. **Whetstone takes 10% of graduated LP fees, not 5%.** The migrator requires the Airlock owner at
   >= 5% and the locker requires its own owner (`0xEDeAa06E2eB42A5c19ce27c6cfFb36fd4fE1eDa8`, an EOA)
   at >= 5%. A list without both reverts `InvalidProtocolOwnerBeneficiary()`. The proof uses
   creator 75 / us 15 / 5 / 5.
