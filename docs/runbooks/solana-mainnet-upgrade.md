# Solana mainnet upgrade runbook

Written for whoever executes the deploy, working alone, possibly tired. Every
command is copy-paste. Every step says what "good" looks like, so you never have
to guess whether it worked.

**What this upgrade delivers**

- Tokens carry Metaplex metadata, so they show a name and image in Phantom,
  Jupiter, Solscan and DexScreener instead of a raw address.
- New campaigns are tradeable the moment they are created, with no backfill.
- Graduation to a Meteora DAMM v2 pool works, and a keeper can run it
  automatically.

**What was proven on devnet**: create, buy, sell, curve close, manual
graduation, and an unattended keeper graduation. Two tokens graduated.

---

## Values you will need

| Thing | Value |
|---|---|
| Program id | `3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt` |
| Program data account | `9y6db1TSRHuMk1FK2GdLDYG4frdFH1z1wWtu2d1v5qM6` |
| Upgrade authority | `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv` |
| Treasury operator (graduation) | `fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv` |
| Route signer | `7hKQd798Z1ERmRUhm7shmstB1V13FQNnDLqtYjZBuJUz` |
| Expected program sha256 | `50b73ab990360c2de785dcc7023da9bfe8d22173e7ba4d57a45b7c57d5753804` |
| Expected IDL sha256 | `1c6002b536c19257134e2ac63af232b9c55733c433fcb6177c5f3ffbc0295d78` |
| Old (frozen) lookup table | `AoX2EzL4i2Zb62LjsGU9xWKXbjG9CU5DGH58vxFEYJev` |

---

## Step 0 — Before you start

Creates are already disabled in production
(`SOLANA_CREATE_AUTH_ENABLED=false`). **Leave them disabled until step 8.**

You need:

- the upgrade authority keypair for `fk5YYWb4…`
- about **10 SOL** on that wallet: ~6 for the program buffer, ~0.5 for the
  lookup table, the rest is headroom
- `solana --version` reporting 1.18.x

```bash
solana balance fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv --url mainnet-beta
```

Good: at least 10 SOL.

---

## Step 1 — Build, and check you built the right thing

```bash
git checkout build/cross-chain-stabilization-rh-base && git pull
cargo-build-sbf --manifest-path programs/memewarzone_solana/Cargo.toml
sha256sum target/deploy/memewarzone_solana.so
```

**Good**: `50b73ab990360c2de785dcc7023da9bfe8d22173e7ba4d57a45b7c57d5753804`

If it differs, the source is not what was proven on devnet. Stop and find out
why before going further.

Regenerate the IDL. Note `anchor idl build` writes to **stdout**, not the file,
which is easy to miss:

```bash
anchor idl build --program-name memewarzone_solana > /tmp/idl.json
sha256sum /tmp/idl.json
cp /tmp/idl.json target/idl/memewarzone_solana.json
```

**Good**: `1c6002b536c19257134e2ac63af232b9c55733c433fcb6177c5f3ffbc0295d78`

> Do **not** use `scripts/solana-resume-v2-upgrade.sh`. It copies the unstripped
> 1.57 MB artifact over the stripped one, and that does not fit the program
> account.

---

## Step 2 — Confirm the program account is big enough

```bash
solana program show 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt --url mainnet-beta
```

Read **Data Length**. It should be **1245400** or more; the new binary is
1195864 bytes.

If it is smaller, extend it first, or the deploy fails outright:

```bash
solana program extend 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt 60000 \
  --url mainnet-beta --keypair <upgrade-authority.json>
```

Also note the current **Last Deployed In Slot** — you will compare against it in
step 6.

---

## Step 3 — Create a new lookup table (required for graduation)

The existing table `AoX2EzL…` was created **without an authority**. It can never
be extended, and graduation needs to add Meteora accounts to it. Without a new
table, no mainnet token can graduate.

```bash
solana address-lookup-table create \
  --url mainnet-beta \
  --keypair <upgrade-authority.json> \
  --authority fk5YYWb4ppwbFqME8YRugirMSaNfhGgPP3GjfMbbfGv
```

Write down the **Lookup Table Address** it prints. Call it `NEW_ALT`.

Then fill it with the fifteen launchpad addresses:

```bash
solana address-lookup-table extend <NEW_ALT> \
  --url mainnet-beta --keypair <upgrade-authority.json> \
  --addresses 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt,B9NnmsXRQkZDr9LWwTnTU86mb26Uc5zp7G5gxdb6Jg5U,Ed25519SigVerify111111111111111111111111111,ComputeBudget111111111111111111111111111111,Sysvar1nstructions1111111111111111111111111,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL,11111111111111111111111111111111,2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX,FAKPndjQa3XppkNdk8SDGGWbZG2cPWJWhsDR2EWE9yWK,BE9ubLmT1M1N976ABCc9DpYo4iaeRJ4DHEXLCksrGQk4,68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg,54WorKCYLiV3SGe4jcRGLBcdSvvQFggm9mgrBavAkZ53,HBAidAC6D51S7TAzNmMpZBAEp74Ld6tj9KnVXLH3mN55,BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que
```

Verify:

```bash
solana address-lookup-table get <NEW_ALT> --url mainnet-beta
```

**Good**: `Authority` is set (not "none"), 15 entries, "still active".

> **Do not freeze this table.** The graduation operator extends it with Meteora
> accounts the first time each new pool is created. A frozen table is how the
> old one became unusable.

---

## Step 4 — Deploy the API and frontend

