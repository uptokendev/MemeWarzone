#!/usr/bin/env node
/**
 * Submit the locally proven standard-JSON inputs to Blockscout's verification
 * API from a terminal, for every contract of a chain in the manifest.
 *
 * robinhoodchain.blockscout.com sits behind a Cloudflare challenge that only a
 * browser passes, so this script borrows your browser's clearance:
 *   1. In the browser where the explorer works, open DevTools -> Application ->
 *      Cookies -> https://robinhoodchain.blockscout.com and copy the value of
 *      `cf_clearance`.
 *   2. Copy the browser's User-Agent (DevTools console: navigator.userAgent).
 *   3. Run from the SAME machine/IP as that browser (the cookie is bound to it):
 *
 *   BLOCKSCOUT_CF_CLEARANCE=<cookie> BLOCKSCOUT_UA="<user agent>" \
 *     node scripts/blockscout-verify.mjs 4663 [--only LaunchFactory,RiskRegistry]
 *
 * For each address: skip if Blockscout already shows it verified, otherwise
 * POST /api/v2/smart-contracts/<address>/verification/via/standard-input with
 * the compiler version and the input file from
 * docs/build_plans/verification/<chain>/inputs/, then poll until Blockscout
 * reports is_verified. Sends no transactions.
 */
import fs from "node:fs";
import path from "node:path";

const chainId = String(process.argv[2] || "");
const only = (process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "").split(",").map((s) => s.trim()).filter(Boolean);
const HOSTS = { "4663": "https://robinhoodchain.blockscout.com" };
const host = process.env.BLOCKSCOUT_HOST || HOSTS[chainId];
if (!host) { console.error("no Blockscout host known for that chain; set BLOCKSCOUT_HOST"); process.exit(2); }
const cf = String(process.env.BLOCKSCOUT_CF_CLEARANCE || "").trim();
const ua = String(process.env.BLOCKSCOUT_UA || "").trim();
if (!cf || !ua) { console.error("BLOCKSCOUT_CF_CLEARANCE and BLOCKSCOUT_UA are required (see the header)"); process.exit(2); }
const headers = { "user-agent": ua, cookie: `cf_clearance=${cf}`, accept: "application/json" };
const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const dir = path.join(root, "docs", "build_plans", "verification", chainId);
const inputs = JSON.parse(fs.readFileSync(path.join(dir, "inputs.json"), "utf8"));
const compiler = inputs.compiler;

async function api(pathname, init = {}) {
  const r = await fetch(`${host}${pathname}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  if (/Just a moment|cf-chl|challenge-platform/i.test(text)) throw new Error("Cloudflare challenge: the cookie/UA pair is not accepted from this machine");
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// Ask the instance what it accepts before sending anything: compiler version
// strings and license identifiers differ between Blockscout versions.
const cfg = await api("/api/v2/smart-contracts/verification/config");
if (!cfg.json) { console.error(`could not read the verification config (HTTP ${cfg.status}): ${cfg.text.slice(0, 120)}`); process.exit(1); }
const versions = cfg.json.solidity_compiler_versions || [];
const compilerId = versions.find((v) => v === compiler) || versions.find((v) => v.includes("0.8.24") && v.includes("e11b9ed9"));
if (!compilerId) { console.error(`the instance does not list solc ${compiler}; it offers: ${versions.filter((v) => v.includes("0.8.24")).join(", ") || versions.slice(0, 5).join(", ")}`); process.exit(1); }
const licenses = cfg.json.license_types || {};
const licenseId = Object.prototype.hasOwnProperty.call(licenses, "mit") ? "mit" : Object.keys(licenses).find((k) => /^mit$/i.test(k)) || "mit";
console.log(`[blockscout] ${host}: compiler ${compilerId}, license ${licenseId}, standard-input verification ${cfg.json.is_rust_verifier_microservice_enabled === false ? "(legacy verifier)" : "(verifier microservice)"}`);

const summary = [];
for (const c of inputs.results) {
  if (only.length && !only.some((o) => c.name.includes(o))) continue;
  if (!c.bytecodeMatches) { summary.push([c.name, "skipped: input did not reproduce bytecode locally"]); console.log(`  skipped   ${c.name} (local bytecode mismatch)`); continue; }
  try {
    const before = await api(`/api/v2/smart-contracts/${c.address}`);
    if (before.json && (before.json.is_verified || before.json.is_fully_verified)) { summary.push([c.name, "already verified"]); console.log(`  already   ${c.name} ${c.address}`); continue; }
    const form = new FormData();
    form.set("compiler_version", compilerId);
    form.set("license_type", licenseId);
    form.set("autodetect_constructor_args", "true");
    form.set("files[0]", new Blob([fs.readFileSync(path.join(dir, c.file))], { type: "application/json" }), `${c.name}.standard-input.json`);
    const post = await api(`/api/v2/smart-contracts/${c.address}/verification/via/standard-input`, { method: "POST", body: form });
    if (post.status >= 300) throw new Error(`POST ${post.status}: ${post.text.slice(0, 200)}`);
    let state = "pending";
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const s = await api(`/api/v2/smart-contracts/${c.address}`);
      if (s.json && (s.json.is_verified || s.json.is_fully_verified)) { state = `verified${s.json.is_partially_verified ? " (partial)" : ""}`; break; }
    }
    summary.push([c.name, state]);
    console.log(`  ${state.padEnd(20)} ${c.name} ${c.address}${state === "pending" ? "  (still pending after 200s; check the page)" : ""}`);
  } catch (error) {
    summary.push([c.name, `FAILED ${String(error.message || error).slice(0, 160)}`]);
    console.log(`  FAILED    ${c.name} ${c.address}  ${String(error.message || error).slice(0, 160)}`);
    if (/Cloudflare challenge/.test(String(error.message))) break;
  }
}
console.log(`[blockscout] ${summary.length} processed: ${summary.filter(([, v]) => v.startsWith("verified") || v.startsWith("already")).length} verified, ${summary.filter(([, v]) => v.startsWith("FAILED")).length} failed`);
