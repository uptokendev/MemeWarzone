# Solana programs: changes, gates, mainnet upgrades, incident, recovery tooling

Split out of CLAUDE.md on 2026-10-02, text unchanged. Facts are as of the dates in each heading.

## 4b. Program changes — done and proven on a local validator (2026-09-22)

Both program changes are committed, built to SBF and proven. **Neither is deployed
anywhere**: no devnet upgrade, no mainnet (that remains ON HOLD).

- **Launchpad accepts Token-2022 quote assets.** `programs/memewarzone_solana/src/graduation.rs`.
  The quote side takes either token program; the launch token is minted by this program and stays
  classic SPL, so the staging account, the Meteora launch vault and the creator account are
  untouched. Which program owns the quote is read off the mint — the route signer already
  authorizes `quote_mint` in the digest, so `GRADUATION_AUTH_SCHEMA_VERSION` stays 4 and the
  signing contract is unchanged. Extensions are an **allowlist** (metadata, grouping,
  ImmutableOwner); transfer fees, transfer hooks, permanent delegates and confidential transfers
  are refused with `UnsupportedQuoteTokenExtension` (IDL error 6074). A classic-SPL graduation
  keeps its exact account list; a Token-2022 quote appends its program after the 3-account prefix.
- **Competition V2 is 75/20/5 on Solana.** `ARENA_MWL_BPS` 1000 → 2000, taken from
  `ArenaWarPoolTreasuryV2.ENTRY_LEAGUE_BPS` so Solana and EVM agree by construction. The signed
  resolution message binds totals and outcome, never the split, so no pending authorization broke.
  Note the raised factor halves the `split_arena_prize` overflow ceiling (~18.4M → ~9.2M SOL); it
  fails closed with `MathOverflow` and a test pins that boundary.
- **App alignment:** `isCompetitionV2Chain` in `frontend/api/arenaWarPools.js`. `warPoolGeneration`
  only recognises an EVM treasury address, so chain 101 fell through to the V1 branch and the UI
  would have quoted 85/5/10 while the program paid 75/20/5.

### The gate was passing while graduation skipped

`tests/solana/v4-lifecycle-acceptance.cjs` has always held "Gate K: graduate closed campaign into
pinned DAMM v2 and swap", and it calls `this.skip()` when the Meteora program is not executable on
the validator. `run-local-sbf-gate.sh` never loaded Meteora, so that test reported **pending** on
every run and the gate printed GATE PASS anyway. It now loads the pinned DAMM v2 binary plus its
account fixtures (fetching them if absent) and **fails if that test reports pending**.

With Meteora loaded the proof actually runs — verified 2026-09-22 against the modified program:
create 10 passing, lifecycle 4 passing including a real graduation into a pool plus a swap,
`sha256=9ee52111ccd5e9f22f32cd6314e864405388f22490efece264129b921b04cb4a` (stable across runs; the
`cfg(test)` additions do not change the artifact). 106 launchpad unit tests, 22 treasury.

`solana-local-validator-ci.yml` now calls that same script instead of keeping its own validator
choreography that only ran the create suite, and triggers on PRs into `main` too. The treasury has
its own path: `solana-rewards-treasury-upgrade-candidate.yml` runs `cargo test -p
mwz_rewards_treasury --lib`, builds the SBF and records candidate hashes.

Run it locally with:
`ANCHOR_WALLET=<keypair> bash scripts/solana/run-local-sbf-gate.sh`

### Binding tokens: allow the full list, warn the creator (2026-09-22)

Which asset a campaign graduates against is the **creator's** decision, so the
extension allowlist is no longer a gate. Refusing removed the asset from the
list rather than explaining the trade-off, and a refusal reached at graduation
would strand a campaign that had already closed.

- **Program** accepts any mint owned by either token program and reads only the
  base layout. That also removed an accidental cliff: `spl-token-2022` 3.0.5
  cannot *enumerate* extensions it postdates (ScaledUiAmount, Pausable — both on
  every xStock) while unpacking the base mint still succeeds. Enumerating would
  have refused those assets purely for being newer than the dependency. **No
  dependency upgrade needed.**
