# MemeWarzone swap widget

Put a swap box for your coin on your own website. It works on Solana, BNB Chain (56) and Robinhood Chain (4663).
Your visitors buy and sell with their own wallet (Solana: Phantom, Solflare or Backpack; BNB Chain and Robinhood
Chain: any wallet the page has as `window.ethereum`, such as MetaMask or Rabby).

Every swap is quoted and built by the MemeWarzone API, so the fee is in the swap the visitor signs. The widget never
builds a swap without the fee: when a chain's fee route is not configured, the box says the coin is not tradable here.

## Add it to your site

```html
<div id="mwz-swap"></div>
<script src="https://app.memewar.zone/widget/mwz-swap.js"></script>
<script>
  // Solana
  MemeWarzoneSwap.mount("#mwz-swap", { mint: "YOUR_TOKEN_MINT" });
  // or BNB Chain (56) / Robinhood Chain (4663) / Solana (101)
  MemeWarzoneSwap.mount("#mwz-swap", { chainId: 56, token: "0xYOUR_TOKEN" });
</script>
```

Try it first: `https://app.memewar.zone/widget/example.html?mint=YOUR_TOKEN_MINT` or
`https://app.memewar.zone/widget/example.html?chainId=4663&token=0xYOUR_TOKEN`

## Which coins, which fee

| Coin | Route | Fee |
|---|---|---|
| MemeWarzone coin on its bonding curve (Solana launchpad and DBC) | the app's own trade code | the normal MemeWarzone fee and creator share |
| MemeWarzone generation 8 coin (BNB Chain, Robinhood Chain) | its own Uniswap V4 pool | the pool's fee (2% before graduation, 1% after, half to the creator) |
| Graduated MemeWarzone coin | the import route below | the import fee, only where it pays the creator half |
| Imported coin | Solana: Jupiter. BNB Chain: KyberSwap. Robinhood Chain: Uniswap V3 | 1%, half of it (0.5% of the swap) to the coin's creator |

- BNB Chain imports: until the BNB ImportFeeVault is deployed and switched on, the API charges 0.5% to the protocol
  vault with no creator share. The box shows whatever the API quotes (fee and creator share), so it changes by itself
  when the vault is switched on. Graduated MemeWarzone coins on BNB Chain stay off the widget until then.
- Robinhood Chain imports: 1% to the ImportFeeVault, half of it the creator's.
- Older MemeWarzone coins (before generation 8) on their bonding curve on BNB Chain or Robinhood Chain: not tradable
  in the box; it links to the coin's MemeWarzone page.
- A coin with no route (BNB Chain: no KyberSwap route; Robinhood Chain: no Uniswap V3 pool with ETH): "No route here.
  Trade it on its MemeWarzone page." with the page link.

The creator's half is paid to the wallet that claimed the coin on memewar.zone: payouts start 7 days after the claim
is verified. Fees from trades older than 90 days that nobody claimed are not paid out.

## Options

| Option | Default | |
|---|---|---|
| `mint` | | The coin's Solana mint address (Solana box) |
| `chainId` + `token` | | `101` + mint (Solana box), or `56` / `4663` + the token address (EVM box). `mint` wins when both are given |
| `side` | `"buy"` | `"buy"` or `"sell"` when the box opens |
| `theme` | `"dark"` | `"dark"` or `"light"` |
| `slippageBps` | `100` | Allowed price movement, in basis points (100 = 1%, max 1500 for the import route). Generation 8 coins without it use the chain's default |
| `wallet` | the page's wallet | Solana only: your own wallet object (`publicKey`, `signAndSendTransaction(tx)`, `connect()` optional, `signTransaction` for bonding coins) |
| `evmProvider` | `window.ethereum` | BNB Chain and Robinhood Chain: your own EIP-1193 provider |
| `onSwap` | none | Called after a confirmed swap. Solana: `{ signature, side, mint, chainId: 101, token }`. EVM: `{ txHash, side, token, chainId }`. One handler can serve both by reading `chainId` and `token` |
| `partner` | none | Partner id from MemeWarzone (for example `"crypticpump"`). See below |

## Partners

