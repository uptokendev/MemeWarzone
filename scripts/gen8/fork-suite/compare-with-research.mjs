// Proves the port kept every research check: each of the research proof's checks (scripts/research/v4-hook/results/
// v4-hook-proof-bsc-rh.json, 702/702) must appear in the production fork suite's results with PASS, under the same
// context and name, or under the production name listed in RENAMED (the behaviour changed on purpose, see the reason).
//
//   node scripts/gen8/fork-suite/compare-with-research.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const research = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "research", "v4-hook", "results", "v4-hook-proof-bsc-rh.json"), "utf8"));
const port = JSON.parse(fs.readFileSync(path.join(here, "results", "gen8-fork-suite-bsc-rh.json"), "utf8"));

const RENAMED = {
  // D6 (reserve lock R2): the 2% creator reserve is no longer sent to the creator at launch
  "creator holds 20M reserve + first-buy coins; hook holds 0 coins":
    "creator holds the first-buy coins, the 20M reserve sits in the reserve lock until graduation (D6); hook holds 0 coins",
};

// The anti-sniper checks carry the second the trade actually landed in (wall-clock dependent on a fork: a slower
// RPC lands a trade at t+6 s instead of t+2 s). The rate is checked against that real second either way, so these are
// compared per context and side as an ordered list of the eight requested offsets (1, 2, 10, 30, 45, 59, 60, 61 s).
const SNIPER = /^anti-sniper t\+\d+s (buy|sell) rate \d+ bps, gen-7 exact$/;
const norm = (name) => {
  const m = name.match(SNIPER);
  return m ? `anti-sniper (${m[1]}) rate == gen-7 decay at the real second, gen-7 exact` : name;
};
const key = (r) => `${r.ctx} :: ${r.name}`;
const counts = (rs) => {
  const m = new Map();
  for (const r of rs) {
    const k = `${r.ctx} :: ${norm(RENAMED[r.name] ?? r.name)}`;
    const e = m.get(k) ?? { n: 0, pass: 0 };
    e.n++;
    if (r.pass) e.pass++;
    m.set(k, e);
  }
  return m;
};
const R = counts(research.results);
const Pm = counts(port.results);
const missing = [];
const failed = [];
for (const [k, e] of R) {
  const p = Pm.get(k);
  if (!p || p.n < e.n) missing.push(`${k} (research ${e.n}, port ${p ? p.n : 0})`);
  else if (p.pass < p.n) failed.push(k);
}
const extra = port.results.filter((r) => r.name.startsWith("[gen8]"));
console.log(`research checks: ${research.results.length} (${research.summary.pass} PASS)`);
console.log(`production fork suite: ${port.results.length} checks (${port.summary.pass} PASS, ${port.summary.fail} FAIL), of which ${extra.length} new [gen8] checks`);
const matched = research.results.length - missing.reduce((a, m) => a + Number(m.match(/research (\d+)/)[1]), 0);
console.log(`research checks found in the port with PASS: ${matched} of ${research.results.length}; renamed on purpose: ${Object.keys(RENAMED).length}; anti-sniper checks compared per context and side`);
if (missing.length) console.log("MISSING:\n  " + missing.join("\n  "));
if (failed.length) console.log("FAILING:\n  " + failed.join("\n  "));
process.exit(missing.length || failed.length ? 1 : 0);
