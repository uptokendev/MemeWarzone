---
title: Import and claim a coin
description: Bring an existing memecoin to MemeWarzone, get it listed, claim it as the owner, and run its coin page.
---

You can bring a memecoin that was launched somewhere else to MemeWarzone. It gets the same coin page as a coin launched here, people can trade it from that page, and the real owner can claim it.

![An imported coin page with the same Buy and Sell panel](/images/docs/imported-coin-page.png)

## Which coins can be imported

- The coin is on a chain MemeWarzone supports: BNB Chain, Solana, or Robinhood Chain.
- The coin has finished its bonding phase on the platform where it launched. A coin that is still bonding on Pump.fun, Four.meme or a similar launchpad is refused. Come back after it graduates.
- The coin trades in a DEX pool with real liquidity.
- The token passes the safety checks.

Anyone can import a coin. Your wallet signs the import request, but it does not need to hold or own the token.

## Import a coin

1. Open **Import memecoin** in the menu. You can also start it from Command Center, **My coins**, **Import memecoin**.
2. Choose the chain: BNB, Solana or Robinhood.
3. Connect a wallet on that chain.
4. Paste the coin's contract address (on Solana, the mint address).
5. Press **IMPORT MEMECOIN** and sign the message in your wallet. This is a signature, not a transaction. It costs nothing.

MemeWarzone looks up the token, checks its market and runs the safety scan. When that passes, you land on the coin's new page.

## What the checks look at

| Check | What it means |
| --- | --- |
| Token identity | The address is a real token on the chain you chose |
| Market stage | The coin is no longer bonding and has a funded DEX pool |
| Token safety | The token can be sold and moved freely |

An import is refused when the scan finds a problem that cannot be overridden:

- the address is not a token
- selling fails (a honeypot)
- the token cannot be transferred, or transfers are paused
- the transfer tax is above 10%

Some findings do not refuse the import but send it to review, for example when the scan could not finish or the market data is unclear. The page exists, but the coin is not listed until the review is done. If the lookup is busy, nothing is rejected. Press IMPORT again.

## Where imported coins show up

Once a coin is listed it appears:

- in **Search**, by ticker, name or address
- in the **Imported coins** panel on Coins
- in the **War Trade Room**, under the **Imported** tab and ranked with other coins under **Trending**
- as a coin card with a Buy button when someone mentions its address in a post

## Trading an imported coin

An imported coin has the same Buy and Sell panel as a coin launched here. The difference is underneath: the trade runs in the coin's own DEX pool, not on a MemeWarzone bonding curve.

| Chain | Where the trade runs |
| --- | --- |
| Solana | Jupiter, which routes through the coin's pools |
| BNB Chain | PancakeSwap pools |
| Robinhood Chain | Uniswap |

The coin page shows a "Trading on" line with the DEX, and the button says which DEX it uses, for example **Buy on Jupiter**. A platform fee (0.5% today) is included in the quote and shown in the panel. Read the quote before you confirm.

Trading is switched off on a coin when the safety scan reports a honeypot or a blocked transfer.

## Claim a coin as its owner

An imported coin starts unclaimed. Trading does not wait for the claim.

If you run the project, open the coin page and press **CLAIM MEMECOIN**. The claim popup shows the ways you can prove it. Which ones you see depends on the chain and on the token.

### Verify the owner wallet (BNB Chain and Robinhood Chain)

MemeWarzone reads the current owner of the token contract. Connect that wallet and press **VERIFY BNB OWNER WALLET** or **VERIFY ROBINHOOD OWNER WALLET**. If the contract has no active owner, this option is not available. Use X or manual review instead.

### Verify the project authority wallet (Solana)

The popup shows the recorded project authority for the token. Connect that wallet and press **VERIFY PROJECT AUTHORITY**.

Got a Pump.fun coin? Pump.fun may have created a separate wallet for you when you signed up, which can differ from the Phantom or Solflare wallet you normally use. The import page has a short guide for finding that wallet. Never paste a private key or recovery phrase into MemeWarzone, a chat or a support form.

### Verify with the project X account

When the token lists an official X account, the popup shows it. Press **VERIFY WITH X** and sign in to that exact X account. Signing in with a different X account fails.

### Request manual review

If none of the above works, press **REQUEST MANUAL REVIEW** and give an X account where the MemeWarzone team can reach you. This does not verify you automatically. The team checks the claim and contacts you.

Not the owner? Close the popup. The real owner can claim the coin later.

## What the owner can do after the claim

Once the claim is verified, connect the owner wallet and you can:

- press **EDIT** on the coin page to change the description, website, X and Telegram links, and upload the project image
- open **Edit page** from Command Center, **My coins**, to set tags, links, a pinned post, the Story text and the Story images, and choose whether your updates go to the home feed
- post updates as the coin in the **Posts** tab, and share them to the home feed
- turn auto updates (launch, graduation and battle results) on or off on the same Edit page
- challenge other coins to battles

The coin's name and ticker come from the token itself and cannot be changed. Every edit is signed by your wallet. A signature is not a transaction and costs nothing.

Read **[Coin pages and creator updates](/social/creator-updates)** for posting, and **[Live Battles](/arena/live-battles)** for battles.
