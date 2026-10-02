# Solana operations: auto-graduation keeper, indexer pool starvation

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

### Solana auto-graduation (2026-09-25)

No curve could graduate on its own: begin_graduation must be signed by GlobalConfig.treasury_operator,
which on mainnet was the Squads vault, and the operator script lives in `scripts/solana/`, which neither
the API image (`frontend/`) nor the indexer image (`realtime-indexer/`) contains.
- Keeper: `scripts/solana/graduation-keeper.mjs` (`Dockerfile.graduation-keeper`, repo root, one replica).
  Websocket on every Campaign account write (discriminator `3228310b9ddce5c0`) = instant on the closing
  buy; 8 s DB+chain scan as safety net; live SOL price; SOL-bound campaigns only (quote-bound are logged).
- Operator: `SOLANA_GRADUATION_ALT_MODE=per-graduation` builds a fresh keeper-owned lookup table per
  graduation. Never extend the shared launchpad ALT (256 cap; CREATE/BUY compile against it).
  Keys may be inline JSON. IDL tracked at `scripts/solana/idl/memewarzone_solana.json` (sha `6ad69298`).
- Gate K2 runs that operator exactly as the keeper does: graduate -> DEX swap -> LP fee claimed.
- Role change: `scripts/solana/propose-squads-treasury-operator.mjs` (reads all 8 roles, changes only
  treasury_operator, refuses vault/deployer/empty, decodes the proposal back before anyone signs).
- LP fees: the keeper owns every locked position; indexer harvester needs the keeper secret AND
  `SOLANA_PROTOCOL_TREASURY_ADDRESS` (unset = 20% goes to devnet deployer `HuKfoF...`).

### Indexer pool starvation + no Solana trades (fixed 2026-09-25, `e2c16034`)

`withFeeEscrowTransaction` (and six `rewards/*` helpers) overwrote `client.query` on a pooled client
and released it still patched. pg-pool's `pool.query` passes a callback the patch dropped, so the next
query on that client ran on the server but never resolved: one leaked client per Solana trade. The
Solana trade loop froze on its first `curve_trades` write (no chain-101 trade stored 2026-09-20 ->
09-25) and the pool hit 20/20 until the watchdog restarted the container. Signature: DB idle, no locks,
backend `idle`/`ClientRead` holding the finished statement. **Never mutate a pooled client**; wrap it.
Pool now has `query_timeout` (`PG_QUERY_TIMEOUT_MS`, 45 s) + keepalive; `pooledClientPatch.test.ts`
pins both. Verified live: KAIJU88 17 trades after redeploy.


