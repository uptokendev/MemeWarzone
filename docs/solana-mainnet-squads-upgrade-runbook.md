# Solana mainnet upgrades through Squads — runbook

**Written for:** the founder and whoever operates the Squads multisig.

**Status: nothing in this document has been executed.** Every figure below was read
from mainnet on 2026-09-22; no mainnet transaction has been sent. The treasury
upgrade remains on hold until explicitly released.

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
| Launchpad | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` | `9ee52111ccd5e9f22f32cd6314e864405388f22490efece264129b921b04cb4a` | 1222896 |
| Treasury | `2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX` | `5638c9923d2a3025197243ab6f62e565c832b6fa69d3ce4265abecc90594cdfc` | 1276472 |

Launchpad change: Token-2022 quote assets accepted at graduation, on the quote
side only. Treasury change: the Competition V2 entry split becomes 75/20/5,
matching `ArenaWarPoolTreasuryV2` on EVM.

## The one asymmetry that decides the order

| | Allocated on mainnet | Candidate | Verdict |
|---|---|---|---|
| Launchpad | 1310936 bytes | 1222896 | **Fits.** 88040 bytes spare. No extend. |
| Treasury | 660016 bytes | 1276472 | **Too small by 616456 bytes.** Must extend first. |

The launchpad can go straight to buffer + Squads upgrade. The treasury cannot:
an upgrade into an allocation that cannot hold the binary fails, so the extend
is a prerequisite, not a cleanup step.

## Cost, and which part is permanent

Current treasury ProgramData holds 4.59491544 SOL against a 3.35353152 SOL
requirement, so part of the extension is already funded.

| Item | SOL | Recovered? |
|---|---|---|
| Treasury extend top-up (to 6.485128 rent minimum) | ~1.890 | No — permanent rent |
| Buffer for the upload (per program) | 6.485128 | Yes — refunded when the upgrade consumes it |

The deployer `9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H` holds 13.24 SOL,
which covers either program's buffer plus the extend. The multisig itself holds
0.001 SOL and pays for none of this.

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
solana program extend 2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX 616456 \
  --url <mainnet-rpc> --keypair <deployer>
```

Confirm `Data Length` is at least 1276472 before continuing.

### 3. Write the buffer and hand it to the multisig

```
solana program write-buffer <candidate.so> \
  --url <mainnet-rpc> --keypair <deployer> \
  --with-compute-unit-price 10000 --max-sign-attempts 60 \
  --buffer <named-buffer-keypair>
solana program set-buffer-authority <BUFFER> \
  --new-buffer-authority fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv \
  --url <mainnet-rpc> --keypair <deployer>
```

Use a **named** buffer keypair. A 1.2MB upload is hundreds of write
transactions and a public RPC will drop enough of them to abort the deploy —
this happened on devnet, stranding a funded buffer whose only handle was a seed
phrase printed once. With a named keypair the buffer is recoverable by address,
resumable, and closable with `solana program close <BUFFER> --recipient <deployer>`.

Verify the buffer before proposing:

```
solana program dump <BUFFER> /tmp/buffer-check.so --url <mainnet-rpc>
sha256sum /tmp/buffer-check.so
```

A dumped buffer may carry trailing zero padding. The bytes the binary occupies
must equal the candidate and the remainder must be zero — the same check
`scripts/solana/program-upgrade-verify.cjs` applies. A plain hash comparison
will disagree with a perfectly good buffer.

### 4. Propose in Squads

Propose a `BPFLoaderUpgradeable::Upgrade` with:

- program: the program id from the table
- buffer: the address from step 3, authority already transferred to the multisig
- spill: the deployer (receives the buffer's reclaimed rent)
- authority: the multisig `fk5YYWb…`

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

`SOLANA_LAUNCHPAD_PROGRAM_SHA256` and `SOLANA_LAUNCHPAD_IDL_SHA256` are read by
the create and trade authorization paths, so an upgrade that lands without them
leaves those paths quoting evidence for a binary that is no longer deployed.

```
SOLANA_LAUNCHPAD_PROGRAM_SHA256=9ee52111ccd5e9f22f32cd6314e864405388f22490efece264129b921b04cb4a
SOLANA_LAUNCHPAD_IDL_SHA256=0f21550f5ac8a0279418a7ed74b66e21fd8c2f724d9a9e8ee4ab1a8ec8e26f40
SOLANA_LAUNCHPAD_PROGRAM_BYTES=1222896
```

`scripts/solana/network-canary.mjs` pins the same program hash and will fail
until it agrees.

## Outstanding before the treasury goes

- **The client cannot drive a Token-2022 quote yet.** `deriveAta` in
  `frontend/api/dev-fix/solana-graduation-authorization-v2.js` hardcodes the
  classic token program in the ATA seeds, so it derives the wrong account for a
  Token-2022 mint, and nothing appends the token program to the account list.
  The program accepts these assets; nothing can yet ask it to. This does not
  block the launchpad upgrade — classic-SPL graduations are unchanged — but the
  feature is not reachable until the client lands.
- **No end-to-end Token-2022 graduation exists.** Those paths are proven at byte
  level in Rust and by the allowlist tests, not through a pool.
- **A pre-existing orphaned buffer sits on devnet**,
  `HbmmrEjPJL7hvrk7DJrvwFSqqFoNz9yiyzoFxAmEzZZv`, holding 7.55857772 SOL on the
  devnet deployer's authority. It predates this work. Reclaim with
  `solana program close` if it is not wanted.
