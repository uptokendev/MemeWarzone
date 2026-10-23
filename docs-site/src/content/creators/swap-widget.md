---
title: Put a swap box on your website
description: Let your community buy and sell your coin on Solana, BNB Chain or Robinhood Chain on your own website, and earn half of the trading fee.
---

With the MemeWarzone swap box, people can buy and sell your coin straight from your own website, with their own wallet. You copy a few lines of code into your site and the box appears. You do not need to be a developer.

It works on Solana, BNB Chain and Robinhood Chain:

- **Coins launched on MemeWarzone.** On Solana while they are on their bonding curve, and generation 8 coins on BNB Chain and Robinhood Chain before and after graduation. Trades pay the same fees as on MemeWarzone and you get the same creator share.
- **Graduated MemeWarzone coins and imported coins.** Every swap pays a 1% fee. **Half of it, 0.5% of every swap, goes to the coin's creator.** The other half is MemeWarzone's.

On BNB Chain, imported coins pay 0.5% to MemeWarzone with no creator share until the BNB fee vault is switched on. The box always shows the fee and the creator's part before anyone confirms.

## What you need

- A coin on Solana, BNB Chain or Robinhood Chain: launched on MemeWarzone or imported.
- Your coin's address: the mint address on Solana, the token contract address (0x...) on BNB Chain and Robinhood Chain.
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

On BNB Chain or Robinhood Chain, name the chain and the token instead of `mint`: `chainId: 56` is BNB Chain, `chainId: 4663` is Robinhood Chain.

```html
<script>
  MemeWarzoneSwap.mount("#mwz-swap", { chainId: 56, token: "0xYOUR_TOKEN" });
</script>
```

### 3. Paste it into your website

Add a Custom HTML (or Embed code) block where you want the box, paste the code and publish the page.

That's it. Your visitors connect their wallet in the box, type an amount and press **BUY** or **SELL**.

## Try it before you publish

Open this link with your own mint address at the end:

`https://app.memewar.zone/widget/example.html?mint=YOUR_TOKEN_MINT`

On BNB Chain or Robinhood Chain:

`https://app.memewar.zone/widget/example.html?chainId=56&token=0xYOUR_TOKEN`

If the box shows your coin there, it will work on your site too.

## Get paid

For a coin launched on MemeWarzone, your creator share works exactly as on MemeWarzone: see [Creator earnings](/creators/creator-earnings).

For an imported coin, your half of the fee is collected for you from the first swap, even before you claim the coin.

1. Claim your coin on MemeWarzone. See [Import and claim a coin](/creators/imported-coins).
2. Seven days after your claim is verified, payouts start. They go automatically to the wallet that claimed the coin, in the chain's own coin (SOL, BNB or ETH).
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

- **Wallets:** on Solana the box works with Phantom, Solflare and Backpack. On BNB Chain and Robinhood Chain it uses the visitor's browser wallet (MetaMask, Rabby and others) and adds the chain to the wallet if it is missing. Visitors use their own wallet; MemeWarzone never holds their coins.
- **Prices:** coins launched on MemeWarzone trade the same way as on MemeWarzone. Imported coins are routed by Jupiter on Solana, KyberSwap on BNB Chain and Uniswap on Robinhood Chain. Before anyone confirms, the box shows what they get, the price impact and the minimum when the route gives them, and the fee.
- **First sell on BNB Chain or Robinhood Chain:** the wallet asks for an approval before the sell. On Robinhood Chain (and for generation 8 coins) the first sell of a coin needs two one-time approvals; after that a sell is one confirmation. On BNB Chain an imported coin's sell asks to approve that sell's amount.
- **After graduation:** a graduated MemeWarzone coin trades in the box like an imported coin, with the 1% fee and your half, where the chain pays the creator's half. Where it does not yet (BNB Chain until its fee vault is on), and for older BNB Chain and Robinhood Chain coins still on their bonding curve, the box links to the coin's MemeWarzone page instead.
- **No route:** if no market can trade the coin, the box says "No route here. Trade it on its MemeWarzone page." with the link.
- **Claim link:** on an imported coin nobody has claimed yet, the box shows "Created this coin? Claim it on MemeWarzone" with a link to the claim. It goes away once the coin is claimed.
- **Safety:** the box checks every swap before the wallet opens. It only lets the wallet sign the visitor's own swap.
- **A new website:** if your site is new, Phantom may show "This domain is new or has not been reviewed yet" for a few days. That is Phantom checking your website, not the swap box. It usually goes away by itself. If it stays longer than a week, you can ask Phantom to review your site through the form in [Phantom's guide](https://docs.phantom.com/developer-powertools/domain-and-transaction-warnings).
- **Site builders that put code in a frame:** some builders run custom code inside a separate frame. Wallets do not always connect there. If the wallet does not open on your site but works on the test link above, try a different block type, or ask your developer to add the code to the page itself.

## For developers

If your site already connects a Solana wallet, pass it in with `wallet` (it needs `publicKey` and `signAndSendTransaction`). On BNB Chain and Robinhood Chain, pass your EIP-1193 provider with `evmProvider` (default `window.ethereum`). Use `onSwap` to run your own code after a confirmed swap: on Solana it receives `{ signature, side, mint, chainId: 101, token }`, on BNB Chain and Robinhood Chain `{ txHash, side, token, chainId }`, so one handler can read `chainId` and `token` for every chain. `slippageBps` sets the allowed price movement (default `100`, which is 1%). `mount` also takes `{ chainId: 101, token: "<mint>" }` for Solana.
