# Solana mainnet upgrades through Squads — runbook

**Written for:** the founder and whoever operates the Squads multisig.

**Status: nothing in this document has been executed.** Every figure below was read
from mainnet on 2026-09-22; no mainnet transaction has been sent. The treasury
upgrade remains on hold until explicitly released.

Both gates were re-run on 2026-09-22 against the tree being shipped and the
launchpad certified the same `e6ed7df3…` in the table below, so step 1 is
already satisfied for this commit.

Both mainnet programs are owned by the Squads multisig
`fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv`, so the upgrade instruction itself
can only be executed by the multisig. Everything before it — writing the buffer,
extending the allocation — is permissionless and paid by the deployer.

## What is being deployed

Both candidates are certified by their local validator gates: create, bonding
lifecycle and a real graduation into pinned Meteora DAMM v2 for the launchpad;
the arena money path and every claim rail for the treasury. Both are already
running on devnet and byte-verified there.

| | Program | Candidate sha256 | Bytes |
|---|---|---|---|
| Launchpad | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` | `e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2` | 1218568 |
| Treasury | `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` | `1028f6f8a52037f1aea8ab2e6ae86f9e2c1224eed7e1e7b71675cdfca2508a95` | 1306640 |

Launchpad change: Token-2022 quote assets accepted at graduation, on the quote
side only. Treasury change: the Competition V2 entry split becomes 75/20/5,
matching `ArenaWarPoolTreasuryV2` on EVM.

## The one asymmetry that decides the order

| | Allocated on mainnet | Candidate | Verdict |
|---|---|---|---|
| Launchpad | 1310936 bytes | 1218568 | **Fits.** 92368 bytes spare. No extend. |
| Treasury | 660016 bytes | 1306640 | **Too small by 646624 bytes.** Must extend first. |

The launchpad can go straight to buffer + Squads upgrade. The treasury cannot:
an upgrade into an allocation that cannot hold the binary fails, so the extend
is a prerequisite, not a cleanup step.

## Cost, and which part is permanent

Read from mainnet with `solana rent` on 2026-09-22. A buffer account is
37 bytes of header plus the binary; a ProgramData account is 45 plus.

| Item | SOL | Recovered? |
|---|---|---|
| Launchpad buffer (37 + 1218568 B) | 6.19116364 | Yes — refunded to the spill account when the upgrade consumes it |
| Treasury buffer (37 + 1306640 B) | 6.63856940 | Yes — same |
| Treasury extend top-up | ~2.04369460 | **No — permanent rent** |

The treasury's ProgramData currently holds 4.59491544 SOL and would need
6.63861004 to be rent-exempt at the larger size, hence the top-up. The launchpad
needs no extend and therefore no permanent spend at all — its buffer comes back.

**The two cannot be staged at the same time.** Together they need 14.87342764
SOL against the deployer's 13.238843275 — short by 1.63458436. Sequential fits
with room: stage the launchpad, let Squads execute it, and its 6.19116364 returns
to the spill account before the treasury's extend and buffer are paid. Peak
requirement that way is 8.68226400 SOL.

The deployer `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` holds
13.238843275 SOL, which covers either program's buffer plus the extend. The
multisig itself holds 0.001 SOL and pays for none of this.

Note the standing rule: the deployer must never hold user money. It is the fee
payer here and nothing more.

## Sequence

Do the launchpad first. It needs no extend, so it exercises the whole
buffer-and-propose path with the simpler of the two programs.

### 1. Rebuild and re-certify from the commit being shipped

```
bash scripts/solana/run-local-sbf-gate.sh        # launchpad: create + lifecycle + graduation
bash scripts/solana/run-local-treasury-gate.sh   # treasury: arena money + claim rails
```

Both print the sha256 they certified. **It must equal the table above.** If it
does not, the tree is not what was verified and the upgrade stops here.

### 2. Extend the treasury allocation (treasury only, before its buffer)

Permissionless — the deployer pays, the multisig is not involved:

```
solana program extend 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX 646624 \
  --url <mainnet-rpc> --keypair <deployer>
