# Solana Warzone money path (source spec)

Date: 2026-08-29
Branch: `build/cross-chain-stabilization-rh-base` (PR 158)
Status: **spec only**. Do not upgrade `mwz_rewards_treasury` and do not deploy until this is accepted.

Locked product: `docs/build_plans/arena-mwl-and-solana-war-pool.md`. This file is the Solana custody slice of that spec, updated against current source.

## Product (do not reopen)

- Native **SOL** only.
- Winner-takes-all of the full pot (stakes + Support + tournament buy-ins): **85% winner / 5% protocol / 10% Major War League**.
- Support is a donation. Supporters have **no** claim.
- Resolve **requires a winner**. Exact % mcap ties still pick a money winner (higher ending mcap, then token address) so Support is not stuck. MWL records 0 / 0.
- **No charity.** Drop `claim_charity`, `charity_receiver`, `pending_charity`, `ARENA_CLAIM_CHARITY`.
- Same user tx method as Create / BUY / SELL: V0 envelope, simulate, refresh blockhash, Phantom may append Lighthouse / priority ix.

## Program boundary

Same program ID, isolated namespace:

`mwz_rewards_treasury` `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX`

- Do **not** add Warzone to `programs/memewarzone_solana`.
- Do **not** resize `RewardsConfig`.
- New PDAs: `arena_config`, `arena_pool`, `arena_vault`, `arena_buyin`, `arena_claim`, `arena_refund`.
- Arena ix must not touch league / airdrop / recruiter / squad / protocol vaults.
- Existing reward ix must not touch `arena_vault`.

Instruction set for the next same-ID candidate:

`initialize_arena`, `set_arena_resolver`, `set_arena_receivers`, `set_arena_pause`, `open_battle_pool`, `deposit_stake`, `donate_support`, `open_tournament_pool`, `deposit_buy_in`, `resolve_pool`, `claim_winner`, `claim_protocol`, `claim_mwl`, `refund_stake`.

`arena_config` receivers: `protocol_receiver` and `mwl_receiver` only.

## Current source (do not ship as-is)

| Piece | State |
| --- | --- |
| `programs/mwz_rewards_treasury/src/arena.rs` | Canonical module. Charity removed. Resolve requires a winner. |
| `frontend/src/lib/solanaArenaV0.ts` | V0 builders for open / deposit / support / buy-in / winner claim / refund. **No charity.** Unused by UI. |
| `frontend/api/lib/arenaWarPoolEscrow.js` + `arenaWarPoolLive.js` | EVM treasury reads only. |
| `ArenaStakeButton` / `ArenaSupportButton` / `ArenaWarPoolClaimButton` | Fail closed on Solana with `SOLANA_WARZONE_ESCROW_NOT_LIVE`. Must not call `ethers`. |

## Wire map (after accepted upgrade)

1. Charity is already stripped from canonical `arena.rs`. Resolve requires a winner. 85/5/10 matches BNB `ArenaWarPoolTreasury`.
2. Keep `solanaArenaV0.ts` as the only user executor. Gate it with the same V0 check script.
3. `ArenaStakeButton` / Support / claim: if chain 101/102 **and** the upgraded program is live on that cluster, call `solanaArenaV0`. Otherwise keep fail-closed.
4. API `escrowRequired(101)` becomes true only when the Solana arena config PDA exists on the canonical program. Never treat unsuffixed BNB treasury env as Solana.
5. Off-chain receipts (`arena_deposit_stake`, `arena_war_pool_support`) stay; they record the V0 signature, they do not move SOL.

## Acceptance

- Devnet: open pool, both SOL stakes, Support donation, resolve with winner, 85/5/10 pull claims, supporter cannot claim, timeout refund.
- Phantom: one prompt per action, simulation green, no red failure from Legacy tx or Ed25519 adjacency.
- Mainnet upgrade is a later same-ID promotion of that accepted `.so`. Not this cut.
