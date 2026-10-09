---
title: Put a swap box on your website
description: Let your community buy and sell your Solana coin on your own website, and earn half of the trading fee.
---

With the MemeWarzone swap box, people can buy and sell your coin straight from your own website, with their own wallet. You copy a few lines of code into your site and the box appears. You do not need to be a developer.

It works for two kinds of Solana coins:

- **Coins launched on MemeWarzone**, while they are on their bonding curve. Trades pay the same fees as on MemeWarzone and you get the same creator share.
- **Imported coins.** Every swap pays a 1% fee. **Half of it, 0.5% of every swap, goes to the coin's creator.** The other half is MemeWarzone's.

## What you need

- A Solana coin: launched on MemeWarzone (on its bonding curve) or imported. BNB Chain and Robinhood Chain come later.
- Your coin's mint address (its contract address on Solana).
- A website where you can add your own HTML code. Most site builders have a block for this, usually called **Custom HTML**, **Embed code** or **Code**.

## Add the swap box in 3 steps

### 1. Copy this code

```html
<div id="mwz-swap"></div>
<script src="https://app.memewar.zone/widget/mwz-swap.js"></script>
<script>
  MemeWarzoneSwap.mount("#mwz-swap", { mint: "YOUR_TOKEN_MINT" });
</script>
```

### 2. Put in your coin

Replace `YOUR_TOKEN_MINT` with your coin's mint address. Keep the quotes around it.

### 3. Paste it into your website

Add a Custom HTML (or Embed code) block where you want the box, paste the code and publish the page.

That's it. Your visitors connect their wallet in the box, type an amount and press **BUY** or **SELL**.

## Try it before you publish

Open this link with your own mint address at the end:

`https://app.memewar.zone/widget/example.html?mint=YOUR_TOKEN_MINT`

If the box shows your coin there, it will work on your site too.

## Get paid

For a coin launched on MemeWarzone, your creator share works exactly as on MemeWarzone: see [Creator earnings](/creators/creator-earnings).

For an imported coin, your half of the fee is collected for you from the first swap, even before you claim the coin.

1. Claim your coin on MemeWarzone. See [Import and claim a coin](/creators/imported-coins).
2. Seven days after your claim is verified, payouts start. They go automatically to the wallet that claimed the coin, in SOL.
3. A payout goes out once your balance is above about $5.

Fees are kept for 90 days per trade. Fees from trades older than 90 days that nobody claimed are not paid out, so claim early. Your coin's page on MemeWarzone shows how much is waiting for you.

## Change how it looks

You can add these settings inside the curly brackets, separated by commas:

| Setting | What it does |
| --- | --- |
| `theme: "light"` | A light box for light websites (the default is dark) |
| `side: "sell"` | Opens on SELL instead of BUY |

Example with both:

```html
<script>
  MemeWarzoneSwap.mount("#mwz-swap", { mint: "YOUR_TOKEN_MINT", theme: "light", side: "sell" });
</script>
```

## Good to know

- **Wallets:** the box works with Phantom, Solflare and Backpack. Visitors use their own wallet; MemeWarzone never holds their coins.
- **Prices:** coins launched on MemeWarzone trade on their bonding curve, the same trade as on MemeWarzone. Imported coins are routed by Jupiter, which finds the best price across Solana's markets. Before anyone confirms, the box shows what they get and the fee.
- **After graduation:** once a coin launched on MemeWarzone leaves its bonding curve, the box shows a link to its MemeWarzone page instead of trading it.
- **Safety:** the box checks every swap before the wallet opens. It only lets the wallet sign the visitor's own swap.
- **A new website:** if your site is new, Phantom may show "This domain is new or has not been reviewed yet" for a few days. That is Phantom checking your website, not the swap box. It usually goes away by itself. If it stays longer than a week, you can ask Phantom to review your site through the form in [Phantom's guide](https://docs.phantom.com/developer-powertools/domain-and-transaction-warnings).
- **Site builders that put code in a frame:** some builders run custom code inside a separate frame. Wallets do not always connect there. If the wallet does not open on your site but works on the test link above, try a different block type, or ask your developer to add the code to the page itself.

## For developers

If your site already connects a Solana wallet, pass it in with `wallet` (it needs `publicKey` and `signAndSendTransaction`). Use `onSwap` to run your own code after a confirmed swap; it receives `{ signature, side, mint }`. `slippageBps` sets the allowed price movement (default `100`, which is 1%).