```

Confirm `Data Length` is at least 1306640 before continuing.

### 3. Write the buffer and hand it to the multisig

One command does the whole staging — sha check, allocation check, upload,
byte-verify, authority transfer — and prints the Squads values at the end:

```
SOLANA_MAINNET_RPC_URL=<paid rpc> \
  bash scripts/solana/prepare-mainnet-squads-buffer.sh launchpad
```

It refuses the public `api.mainnet-beta.solana.com`. A 1.2MB upload is several
hundred write transactions, and when enough are dropped the deploy aborts with
the rent already spent — this happened on devnet and stranded 6.49 SOL. Use a
paid endpoint (Helius, QuickNode, Triton). `MWZ_ALLOW_PUBLIC_RPC=1` overrides,
but there is no good reason to.

The buffer keypair is **generated ahead of time and named**, so the address is
known before a lamport is spent, the upload resumes into the same account if it
aborts, and the rent is always recoverable:

| | |
|---|---|
| Buffer address | `EdmGZHL5fNGQuT8b8wRz5JbT4uhUwHyptuoSoBjLkJbg` |
| Keypair | `~/.config/memewarzone/mwz-launchpad-mainnet-buffer-e6ed7df3.json` |
| Recover | `solana program close EdmGZHL5… --recipient 9YN7WY8s… --url <rpc> --keypair <deployer>` |

The script verifies the uploaded bytes before transferring authority, using the
same check as `scripts/solana/program-upgrade-verify.cjs`: a dumped buffer may
carry trailing zero padding, so the bytes the binary occupies must equal the
candidate and the remainder must be zero. A plain `sha256sum` comparison will
disagree with a perfectly good buffer.

The treasury target is held in the script itself and exits 1 — it needs the
extend in step 2 and an explicit release first.

### 4. Propose in Squads

Propose a `BPFLoaderUpgradeable::Upgrade` with:

| Field | Value |
|---|---|
| Program | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` |
| Buffer | `EdmGZHL5fNGQuT8b8wRz5JbT4uhUwHyptuoSoBjLkJbg` |
| Spill (refund to) | `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` |
| Upgrade authority | `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv` |

The spill account receives the buffer's 6.19116364 SOL back when the upgrade
executes.

Confirm with signers that the buffer address in the proposal is the one whose
hash was verified in step 3. That address is the entire payload of this
ceremony — everything else in the proposal is fixed.

### 5. Verify after execution

```
solana program show <program-id> --url <mainnet-rpc>
solana program dump <program-id> /tmp/deployed.so --url <mainnet-rpc>
```

Check: `Last Deployed In Slot` advanced, `Authority` is still `fk5YYWb…`, and
the deployed bytes match the candidate with zero padding. `Data Length` stays at
the allocation, not the binary size — that is expected, not a failure.

### 6. Move the API env in the same change

Two variables, on the **live** API service (`api.memewar.zone`):

```
SOLANA_LAUNCHPAD_PROGRAM_SHA256=e6ed7df37dfe3bf8ec7914f7bcae9ebd50b21b0844cff80c2a851c64bfafdcb2
SOLANA_LAUNCHPAD_IDL_SHA256=6ad692989c7445ff079aecf185b23ebf54ceb2bfe21f3e9df06802c6b40b8a16
```

Be clear about what these do, so the urgency is judged correctly. Neither is
compared against the chain and neither enters the signed digest. `hashEnv` in
`solana-create-authorization-v4.js` checks they are present and 64 hex
characters — a missing or malformed value is a 503, a *wrong* value is accepted
— and they are then attached to every create authorization as
`auditMetadata.programBinarySha256` / `idlSha256`, and listed in the trade
readiness report. Of the env pins only `SOLANA_GENERATION_MANIFEST_HASH` is
checked against on-chain state.

