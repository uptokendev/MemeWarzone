#!/usr/bin/env bash
# Dependencies for the Doppler rehearsal, pinned. Only types and interfaces are compiled here; the
# Doppler contracts themselves are the ones deployed on Robinhood Chain (read through a fork).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p lib
fetch() { # dir url commit
  [ -d "lib/$1/.git" ] || git clone -q --filter=blob:none "$2" "lib/$1"
  git -C "lib/$1" checkout -q "$3"
}
fetch forge-std https://github.com/foundry-rs/forge-std 8b531a016f15f761a632f5149a828228573420fc
fetch v4-core https://github.com/Uniswap/v4-core 80311e34080fee64b6fc6c916e9a51a437d0e482
echo "deps ready"
