# Meteora DBC launch type (2026-09-28)

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Meteora DBC launch type -- devnet dress rehearsal PASS (2026-09-28)

Why: our bonding curve needs an Ed25519 route authorization per trade (locked on), so Jupiter cannot
route pre-graduation coins. Founder chose Meteora DBC as a new Solana launch type; the existing
launchpad is untouched. `tools/dbc-rehearsal/rehearse-dbc-devnet.mjs` (own deps, devnet genesis
enforced, keys + resumable state in `~/.config/memewarzone/solana-devnet/dbc-rehearsal/`) ran the whole
life of a coin and every check passed against the program's own accounting:
- 2% fee exact on buy and sell (sell: taken from the SOL out). Meteora keeps 20% of the fee; with a
  referral token account on the swap, 20% of Meteora's cut goes to that account (our collector ->
  effectively 16%). Jupiter trades name no referral of ours.
- `creatorTradingFeePercentage` is a whole % of the post-Meteora 80%: 7 -> creator 5.6% of the fee.
- Claims pay exactly the pool's counter, before and **after** graduation (late claims work).
  Measure claims at the pool vault: wallet deltas include returned WSOL-account rent (1488440).
- Graduation: 22% migration fee off the threshold, split 90/10 creator/partner to the lamport; the
  pool gets 78%, less Meteora's **0.2% liquidity migration fee** (`PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS`,
  base + quote). Graduated DAMM v2 pool (customizable config `A8gMrEPJ…`): 0.25%, SOL-only fee
  collection, 100% permanently locked, LP fees 80/20 creator/partner by liquidity.
- Meteora's keepers only migrate at >= 10 SOL / 750 USDC, so we run migration ourselves.
- PartialFill on the completing buy takes only what the curve needs.
- Tx shape: create (config + pool) 1160 B / 16 accounts / 7 writable / 4 signers; buy 673 B / 15 / 6 / 1.
- SDK 1.5.13 `state.getPool` returns `{ poolState }`; cp-amm 1.4 keeps the base fee as raw bytes.
- **Mainnet tiny coin (2026-09-28, `tools/dbc-rehearsal/canary-dbc-mainnet.mjs`, founder's terminal):**
  mint `4YuzaXEm…`, pool `CgAjACtB…`, config `2nmv9vHx…` (100 SOL threshold, never graduates).
  Creator tx = createPool only: **689 B / 14 accounts / 6 writable / 2 signers** (wallet + mint);
  config tx by our side 661 B / 2 signers. **Jupiter routes it on the curve** ("Dynamic Bonding
  Curve") within the first poll. Buy 0.02 SOL: fee 400000 = 2%, Meteora 80000 of which referral
  16000, creator 22400 (7% of 320000), collector 297600 -- read from the tx's own token balances.
- Launch shape decision: 21 of 25 recent mainnet DBC launches reuse a pre-made config (2 signers,
  ~710-760 B); ours = server-made config ladder per dollar target x SOL-price step (0.006 SOL rent
  each), creator signs createPool only. Founder decisions: creator 7%; referral = our collector on
  our own site; Meteora's 0.2% migration liquidity cut is compensated to the creator from our share.
- **Phantom (founder, 2026-09-28):** coin searchable by address in Phantom and in Jupiter-in-Phantom;
  buys went through with no warning, only the standard new/low-liquidity token notices. Creator
  claim paid exactly the pool counter (33378). ALL CHECKS PASS on mainnet.
- **The SDK partner-fee claim closes the claimer's WSOL ATA** (unwraps it). If that ATA is also the
  referral account, every later swap naming it fails. The referral account must be one no claim closes.


