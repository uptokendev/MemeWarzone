---
title: After Graduation
description: Fees on graduated coins and imported coins: DEX pool fees, the 80/20 split of locked liquidity, and the swap fee on imported coins.
---

Once a coin graduates it trades in a DEX pool instead of on the bonding curve. The 2% trade fee stops. The pool charges its own fee, and MemeWarzone shares in it through the locked liquidity.

## Pool fees on graduated coins

At graduation the coin's liquidity goes into a DEX pool and is locked for good. Nobody can withdraw it, including MemeWarzone and the creator.

| Chain | Pool | Fee on every swap after graduation |
| --- | --- | --- |
| BNB Chain | Uniswap V4 | 1%: 0.5% to the creator side, 0.5% to MemeWarzone |
| Robinhood Chain | Uniswap V4 | 1%: 0.5% to the creator side, 0.5% to MemeWarzone |
| Solana | Meteora DAMM v2 | 0.25%, collected in SOL: 80% to the creator side, 20% to MemeWarzone |

Coins on BNB Chain and Robinhood Chain that graduated before the current launch contracts keep their old pools (Topaz on BNB Chain, Uniswap V3 on Robinhood Chain), where the pool fees are split 80% to the creator side and 20% to MemeWarzone.

The creator side follows the creator's fee choice from launch:

- **Keep:** on Solana the creator owns 80% of the locked position and claims its fees. On BNB Chain and Robinhood Chain the creator side is paid to the creator.
- **Holders, Split or Buyback:** MemeWarzone collects the fees and pays the 80% into the coin's creator pot, which goes to holders, the creator or a buyback as chosen.

## Imported coins

Imported coins trade in their own DEX pools. MemeWarzone adds a platform fee to the swap, shown in the quote before you confirm.

| Chain | Fee | Split |
| --- | ---: | --- |
| Solana | 1% | 0.5% to the coin's creator, 0.5% to MemeWarzone |
| BNB Chain | 1% | 0.5% to the coin's creator, 0.5% to MemeWarzone |
| Robinhood Chain | 1% | 0.5% to the coin's creator, 0.5% to MemeWarzone |

The whole fee is collected in the swap and split afterwards, so the swap itself stays one simple transaction.

The creator's half also builds up while a coin is not yet claimed. It is held for 90 days per trade. Claim the coin within that time to collect it. What is still unclaimed after 90 days goes to MemeWarzone. Read **[Imported Coins](/creators/imported-coins)**.

Swaps through the swap box on a creator's own website pay the same fees. Read **[Swap box for your website](/creators/swap-widget)**.

Read next: **[Fee Examples](/fees/examples)**.