A site that mounts the box with `partner` gets part of the fee of every swap it builds, on graduated and imported
coins: of the 1%, 0.50% goes to the creator, 0.25% to the partner and 0.25% to MemeWarzone. The swap the visitor
signs does not change. The split happens after the swap, off chain, from the fee vault: when the API builds a swap
for a partner it records a fingerprint of exactly what it built (EVM: keccak256 of to, data and value), and the
fee ledger matches the landed transaction to it. On BNB Chain the partner share waits for the BNB ImportFeeVault.
Generation 8 coins: the partner's 0.25% of a graduated swap comes from MemeWarzone's 0.50%.

## How it works

- Solana: before the wallet opens, the widget checks the transaction: the visitor's wallet pays it, only their
  signature is needed, it goes through Jupiter, and it calls nothing else.
- BNB Chain and Robinhood Chain: the widget talks to the wallet with `eth_requestAccounts`,
  `wallet_switchEthereumChain` (adding the chain when the wallet does not know it) and `eth_sendTransaction`. Before
  it sends an import swap it checks that the API's build goes to the chain's router (KyberSwap on BNB Chain, Uniswap's
  Universal Router on Robinhood Chain) with the swap's own value.
- Sells on BNB Chain and Robinhood Chain may need approvals first. The API answers `needsAllowance` with the
  transactions to send, then the widget asks for the swap again:
  - BNB Chain imports: approve this sell's amount to the KyberSwap router (every sell that is not covered).
  - Robinhood Chain imports and generation 8 coins: two one-time approvals (the coin to Permit2, then Permit2 to the
    Uniswap router). Every later sell is only the swap. There is no signed permit inside the swap, so the build the
    API fingerprinted is the transaction that lands.
- Rows: you receive, price impact and the minimum you get ("At least") when the quote has them, the fee, and the
  creator's part.
- On an imported coin nobody has claimed yet, a line under the box links to the coin's MemeWarzone page with the
  claim dialog open ("Created this coin? Claim it on MemeWarzone"). It disappears once the coin is claimed.
- A coin without a name or symbol shows its short address and "Unlisted coin".
- The box renders in its own shadow root, so your page's CSS does not change it and it does not change your page.
- No cookies; the API calls send no credentials. The widget needs no RPC of its own: balances and confirmations come
  from the API (`/api/widget/swap/*`, open to every origin, rate limited per IP).
- The Solana bonding part is a second file, `mwz-swap-bonding.js`, loaded next to `mwz-swap.js` only for those coins.

## What we count (usage and revenue)

MemeWarzone counts how the widget is used and what it earns, so partners and the team see the same numbers in the
Command Center. Counting happens on our API after it has answered the widget: it never changes, slows or fails a
quote or a swap, and a counting error is only logged.

- **Usage per day**: one counter per day, chain, partner, website and event. Events: `load` (the widget looked up a
  coin), `quote`, `build` (the API handed out a swap transaction), `approval` (a sell needed an approval first) and
  `bonding_trade` (a Solana launchpad bonding trade was authorized). Solana DBC bonding trades do not pass our API and
  are not counted.
- **Website**: the hostname your visitors' browsers send with the request (`Origin`, else `Referer`), for example
  `crypticpump.io`. Never the path, never a full URL. After 500 different websites on one chain in one day, new ones
  count as `other`.
- **Partner**: the `partner` option is sent with token lookups, quotes and builds. It counts for a partner only while
  that partner is active on the chain; anything else counts as no partner.
- **Swaps and revenue**: every swap the API builds for the widget is stored with the same fingerprint the partner split
  uses and the wallet it was built for. When that wallet lands that exact swap, the fee ledger marks it as a widget
  swap. Generation 8 swaps are recognised by the widget tag the API puts in the swap.

Privacy: no cookies, no IP addresses and no visitor ids are stored. The per-IP rate limit is kept in memory for one
minute and never written anywhere. Wallet addresses are stored only for the swaps a wallet asked the widget to build
(they are public on chain once the swap lands), never for page views or quotes.

## API routes (for reference)

| Route | |
|---|---|
| `GET /api/widget/swap/token?mint=` | Solana coin |
| `GET /api/widget/swap/evm/token?chainId=&token=` | EVM coin: `kind` `gen8`, `import` or `memewarzone`, decimals from chain, fee, claim link, page link |
| `GET /api/widget/swap/balances`, `/evm/balances`, `/gen8/balances` | balances |
| `POST /api/widget/swap/quote`, `/build` | import route, chainId 101, 56, 4663 |
| `POST /api/widget/swap/gen8/quote`, `/gen8/build` | generation 8 coins |
| `GET /api/widget/swap/status`, `/evm/status`, `/gen8/status` | confirmation |
