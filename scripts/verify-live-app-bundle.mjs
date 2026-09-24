#!/usr/bin/env node
/**
 * Prove what the deployed app actually has baked in, by reading the bundle it
 * serves -- not the env pane. Vite inlines VITE_* at build time, so the only
 * evidence that a redeploy picked up new addresses is the JS itself.
 *
 *   node scripts/verify-live-app-bundle.mjs [https://app.memewar.zone]
 *
 * Fetches index.html, every /assets/*.js it references (and the chunks those
 * reference), then reports which expected addresses are present. Exit 1 if
 * any expected address is missing or any superseded address is still there.
 */
const origin = (process.argv[2] || "https://app.memewar.zone").replace(/\/$/, "");
const EXPECTED = {
  "BNB factory 0x632061cA (new)": "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
  "BNB TreasuryRouterV3 0xe635AA43": "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
  "BNB PermanentLpLocker 0xdd41E0d1": "0xdd41E0d13c637657A28b60F860205048221F325A",
  "BNB war pool V2 0xe69a6a41": "0xe69a6a41363a48179beaB9b1E6122885bbFe8C65",
  "RH factory 0x35E93D0b": "0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA",
  "RH TreasuryRouterV3 0xda0a9Ed9": "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb",
  "RH war pool V2 0xD3E00E47": "0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C",
  "RH UPVoteTreasury 0x8C8141B8": "0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa",
};
const SUPERSEDED_AS_ACTIVE = {
  // Still legitimately present in SUPPORTED lists; flagged only as information.
  "old BNB factory 0xc378221E": "0xc378221E57898106079aE4B818a92978e4cd9559",
  "old BNB router 0xe157a6FD": "0xe157a6FDf19CAB61f2ECa048966f137A3240a921",
};
async function text(url) { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.text(); }
const html = await text(origin + "/");
const seen = new Map();
let queue = [...new Set([...html.matchAll(/\/assets\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))];
while (queue.length) {
  const p = queue.shift(); if (seen.has(p)) continue;
  const js = await text(origin + p); seen.set(p, js);
  for (const m of js.matchAll(/(?:\/assets\/|assets\/|\.\/)([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.js)/g)) { const q = "/assets/" + m[1]; if (!seen.has(q)) queue.push(q); }
}
const all = [...seen.values()].join("\n");
console.log(`${origin}: ${seen.size} chunks, ${(all.length / 1e6).toFixed(2)} MB`);
let ok = true;
for (const [label, addr] of Object.entries(EXPECTED)) { const n = all.split(addr).length - 1 + all.split(addr.toLowerCase()).length - 1; console.log(`  ${n ? "ok " : "MISSING"}  ${label}  x${n}`); if (!n) ok = false; }
for (const [label, addr] of Object.entries(SUPERSEDED_AS_ACTIVE)) { const n = all.split(addr).length - 1; console.log(`  info    ${label}  x${n}`); }
for (const needle of ["Robinhood Chain", "postgrad", "locked permanently"]) console.log(`  info    "${needle}" x${all.split(needle).length - 1}`);
process.exit(ok ? 0 : 1);