- **Catalog** returns `metrics.bindingRisks` — one entry per issuer power with
  `code`, `armed`, `severity`, `title`, `detail`, for the "Are you sure?" dialog.
  `armed` is real: on live NVDAx the permanent delegate, pausable and
  transfer-hook authorities are all set; no transfer fee is charged. Freeze
  authority is reported too, noting USDC has one as well.
- **`quote_extension_allowed` stays** as a classification the catalog reads.

**The check runs once, at graduation, and the pool is then locked forever.** An
authority armed afterwards cannot be caught — the dialog copy must say so.

### LP fee economics survive a Token-2022 binding

Proven on a validator: a swap against a Token-2022 quote accrues an LP fee and
claiming pays the position **in full — owed 181818182, claimed 181818182,
nothing skimmed**. A permanently locked position accrues and pays identically to
an unlocked one, so the lock is not what would break it. The xStocks charge no
transfer fee, the one extension that would have skimmed the creator/protocol cut.

### Devnet state (both programs upgraded and byte-verified)

| | sha256 | bytes | slot |
|---|---|---|---|
| Launchpad `3JSGNiFst…` | `e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2` | 1218568 | 502512217+ |
| Treasury `2Nzth…` | devnet runs `5638c992…` (1276472); the **candidate is now `1028f6f8a52037f1aea8ab2e6ae86f9e2c1224eed7e1e7b71675cdfca2508a95`, 1306640 bytes** | | 502458587 |

IDL sha256 `6ad692989c7445ff079aecf185b23ebf54ceb2bfe21f3e9df06802c6b40b8a16`.
**The certified binary is named in exactly one place:**
`config/solana/launchpad-binary.certification.json`. `network-canary.mjs`, its
shell wrapper and the CI workflow all default from it. They each held their own
literal until 2026-09-22, and two stayed on `27ad65b5…`/1165328 after the devnet
upgrade, so `solana-network-canary.yml` was failing against the runner's own pin
with a binary that was in fact the deployed one. Change the file, not the copies.

`SOLANA_LAUNCHPAD_PROGRAM_SHA256` / `_IDL_SHA256` go on the API and must move
with any upgrade. Know what they are: `hashEnv` checks presence and 64-hex form
(missing → 503, **wrong → accepted**), neither is compared against the chain,
neither enters the signed digest, and both are attached to every create
authorization as `auditMetadata`. A stale hash breaks the audit trail, not
create/buy/sell. Only `SOLANA_GENERATION_MANIFEST_HASH` is checked on-chain.
`_PROGRAM_BYTES` is canary-only and is **not** read by the API.

Gate (`bash scripts/solana/run-local-sbf-gate.sh`): create 10, lifecycle 4
(incl. graduation into pinned DAMM v2), Token-2022 5. Fails if any reports
pending. Treasury gate: 11.

Mainnet runbook with the Squads ceremony: `docs/solana-mainnet-squads-upgrade-runbook.md`.

### The bound graduation runs end to end (2026-09-22)

Gate B in `v4-lifecycle-acceptance.cjs` drives a campaign from a closed curve to
a bound Token-2022 pool in the production transaction shape: Ed25519,
begin_graduation, the Orca acquisition that turns raised SOL into the quote,
Meteora creating the MEME/quote pool, then confirm_graduation with the
Token-2022 program appended to the quote prefix. Campaign ends `graduated:true`
and the pool's quote vault is owned by Token-2022.

The main gate now loads four programs — launchpad, Metaplex, Meteora, Orca —
cloning the Orca program and its config/fee-tier accounts on demand like the
Meteora fixtures. Gate: create 10, lifecycle 5 (native **and** bound),
Token-2022 5.

**54 bytes of headroom, measured.** The bound envelope sends 1178 bytes against
a 1232 hard limit, and Gate B prints a byte budget every run. An earlier 1230
reading was the test packing ATA creates the production operator already sends
separately; splitting them recovered 52 bytes. The program requires the
acquisition before Meteora in the *same* transaction, so it cannot be split
further. Levers if a longer route eats the margin: payouts to a claim model
saves 14B, and `begin_graduation` carries 128B of pubkeys naming accounts the
transaction already has (a v4→v5 digest schema change).

Other things only running it revealed: the fee escrow must be flushed before
`begin_graduation`; the acquisition pool price must agree with the binding's
declared oracle and quote reference (a 33% disagreement against a 1.5% cap
rejects the pool the graduation just built); the Meteora initial price is whole
units per whole token, not a raw ratio; and `sendCreate` needed a label because
the campaign id seeds every campaign PDA.

