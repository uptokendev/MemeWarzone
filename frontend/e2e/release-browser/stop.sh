#!/usr/bin/env bash
# Stop services started by stack.mjs (all, or the names given).
LOGS="${MWZ_BROWSER_WORK:-$HOME/mwz-browser}/logs"
names="${*:-indexer api vite}"
for n in $names; do
  f="$LOGS/$n.pid"; [ -f "$f" ] || continue
  pid=$(cat "$f"); kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; rm -f "$f"; echo "stopped $n ($pid)"
done