Deploy `build/cross-chain-stabilization-rh-base` to the production API and
frontend, with these env changes:

**API — change:**

```
SOLANA_LAUNCHPAD_IDL_SHA256     = 1c6002b536c19257134e2ac63af232b9c55733c433fcb6177c5f3ffbc0295d78
SOLANA_LAUNCHPAD_PROGRAM_SHA256 = 50b73ab990360c2de785dcc7023da9bfe8d22173e7ba4d57a45b7c57d5753804
SOLANA_LAUNCHPAD_ALT_ADDRESS    = <NEW_ALT>
```

**Frontend — change:**

```
VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS = <NEW_ALT>
```

**Leave alone** (these are mainnet-specific and copying staging's will break
everything): `SOLANA_CLUSTER`, `SOLANA_RPC_URL`,
`SOLANA_GENERATION_MANIFEST_HASH`, `SOLANA_CLUSTER_HASH_HEX`,
`SOLANA_ROUTE_SIGNER_SECRET_KEY`.

> The frontend **must** be rebuilt. The create instruction now passes 18
> accounts instead of 16; an old bundle will fail every create.

Creates are still disabled, so nothing is live yet.

---

## Step 5 — Deploy the program

```bash
solana program deploy target/deploy/memewarzone_solana.so \
  --program-id 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt \
  --url mainnet-beta \
  --keypair <upgrade-authority.json> \
  --upgrade-authority <upgrade-authority.json>
```

---

## Step 6 — Verify what is actually running

```bash
solana program show 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt --url mainnet-beta
```

**Good**: `Last Deployed In Slot` differs from what you noted in step 2.

Now confirm the bytes on chain are the bytes you tested:

```bash
solana program dump 3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt /tmp/onchain.so --url mainnet-beta
head -c 1195864 /tmp/onchain.so | sha256sum
```

**Good**: `50b73ab990360c2de785dcc7023da9bfe8d22173e7ba4d57a45b7c57d5753804`

This step is worth the minute. It proves the upload completed and was not
truncated or stale.

---

## Step 7 — Smoke test before reopening

```bash
curl -s -X POST https://api.memewar.zone/api/solana/direct-create \
  -H 'content-type: application/json' \
  -d '{"operation":"preflight","chainId":101,"creatorWallet":"<any wallet>"}'
```

**Good**: `{"ok":true,"cluster":"solana-mainnet-beta",...}`

**Bad**: `SOLANA_CREATE_CONFIGURATION_INCOMPLETE` — read the `message` field, it
names the missing variable. Fix it before reopening.

---

## Step 8 — Reopen creates

```
SOLANA_CREATE_AUTH_ENABLED = true
```

Restart the API.

---

## Step 9 — Launch one token yourself, first

Before telling anyone. Create a token, then check:

1. It appears on Explore
2. Buy a small amount from a second wallet — it must **not** say
   "market initializing"
3. Paste the mint into Phantom — it must show **name and symbol**, and the image
   once the metadata URL resolves

If all three pass, the upgrade is good.

Then run the Kaiju88 retire and ticker release:
`database/prod_kaiju88_retire_and_free_ticker.sql` (read it first), then
`..._apply.sql`. Tell the creator they can relaunch.

---

## Step 10 — Graduation (optional, can wait)

Graduation works but is **manual** until you enable the keeper.

To graduate a campaign by hand:

```bash
SOLANA_RPC_URL=<mainnet rpc> \
SOLANA_LAUNCHPAD_PROGRAM_ID=3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt \
SOLANA_LAUNCHPAD_IDL=target/idl/memewarzone_solana.json \
SOLANA_LAUNCHPAD_ALT_ADDRESS=<NEW_ALT> \
SOLANA_GRADUATION_ALT_AUTHORITY_KEYPAIR=<upgrade-authority.json> \
SOLANA_TREASURY_OPERATOR_KEYPAIR=<upgrade-authority.json> \
SOLANA_ROUTE_SIGNER_KEYPAIR=<route-signer.json> \
node scripts/solana/graduate-campaign.mjs <campaign-pda>
```

It prints a plan and stops. Add `SOLANA_GRADUATION_SEND=true` to actually send.

To enable the keeper on the indexer:

```
ENABLE_SOLANA_GRADUATION_RECONCILER = 1
SOLANA_GRADUATION_HANDOFF_COMMAND   = node scripts/solana/graduate-campaign.mjs
```

plus the same keypair and ALT variables above.

> **Before running the keeper unattended**, split `treasury_operator` from the
> upgrade authority. Today both are `fk5YYWb4…`, so a keeper running around the
> clock holds the key that can replace the program.

---

## If something goes wrong

**Creates fail after the upgrade** → set `SOLANA_CREATE_AUTH_ENABLED=false`.
Nothing can be created, nothing is damaged, and you have time.

**You need the old program back** → redeploy the previous `.so` with the same
command as step 5. Tokens created under the new program keep their metadata
regardless.

**A campaign is stuck mid-graduation** → the operator is idempotent. Run it
again; it re-reads the chain and picks up where it left off.

---

## Still outstanding after this deploy

- Rotate the route signer to a wallet you control. It is the same key on devnet
  and mainnet, and it authorises every launch.
- Split `treasury_operator` from the upgrade authority.
- Tear down the orphaned Railway deployment that still holds production Supabase
  credentials.
- Delete the stray GitHub environments named `BSC_TESTNET_RPC`,
  `BSC_MAINNET_RPC` and `BSC_TESTNET_PRIVATE_KEY`; they hold real credentials
  nothing reads.