### The binding confirmation dialog (2026-09-22)

The risk of binding to a non-SOL quote is the creator's to take, so the product
moves it to them explicitly instead of the program refusing assets.

- `quote_asset_deployments.verification` is now read by the creator-facing
  catalog: `GENERIC_SELECT` selects `d.verification` and `mapGenericRow` maps
  `metrics.bindingRisks` onto every asset as `bindingRisks`. Both the list and
  the detail path go through it, and `decorateQuoteAsset` spreads it through.
  The snapshot is read back, never recomputed — the scan is what the gate saw.
- `frontend/src/lib/graduationBindingRisks.mjs` merges those issuer powers with
  three structural risks true of any non-native binding (liquidity locked
  forever, price follows the quote, checked once at graduation), so an unscanned
  quote never yields an empty dialog. A power that exists but is **not armed** is
  demoted to `info` — a permanent delegate with nobody set is not a delegate
  that is set, and flattening the two makes every Token-2022 asset look equally
  dangerous.
- `GraduationMarketStep` routes every card through `requestSelect`. Native goes
  straight through; anything else opens `BindingRiskDialog` and the selection is
  only committed on confirm, remembered per asset for the session. The auto-select
  on load now picks **only** a native quote — a non-native default would be a
  binding nobody agreed to, and with nothing selected `canGoNext(5)` already
  blocks Next with a clear toast.

Tests: `npm run test:graduation-market` (42) covers the risk merge, the severity
demotion, the headline and the catalog mapping, plus a guard that
`GENERIC_SELECT` still carries `d.verification` — drop that column and every
asset silently reports no issuer powers.

### The mainnet upgrade, end to end (2026-09-23)

**Nothing is upgraded until BNB and Robinhood are ready.** Founder decision
2026-09-23: the new launchpad contracts and the battle system go out as one
release — BNB and Robinhood deployed, both Solana programs upgraded, then tested
together and put live. Both Solana candidates are finished and staged; they wait.

Both are certified by their gates and byte-verified on devnet:

