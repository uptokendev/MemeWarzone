#!/usr/bin/env bash
# Reliable Anchor 0.30.1 build on this WSL setup.
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$HOME/.cargo/env"
export PATH="$HOME/.local/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export RUSTC_BOOTSTRAP=0
rustup override set 1.79.0 >/dev/null

# Ensure dated nightly is used for IDL (symlink created at setup time)
if [ ! -e "$HOME/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu" ]; then
  echo "Missing nightly toolchain symlink; see setup notes." >&2
  exit 1
fi

# Keep Cargo.lock at version 3 (Cargo 1.97 writes v4 which SBF cargo 1.75 cannot read)
if grep -q '^version = 4' Cargo.lock 2>/dev/null; then
  echo "Regenerating Cargo.lock as v3 with cargo 1.79..."
  rm -f Cargo.lock
  cargo +1.79.0 generate-lockfile
fi

anchor build --no-idl
# Delete the previous IDL first. The fallback below only wrote the file when it
# was missing or empty, so a stale IDL from an earlier build survived every
# rebuild and silently described the wrong program.
rm -f target/idl/memewarzone_solana.json
anchor idl build -p memewarzone_solana >/tmp/mwz-idl-build.log 2>&1 || true
# If anchor did not write files, extract JSON from log (fallback)
if [ ! -s target/idl/memewarzone_solana.json ]; then
  python3 - <<'PY'
import pathlib
text=pathlib.Path("/tmp/mwz-idl-build.log").read_text(errors="replace")
idx=text.rfind('{\n  "address"')
if idx<0: raise SystemExit("IDL JSON not found in log")
depth=0
for i,c in enumerate(text[idx:]):
    if c=='{': depth+=1
    elif c=='}':
        depth-=1
        if depth==0:
            pathlib.Path("target/idl").mkdir(parents=True, exist_ok=True)
            pathlib.Path("target/idl/memewarzone_solana.json").write_text(text[idx:idx+i+1])
            print("wrote target/idl/memewarzone_solana.json")
            break
PY
fi
echo "Artifacts:"
ls -la target/deploy/memewarzone_solana.so target/idl/memewarzone_solana.json
