# MemeWarzone swap widget

Put a swap box for your Solana coin on your own website. Your visitors buy and sell with their own wallet
(Phantom, Solflare or Backpack). Every swap pays a 1% fee and half of it, 0.5% of the swap, goes to the coin's
creator. To receive it, claim your coin on memewar.zone: payouts start 7 days after the claim is verified and go
to the wallet that claimed. Fees from trades older than 90 days that nobody claimed are not paid out.

## Add it to your site

```html
<div id="mwz-swap"></div>
<script src="https://app.memewar.zone/widget/mwz-swap.js"></script>
<script>
  MemeWarzoneSwap.mount("#mwz-swap", { mint: "YOUR_TOKEN_MINT" });
</script>
```

Try it first: `https://app.memewar.zone/widget/example.html?mint=YOUR_TOKEN_MINT`

## Options

| Option | Default | |
|---|---|---|
| `mint` | required | The coin's Solana mint address |
| `side` | `"buy"` | `"buy"` or `"sell"` when the box opens |
| `theme` | `"dark"` | `"dark"` or `"light"` |
| `slippageBps` | `100` | Allowed price movement, in basis points (100 = 1%, max 1500) |
| `wallet` | the page's wallet | Your own wallet object, if your site already connects one. It needs `publicKey` and `signAndSendTransaction(tx)`; `connect()` is optional |
| `onSwap` | none | Called after a confirmed swap with `{ signature, side, mint }` |
| `partner` | none | Partner id from MemeWarzone (for example `"crypticpump"`). Imported-coin fees from your widget go to your own fee account and split 0.5% creator / 0.25% partner / 0.25% MemeWarzone; your share is paid to your wallet automatically |

## How it works

- Prices and routes come from Jupiter, through the MemeWarzone API. The widget shows the price, the fee and the
  creator's part before anyone signs.
- Before the wallet opens, the widget checks the transaction: the visitor's wallet pays it, only their signature
  is needed, it goes through Jupiter, and it calls nothing else. Anything else is refused.
- The box renders in its own shadow root, so your page's CSS does not change it and it does not change your page.
- Size: about 70 KB gzipped. No cookies; the API calls send no credentials.

Solana coins only for now: imported coins (Jupiter, 1% fee, half to the creator) and coins launched on MemeWarzone
while they are on their bonding curve (the app's own trade code, same fees and creator share). The bonding part is a
second file, `mwz-swap-bonding.js`, loaded next to `mwz-swap.js` only for those coins. Bonding trades need a wallet with
`signTransaction` (Phantom, Solflare and Backpack have it); a host-provided `wallet` must offer it too.