| | Program | Candidate sha256 | Bytes | Allocation |
|---|---|---|---|---|
| Launchpad | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` | `e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2` | 1218568 | 1310936 — **fits** |
| Treasury | `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` | `1028f6f8a52037f1aea8ab2e6ae86f9e2c1224eed7e1e7b71675cdfca2508a95` | 1306640 | 660016 — **must extend 646624 B first** |

#### The half we do, and the half Squads does

The multisig `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv` owns both programs, so
only it can execute the upgrade. Everything before that — uploading the binary
into a buffer, extending an allocation — is permissionless and paid by the
deployer. We do that half and hand over four values.

```
bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad                    # reads only
MWZ_STAGE_SEND=1 bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad   # sends
```

It verifies the .so against the certified sha, checks the allocation can hold
it, uploads, dumps the buffer and byte-verifies it, transfers buffer authority
to the multisig, then prints the Squads proposal values. For the treasury add
`MWZ_TREASURY_RELEASE=1`, and run `solana program extend` first.

**It does nothing without `MWZ_STAGE_SEND=1`.** Every other check is free and
the upload is not: once buffer authority moves to the multisig the rent is
recoverable only by the multisig, so an accidental run costs a Squads
transaction to undo. That guard exists because the script was run without it on
2026-09-23 and staged the launchpad buffer for real.

**The mainnet RPC is already in the build** — `SOLANA_RPC_URL` in
`frontend/.env.local`, a paid Helius mainnet endpoint. The script prefers an
explicit `SOLANA_MAINNET_RPC_URL` and otherwise reads that one, then asks the
chain for its genesis hash and refuses anything that is not mainnet-beta. A URL
cannot be trusted to say which cluster it is, and that file is the staging env.

The proposal is a `BPFLoaderUpgradeable::Upgrade` with four fields — program,
buffer, spill (the deployer, which receives the reclaimed rent), authority (the
multisig). **The buffer address is the entire payload; everything else is
fixed.** Confirm with signers that it is the address whose hash was verified.

#### What the script refuses, and why each one cost something to learn

- **No `SOLANA_MAINNET_RPC_URL`** → stops. No Solana mainnet RPC is in any local
  env file; the paid endpoint is supplied at run time.
- **The public `api.mainnet-beta.solana.com`** → refused. A 1.2MB binary is
  several hundred write transactions and the public endpoint drops enough to
  abort the deploy with the rent already spent. On devnet that stranded 6.49 SOL
  in a buffer whose only handle was a seed phrase printed once.
- **A candidate whose sha does not match** → stops. The tree is then not what
  the gate certified.
- **An allocation smaller than the binary** → stops, naming the extend. An
  upgrade into an allocation that cannot hold the binary fails *on execution*,
  which is the worst place to discover it.
- **`treasury` without `MWZ_TREASURY_RELEASE=1`** → refused while held.

Buffer keypairs are **generated ahead of time and named**, so the address is
known before a lamport is spent, an aborted upload resumes into the same
account, and the rent is always recoverable with
`solana program close <BUFFER> --recipient <deployer>`.

| | Address / path | State |
|---|---|---|
| Launchpad buffer | `EdmGZHL5fNGQuT8b8wRz5JbT4uhUwHyptuoSoBjLkJbg` | consumed by upgrade #15, re-staged after the incident, **consumed by upgrade #17 (2026-09-24, sig `5xeTMQ8K…`, slot 449877289)**. Closed; 6.19 SOL back on the deployer (7.6566 SOL). |
| | `~/.config/memewarzone/mwz-launchpad-mainnet-buffer-e6ed7df3.json` | |
| Treasury buffer | `GQC9eHQsDgUgydstAYxks9JFpDVhRGrPZ7vAMXygWc9y` | staged 2026-09-24, consumed by the wrong proposal #16 (see INCIDENT), re-staged, **consumed by upgrade #18 (2026-09-24, sig `3tpjQoiC…`, slot 449990075)**. Closed; deployer 7.6445 SOL. |

The launchpad buffer exists and is in the multisig's hands. The program itself
is untouched (`Last Deployed In Slot` still 448871337), so nothing has been
upgraded — the proposal simply has its payload waiting. Its 6.19120428 SOL
returns to the spill account when Squads executes, or the multisig can close the
buffer to reclaim it. **The deployer cannot close it; authority has moved.**

#### Money, and why the two cannot be staged together

| Item | SOL | Comes back? |
|---|---|---|
| Launchpad buffer | 6.19116364 | yes, to the spill account on execution |
| Treasury buffer | 6.63856940 | yes, same |
| Treasury extend top-up | 2.04369460 | **no — permanent rent** |

The launchpad buffer is already paid, so the deployer now holds **7.038237636**
against the treasury's 8.68226400 — **short 1.64402764**. The treasury therefore
cannot be staged until either Squads executes the launchpad upgrade (returning
6.19120428 to the spill account) or the deployer is topped up by ~1.7 SOL.

#### After the launchpad executes

One env var moves, on the API **and** the indexer, then redeploy both:

```
SOLANA_LAUNCHPAD_PROGRAM_SHA256=e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2
```

`SOLANA_LAUNCHPAD_IDL_SHA256` does **not** move: the candidate IDL is
byte-identical to what is deployed (`6ad69298…`), because the Token-2022 change
added no instruction, account or error. Clients need no regeneration.

Know what these are before treating a mismatch as an outage: `hashEnv` checks
presence and 64-hex form — missing is a 503, **wrong is accepted** — and the
values are attached to every create authorization as `auditMetadata`. Neither is
compared against the chain. A stale hash breaks the audit trail, not
create/buy/sell. Only `SOLANA_GENERATION_MANIFEST_HASH` is checked on-chain.
`_PROGRAM_BYTES` is canary-only and not read by the API.

#### After the treasury executes

The upgrade adds the arena instruction set but **creates no accounts**.
`arena_config` and `arena_money_config_v2` do not exist on mainnet, so until the
initializer runs the arena cannot take a lamport.

```
SOLANA_RPC_URL=<rpc> node scripts/solana/init-arena-mainnet.mjs --status   # keyless, sends nothing
SOLANA_RPC_URL=<rpc> SOLANA_TREASURY_AUTHORITY_KEYPAIR=<deployer> \
  node scripts/solana/init-arena-mainnet.mjs            # dry run
  ... --execute                                         # creates both configs, CLOSED
  ... --open --execute                                  # after the canary: unpauses both
