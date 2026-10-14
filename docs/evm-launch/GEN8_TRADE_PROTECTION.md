# Gen-8 trade protection (audit F13, F14)

## F13: sandwiches on BNB Chain

Audit D (D-M2, `scripts/audit/D/results/econ-model.txt` on `audit-D`) showed that a normal gen-8 buy on BSC can be
sandwiched for a profit at almost any slippage above 0.05%, and that the attacker's profit grows about linearly with
the slippage the victim allows ($1,000 buy at the $30K target: about $11 at 0.5%, $22 at 1%, $104 at 5%). Robinhood
Chain orders transactions first come first served, so there it is not practical.

### What the app does

1. **Price impact before confirming** (BNB and Robinhood, app panel and widget). Measured from two quotes of the same
   pool in the same block: the trade, and a reference trade of 1/1000 of it.
   `impact = 1 - (amountOut / amountIn) / (refOut / refIn)`. Both quotes pay the same fee rate, so the fee is not
   counted as impact. Code: `gen8PriceImpactBps` in `frontend/shared/evmGen8Swap.mjs`; the API returns it as
   `priceImpactBps` / `priceImpactPct` from `/api/widget/swap/gen8/quote` and `/build`.
2. **Slippage sized to the trade on BNB Chain (56, 97)**: `clamp(0.30% + impact / 10, 0.30%, 1.00%)`.
   - 0.30% for a trade that does not move the price, 0.40% at 1% impact, 0.80% at 5%, 1% from 7% impact up.
   - The cap is the flat 1% default from before F13, so no trade gives a sandwich more room than before; small trades
     give it less.
   - The quote already includes the trade's own impact. Slippage only has to cover other trades landing between the
     quote and the block; the impact term adds a little room where the pool is thin for the trade's size.
   - The user can pick 0.5%, 1% or 3% instead (app panel), or a partner can set `slippageBps` (widget).
   - Robinhood keeps the flat 1% (`GEN8_DEFAULT_SLIPPAGE_BPS`).
   Code: `gen8SizedSlippageBps`, `GEN8_SIZED_SLIPPAGE` in `frontend/shared/evmGen8Swap.mjs`.
3. **Offer to add a private RPC (BNB Chain mainnet only)**. The gen-8 trade panel shows a notice with an
   "Add protected BSC RPC" button that asks the wallet (`wallet_addEthereumChain`, chain `0x38`) to add the PancakeSwap
   private RPC `https://bscrpc.pancakeswap.finance`. The choice ("added" or "Not now") is remembered per browser in
   localStorage (`mwz:bsc-protected-rpc`; every access in try/catch). Code: `frontend/src/lib/bscProtectedRpc.mjs`.

### What is not protected (be clear about this)

- The app cannot choose the RPC a trade is sent through. The user's wallet sends it (`eth_sendTransaction`) to the RPC
  set in the wallet. Injected wallets do not support `eth_signTransaction`, so the app cannot sign first and submit to
  a private relay itself.
- `wallet_addEthereumChain` for a chain the wallet already has is handled differently per wallet. MetaMask asks the user
  to add the RPC to BNB Chain and use it; other wallets may ignore the request or keep their own RPC. The app cannot
  read back which RPC a wallet uses, so "added" means the wallet accepted the request, not that trades are private.
- Private RPCs reduce sandwich risk; none of them guarantees it (bloXroute's docs say so explicitly).
- BNB testnet (97) has no private RPC: only the sized slippage applies there.
- The widget runs on partner pages and makes no RPC offer; it gets the sized slippage and the price impact from the API.
- Trades sent to the pool by anyone else (bots, aggregators, other front ends) are not covered.

Other free BSC private RPCs BNB Chain lists for sandwich protection, if the default does not suit a user:
48 Club `https://rpc-bsc.48.club`, Merkle `https://bsc.merkle.io`, bloXroute BSC Protect `https://bsc.rpc.blxrbdn.com`.

## F14: native left in the router

An exact-output native buy pays the maximum up front; the swap settles only what it costs. The UniversalRouter keeps
the rest unless the same call ends with `SWEEP(address(0), address(1), 0)` (native, to `msg.sender`, no minimum).
`buildGen8RouterCall` always adds it, and `assertGen8NativeRefund` refuses a call without it in the app
(`buildGen8TradeCall`) and the API's widget build. Exact-input buys settle exactly `msg.value` and need no sweep. The
fork test (`frontend/src/lib/evmGen8Client.chain.test.mjs`) proves the router holds 0 native after an exact-output buy
and that the payer paid only the quoted cost.