So a stale hash does not break create, buy or sell. What it breaks is the audit
trail: every authorization would attest to a binary that is no longer deployed.
Move them with the upgrade, not after.

`SOLANA_LAUNCHPAD_PROGRAM_BYTES` is **not** an API variable — only
`scripts/solana/network-canary.mjs` reads it. It and the program hash both
default from `config/solana/launchpad-binary.certification.json`, which is the
single source for the certified binary; the canary runner, its shell wrapper and
the CI workflow each used to hold their own literal and two went stale behind the
devnet upgrade, leaving the canary rejecting the binary that was actually
deployed. Update that file when the certified binary changes and all three
follow.

## What a bound graduation needs, learned by running one

Gate B (`bash scripts/solana/run-local-sbf-gate.sh`) executes this against the
certified binary. Four things it will refuse:

- **The fee escrow must be flushed first.** `begin_graduation` rejects a
  campaign whose escrow still holds unflushed fees.
- **The acquisition pool price must agree with the binding.** The program checks
  the pool's implied price against the declared oracle and quote reference
  within `max_deviation_bps`. A pool seeded at $100/SOL while the binding
  declares $150 and a $1 quote is a 33% disagreement against a 1.5% cap, and the
  pool the graduation just created is rejected.
- **The initial Meteora price is whole units per whole token.** A raw
  quote-to-token ratio ignores decimals and drifts past tolerance.
- **Only the acquisition instruction is packed.** Its account setup goes out in
  its own transaction; see the headroom note above.

## Outstanding before the treasury goes

- ~~The UI must show the binding confirmation before this is useful.~~ **Done.**
  `/api/graduation/quote-assets` now returns `bindingRisks` on every asset,
  read from the verification snapshot, and `GraduationMarketStep` refuses to
  select a non-native quote without an explicit confirmation listing them. The
  dialog also carries the three consequences that hold for any binding whether
  or not a scan has run: the liquidity is locked forever, the price follows the
  quote, and the check happens once at graduation.
- **A bound graduation has 54 bytes of headroom.** Gate B drives a campaign from
  a closed curve to a bound Token-2022 pool in the production transaction shape,
  and the envelope is **1178 bytes against a 1232-byte hard limit**. It started
  at 1314 — over the limit — and reached 1178 by sending the acquisition setup
  and the Meteora ATA creates as their own transactions. The program requires
  the acquisition program to appear before Meteora in the same transaction, so
  the remainder cannot be split further. Anything that adds an account to that
  transaction — a longer route, an extra reward vault, a quote needing more tick
  arrays — eats into 54 bytes, and the failure is a hard size error at assembly
  rather than something the program can report. Watch this number.

  Where the bytes go, measured: 128B signatures, 260B `begin_graduation` args,
  144B Ed25519, 107B + 24B Meteora, 49B the Orca swap, 5B compute budget, 8B
  `confirm_graduation`, 87 account references.

  Two levers if a longer route ever eats the margin, both measured rather than
  estimated:
  - Moving the 2% fee and the 20% creator payout to a claim model removes 7
    accounts from `confirm_graduation` and saves **14 bytes** (1164B, 68B
    headroom). Small; do it for product reasons, not for bytes.
  - `begin_graduation` carries **128 bytes of pubkeys naming accounts the
    transaction already has** — `positionNftMint`, `quoteMint`,
    `acquisitionProgram`, `quoteRecoveryAccount`. Reading them from accounts
    instead trades 32 bytes of signed data for one account reference each. This
    is the real lever, and it is a digest schema change (v4 to v5) with matching
    client changes.
- **A pre-existing orphaned buffer sits on devnet**,
  `HbmmrEjPJL7hvrk7DJrvwFSqqFoNz9yiyzoFxAmEzZZv`, holding 7.55857772 SOL on the
  devnet deployer's authority. It predates this work. Reclaim with
  `solana program close` if it is not wanted.