```

Everything lands closed — war pool v1 paused as the last step, money v2 born
paused — so a half-finished run is inert. Opening is a separate deliberate act.
The script refuses any cluster but mainnet-beta by genesis hash, and is
rehearsed end to end against the candidate by
`scripts/solana/rehearse-mainnet-arena-init.sh`.

Verify after either upgrade: `Last Deployed In Slot` advanced, `Authority` is
still `fk5YYWb…`, and the deployed bytes equal the candidate followed by zeros.
`Data Length` stays at the allocation, not the binary size — expected, not a
failure. A plain `sha256sum` of a dump disagrees with a perfectly good buffer;
use `scripts/solana/program-upgrade-verify.cjs`.

Full runbook: `docs/solana-mainnet-squads-upgrade-runbook.md`.

### The treasury audit (2026-09-22)

Asked before spending rent: is the whole battle system actually ready? The gate
was green on **31 of 47** instructions and silent on the rest. Auditing the
silence found one real hole and several facts worth keeping.

- **Cancelled pools stranded their supporters' money.** `donate_support_v2` kept
  only an aggregate `support_total` and no per-donor receipt, so there was
  nothing to refund against and no `refund_support` to call. Fixed:
  `ArenaSupportReceipt` (accumulating, one per donor per pool) plus
  `refund_support_v2`. All refunds are **pull-claims** — the contributor signs
  and takes their own lamports; nothing is ever pushed, so a pool with hundreds
  of contributors costs nothing to unwind.
- **`cancel_pool_v2` is removed.** Founder rule: once a battle or tournament
  starts it runs to a winner. Deleting the instruction makes that structural
  rather than a promise about who holds the resolver key. The only way a pool
  ends without a winner is `settle_expired_pool` — no-show past the deposit
  deadline, or we missed our own resolve deadline — and it is permissionless, so
  nobody can hold the money by doing nothing.
- **Money V2 is born paused.** `initialize_arena_money_v2` sets `paused = true`.
  Standing the sponsorship rail up on mainnet takes no money until an explicit
  `set_arena_money_v2_pause(false)`. Same shape as `init-arena-mainnet.mjs`
  pausing war pool v1 with no unpause.
- **Nothing on the checklist was missing from the program.** Vote vs metrics,
  both tournament types and final-salvo tie-breaks need no on-chain support:
  `result_type` is only WINNER/NONE and the resolver signs an `outcome_hash`.
  Tournament place splits are resolver-supplied bps (distinct, non-zero, summing
  to 10000), so 60/30/10 can change without a program upgrade. Quarterly finals
  ride the league root and claim rail with period 2. Split parity with EVM is
  exact: `ENTRY_LEAGUE_BPS 2000 / ENTRY_PROTOCOL_BPS 500 / BOOST_PROTOCOL_BPS 1000`.
- **47 of 47 instructions now execute** against the compiled .so. Treasury gate
  14 tests, Rust 22.

**Static analysis could not answer "what is untested" here** — it lost to
dynamic dispatch three separate times (operator helpers building instructions
under computed names, table-driven `program.methods[row.claim]`, and
continuation-line calls). Count coverage by tokenising the whole test file,
including string literals, or by watching execution. Do not trust a grep.

### Still open

- **Orphaned devnet buffer** `HbmmrEjPJL7hvrk7DJrvwFSqqFoNz9yiyzoFxAmEzZZv`
  holds 7.55857772 SOL on the devnet deployer. Predates this work.


### Solana launchpad — UPGRADED ON MAINNET (2026-09-24)

Last full check before the ceremony, all re-executed: launchpad rebuilt from
HEAD → identical `e6ed7df3…`; gate PASS (10/5/5); IDL identical; 107 unit
tests; staged buffer byte-identical; treasury rebuilt → identical `1028f6f8…`,
gate PASS 14/14, 22 unit tests, mainnet preflight PASS. Squads executed
`BPFLoaderUpgradeable::Upgrade` (sig `5KsJbc24…`, source commit `72a6e91a`):
**slot 448871337 → 449849762**, authority still `fk5YYWb…`, ProgramData
verified as the candidate followed by 92,368 zero bytes, buffer `EdmGZHL5…`
closed, 6.19 SOL returned to the deployer (9.724 SOL). Now due on API and
indexer: `SOLANA_LAUNCHPAD_PROGRAM_SHA256=e6ed7df3…` (IDL sha unchanged).

Treasury next, in this order, from the founder's terminal: `solana program
extend 2NzthKEZ… 646624` (~2.044 SOL top-up) → generate the buffer keypair →
`MWZ_TREASURY_RELEASE=1 MWZ_STAGE_SEND=1 prepare-mainnet-squads-buffer.sh
treasury` → Squads → `init-arena-mainnet.mjs`.

### INCIDENT 2026-09-24 — the treasury proposal upgraded the LAUNCHPAD

Squads executed `2DpPu4N3…` as `BPFLoaderUpgradeable::Upgrade` with
`programAccount = 3JSGNiFst…` (the launchpad) and the **treasury** buffer
`GQC9eHQs…`. The loader does not check that a buffer belongs to a program.
Result, verified on chain: launchpad ProgramData = the treasury binary
`1028f6f8…`, slot 449859880; treasury program **unchanged** (`7e159b69…`,
slot 449850861); buffer rent 6.6386 SOL returned to the deployer. No funds
moved. **The mainnet Solana launchpad was down for create/buy/sell from slot
449859880** until re-upgraded with `e6ed7df3…`.

Cause: the proposal's Program field kept the previous (launchpad) value; only
the buffer was updated. The loader `Upgrade` succeeded because the launchpad
allocation (1,310,936) fits the treasury binary.

Rule from this: **a Squads proposal is decoded from chain and checked
field-by-field before anyone signs** — `scripts/solana/decode-squads-proposal.mjs`.
The Squads UI's own review was not enough.

Recovery, **done 2026-09-24**: `e6ed7df3…` re-staged into `EdmGZHL5…`; the
Squads web app refused the re-used buffer address, so proposal #17 was created
from the terminal with `propose-squads-upgrade.mjs` (see Recovery tooling),
decoded twice (`PROPOSAL MATCHES`), approved by `9YN7…` + `EGHZ…`, executed
as `5xeTMQ8KNzFNqkrXeSqR8ThyLN3hRyaCToW4vkENP6BWxfnyc1sj2ajhf7esDqiqVNNM39kwtivfYqyaLrwqdYw`
(slot 449877289). Verified: ProgramData = `e6ed7df3…` + zeros, authority
`fk5Y…`, buffer closed, 6.19 SOL returned. **Launchpad down from slot
449859880 to 449877289.**

### Solana treasury — UPGRADED ON MAINNET (2026-09-24)

Same path, same checks: `GQC9eHQs…` re-staged (6.6386 SOL, byte-verified
`1028f6f8…` independently), proposal #18 created from the terminal (the
script printed `certified MemeWarzone rewards treasury`), decoded twice
(`PROPOSAL MATCHES`), the Squads UI's own execute message decoded to the same
seven accounts and `03000000`, approved by `9YN7…` + `EGHZ…`, executed as
`3tpjQoiCdaNEfsnxQySULCcR1RpArTBgxgag1NZ8boxJs2RUJFxD8PPXmzTQWe6E6CCY9buCQvCAHgbfnRCjaKnf`:
**slot 449850861 → 449990075**, authority `fk5Y…`, ProgramData == candidate
(allocation equals the binary, no padding), buffer closed, 6.64 SOL back
(deployer 7.6445 SOL). Launchpad untouched (still slot 449877289).

**Both Solana programs now run their certified binaries on mainnet.** No env
moves for the treasury.

### Solana arena — INITIALIZED ON MAINNET, CLOSED (2026-09-24)

`init-arena-mainnet.mjs --execute` with the deployer as `rewards_config`
authority and `ARENA_RESOLVER=8rEczXrZZMzpp3MAUbs8TWftaZcJxctydwnkHLsdWaRv`
(a dedicated resolver wallet, founder-held; not the deployer, not a multisig
member). Four transactions, all `err: null`, slots 449992906–449992911:
`initialize_arena` `PA6sobcD…`, `initialize_arena_money_v2` `3nXosYgD…`,
`set_arena_pause(true)` `5w1P3qKh…`, `set_route_params` `47j9Mfyo…`.

Finalized state, read back independently: `arena_config` `95NfXZY5…`
resolver `8rEczXrZ…`, protocol receiver `BvQHb…` (protocol vault), MWL
receiver `68FNN…` (monthly league vault), **deposits PAUSED**;
`arena_money_config_v2` `Bio7bTMD…` protocol + marketing receiver `BvQHb…`,
**sponsorship PAUSED**; `route_state.overflow` moved from the protocol vault
(`BvQHb…`, "keep") to the multisig `fk5Y…` — operator `2AMfRaxS…`, cap
$10,000 and the stored SOL price unchanged. The arena exists and takes
nothing until `--open --execute`, which comes after the canary.

**OPENED 2026-09-25** (`--open --execute`, founder's terminal): read back from chain,
`arena_config` deposits **open**, `arena_money_config_v2` sponsorship **open**, resolver
`8rEczXrZ…` holds 0.527 SOL. BNB and Robinhood still closed at that moment (step-H batches pending).

**BNB and Robinhood OPENED 2026-09-25** (step-H Safe batches, signed by Sven): BNB tx
`0x7e2a0228…` block 123835729, Robinhood tx `0xd1c13793…` block 71722647, both status 1.
Read back: both factories `live=true`, `createPaused=false`; both war pools `depositsPaused=false`;
Robinhood `stockCampaignImplementation` = `0xC46D33FC…` (R5 landed first, as required).
All three chains are open. Battle settlement runs inside the API (needs
`ARENA_BATTLE_REALTIME_ENABLED=true`; log line `immutable Normal Battle settlement dispatcher active`).
The Solana resolve-due worker must be built from the **repo root** (Base Directory `/`), not `frontend/`.

Note: the script's closing state report printed the *old* overflow right
after sending. Not a failed transaction and not RPC lag: `report()` printed
the `route_state` read taken at the start of the run. Fixed (fresh fetch in
`report()`); `--status` was already correct.

### Recovery tooling (2026-09-24) — proposal from the terminal, decoded, rehearsed

**The Squads web app refuses a re-used buffer address** ("This buffer is
already in this squad"). It keeps its own off-chain list of upgrades keyed by
buffer address; #15 used `EdmGZHL5…`, so the re-staged buffer at the same
address (the staging script's named keypair, by design) is rejected by the form.
Nothing on chain is affected: the multisig's `transaction_index` did not move
and the buffer sits there with the vault as authority. It is bookkeeping, not
a warning about the funds.

**Multisig facts, read from chain:** `C43Ddmgt3iC9PTeHLyiQvtUtFAXC7U2v3d7KyzdF5YzY`,
threshold 2 of 3, members `9YN7…` (the deployer), `E8BPQi8V…`, `EGHZWuxM…`,
all with full permissions (mask 7); vault 0 = `fk5YYWb…`; `transaction_index`
16 after the incident. The deployer being a member is what makes the fallback
possible without anyone's browser wallet key.

- **`scripts/solana/propose-squads-upgrade.mjs`** creates the VaultTransaction +
  Proposal from the terminal (creator = the deployer). It reads every fact from
  chain first and refuses on any mismatch: cluster by genesis, creator not a
  member with Initiate, vault ≠ the program's upgrade authority, vault ≠ the
  buffer's authority, **buffer bytes ≠ the binary certified for that program id**
  (`config/solana/launchpad-binary.certification.json`,
  `config/solana/treasury-binary.certification.json` — the check nothing had
  on 2026-09-24; a program without a certification file is refused outright),
  buffer ≠ `--candidate`, allocation too small, proposal index already taken.
  Dry-run by default (reads + simulation); `--send` sends and then runs
  `decode-squads-proposal.mjs` on the new account. **It never approves.**
  Approvals happen in the app, after the decoder has said MATCHES.
- **`scripts/solana/rehearse-squads-upgrade-proposal.sh`** proved it end to end
  (2026-09-24, ~3 min): Squads v4 cloned from mainnet, the launchpad's real
  program + ProgramData dumped from mainnet (authority re-homed to a fresh
  2-of-3 multisig's vault, slot zeroed), propose → decoder MATCHES → three
  refusals including the incident shape → 2 approvals → execute → deployed ==
  candidate, buffer closed, spill paid. Run it before any change to the propose
  script.
- **Validator artefact:** `--upgradeable-program` at genesis flags ProgramData
  `executable: true`; mainnet's is `false`. A CPI `Upgrade` into such an account
  fails `ExecutableDataModified`. Load `--account` dumps instead.
- `@sqds/multisig@2.1.4` is in `tests/solana`; the scripts resolve modules
  through `tests/solana/package.json`, so they run from the repo root.
- The Squads v4 program itself is immutable (ProgramData has no authority).


### Treasury upgrade rehearsed on cloned mainnet state (2026-09-26)

`bash scripts/solana/rehearse-mainnet-treasury-upgrade.sh` -- PASS. The live treasury (ProgramData +
all 20 accounts) cloned read-only into a local validator, authority re-homed to a fresh 2-of-3
Squads vault, extend +130104, candidate `1840a9e7…` staged, `propose-squads-upgrade.mjs` -> decoder
MATCHES, launchpad bytes into the treasury refused, 2 approvals, execute, deployed == candidate.
Then the post-upgrade runbook on the upgraded program: 20/20 existing accounts decode;
`initialize_mwl_vault`; `set_arena_receivers` (MWL -> mwl_vault, protocol unchanged);
`initialize_reward_poster` (3 caps); poster roots in league_vault / monthly_league_vault / mwl_vault
with poker places, first and last rank claimed from the right vault; poster recruiter batch of the
vault's real 671407 lamports claimed; `flush_operator_fill`. Launchpad has **no** change since the
certified `e6ed7df3…`: only the treasury is upgraded. Epochs the old authority job already sealed
(3 on mainnet, all unclaimed) are never overwritten by the poster.

### Solana treasury `1840a9e7` -- UPGRADED ON MAINNET (2026-09-26)

Extend +130104 (0.661 SOL), buffer `9fVe2xXs…` staged and byte-verified independently, Squads #22
created from the terminal (decoded twice: MATCHES), executed `3gLMzAzS…` in slot 450767715.
Verified: ProgramData == `1840a9e7` + zeros, authority `fk5YYWb…`, buffer closed, rent back
(deployer 8.05 SOL), launchpad untouched (slot 449877289). Pending but harmless: Squads #21 is a
SetRentCollector config change (-> vault), 1 rejection.
Post-upgrade, read back from chain: `mwl_vault` `PCDQmFBr…` created and the arena MWL receiver moved
there from `68FNN…` (protocol receiver `BvQHb…` unchanged); reward poster `5PKtjVSf…` (key
`~/.config/memewarzone/mwz-reward-poster.json`, funded 0.1 SOL) with caps airdrop 50 / league 50 /
recruiter+squad 20 SOL. Servers still to do: `SOLANA_REWARD_POSTER_SECRET` on indexer + API, remove
`SOLANA_REWARDS_AUTHORITY_SECRET_KEY` from the indexer, Monday Coolify tasks
`cron:export-recruiter-settlement-batch` (00:30) then `cron:publish-recruiter-settlement-root` (00:45).


## 5. One combined release (founder decision, 2026-09-23)

**Solana does not go up on its own.** Both programs are finished, certified and
staged, and they wait for BNB and Robinhood. The release is a single event: the
new launchpad contracts deployed on BNB and Robinhood, both Solana programs
upgraded through Squads, everything tested together, then put live.

The reason is that a launchpad that accepts binding tokens and a battle system
that pays 75/20/5 are the same product change across three chains. Shipping
Solana early means running two economics for however long the others take, and
proving the combination only afterwards.

Done and waiting:

1. ~~Solana launchpad: Token-2022 quote assets at graduation.~~ Certified
   `e6ed7df3…`, devnet byte-verified, 20-test gate, bound graduation proven end
   to end at 1178/1232 bytes, creator confirmation dialog live in production.
2. ~~Solana treasury: competition V2 at 75/20/5.~~ Certified `1028f6f8…`, 14-test
   gate, 47/47 instructions executed, support refunds fixed, cancellation
   removed, mainnet initializer rehearsed.

Remaining before the release:

3. **BNB** — factory/launchpad contracts for binding tokens and the battle system.
4. **Robinhood** — the same, on its own chain.
5. Then: stage both Solana buffers → Squads executes both → `init-arena-mainnet.mjs`
   → canary → `--open` → test the whole thing across all three chains → live.

The production port bundle and the live-branch fast-forward are already done
(2026-09-22): `api.memewar.zone` and the indexer both run the expansion tree on
the production database.


