#!/usr/bin/env node
/**
 * Read a Squads v4 vault transaction back from chain and say what it does.
 *
 * On 2026-09-24 a proposal meant to upgrade the rewards treasury carried the
 * launchpad's program id in its Program field. The loader's Upgrade does not
 * check that a buffer belongs to a program; it deployed the treasury binary
 * over the launchpad and the launchpad went down. The Squads UI's review did
 * not stop it. This does: decode the pending VaultTransaction, print the
 * BPFLoaderUpgradeable instruction by role, and refuse to say OK unless the
 * program, buffer, spill and authority are exactly the expected ones.
 *
 * Usage:
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/decode-squads-proposal.mjs <vaultTransactionPda> \
 *     [--program <id>] [--buffer <id>] [--spill <id>] [--authority <id>]
 *
 *   or, from an executed signature (to validate the decoder against history):
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/decode-squads-proposal.mjs --sig <signature> [...]
 *
 *   or, the newest pending vault transaction of a multisig (no address hunting):
 *   SOLANA_RPC_URL=<rpc> node scripts/solana/decode-squads-proposal.mjs --latest <multisigPda> [...]
 *
 * No SDK: the account is parsed by hand from the v4 layout, and the parser
 * refuses anything it cannot account for byte-by-byte.
 */
import { PublicKey, Connection } from "@solana/web3.js";

const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_IX = ["InitializeBuffer", "Write", "DeployWithMaxDataLen", "Upgrade", "SetAuthority", "Close", "ExtendProgram", "SetAuthorityChecked"];
const UPGRADE_ROLES = ["programData", "program", "buffer", "spill", "rentSysvar", "clockSysvar", "authority"];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "").trim() : ""; };
const rpc = String(process.env.SOLANA_RPC_URL || "").trim();
if (!rpc) { console.error("SOLANA_RPC_URL must be set"); process.exit(2); }
const conn = new Connection(rpc, "finalized");

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  pubkey() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)).toBase58(); this.o += 32; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  vec(fn) { const n = this.u32(); const out = []; for (let i = 0; i < n; i++) out.push(fn()); return out; }
  smallVec(fn) { const n = this.u8(); const out = []; for (let i = 0; i < n; i++) out.push(fn()); return out; }
}

/** Squads v4 VaultTransaction: discriminator(8) multisig creator index bump vault_index vault_bump ephemeral_signer_bumps message */
function decodeVaultTransaction(data) {
  const r = new Reader(data);
  r.bytes(8);
  const multisig = r.pubkey();
  const creator = r.pubkey();
  const index = r.u64();
  r.u8(); const vaultIndex = r.u8(); r.u8();
  r.vec(() => r.u8());
  // Standard borsh: every Vec carries a u32 length. (The first cut used
  // one-byte lengths and left 29 bytes unaccounted for on a real account.)
  const numSigners = r.u8(); const numWritableSigners = r.u8(); const numWritableNonSigners = r.u8();
  const accountKeys = r.vec(() => r.pubkey());
  const instructions = r.vec(() => {
    const programIdIndex = r.u8();
    const accountIndexes = r.vec(() => r.u8());
    const data = r.vec(() => r.u8());
    return { programIdIndex, accountIndexes, data: Buffer.from(data) };
  });
  const lookups = r.vec(() => ({ key: r.pubkey(), writable: r.vec(() => r.u8()), readonly: r.vec(() => r.u8()) }));
  return { multisig, creator, index, vaultIndex, numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, lookups, trailing: data.length - r.o };
}

function describeLoaderIx(programId, accounts, data) {
  const disc = data.length >= 4 ? data.readUInt32LE(0) : -1;
  const name = LOADER_IX[disc] ?? `unknown(${disc})`;
  const byRole = {};
  if (name === "Upgrade") UPGRADE_ROLES.forEach((role, i) => { byRole[role] = accounts[i] || "(missing)"; });
  return { programId, name, accounts, byRole };
}

function check(byRole) {
  const expected = { program: opt("--program"), buffer: opt("--buffer"), spill: opt("--spill"), authority: opt("--authority") };
  let ok = true; const lines = [];
  for (const [role, want] of Object.entries(expected)) {
    if (!want) { lines.push(`  ?    ${role.padEnd(10)} ${byRole[role]}   (no expectation given)`); continue; }
    const got = byRole[role]; const match = got && got.toLowerCase() === want.toLowerCase();
    if (!match) ok = false;
    lines.push(`  ${match ? "ok  " : "FAIL"} ${role.padEnd(10)} ${got}${match ? "" : `   expected ${want}`}`);
  }
  return { ok, lines, anyExpectation: Object.values(expected).some(Boolean) };
}

async function main() {
  let ixList = [];
  let source = "";
  const sig = opt("--sig");
  if (sig) {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx) throw new Error("transaction not found");
    source = `executed signature ${sig} (slot ${tx.slot}, err ${JSON.stringify(tx.meta.err)})`;
    const inner = (tx.meta.innerInstructions || []).flatMap((x) => x.instructions);
    for (const ix of [...tx.transaction.message.instructions, ...inner]) {
      const pid = String(ix.programId);
      if (pid !== LOADER) continue;
      if (ix.parsed) {
        const info = ix.parsed.info || {};
        const byRole = { programData: info.programDataAccount, program: info.programAccount, buffer: info.bufferAccount, spill: info.spillAccount, authority: info.authority };
        ixList.push({ programId: pid, name: ix.parsed.type, accounts: Object.values(byRole), byRole });
      } else {
        const bs58 = await import("bs58").then((m) => m.default || m).catch(() => null);
        const data = bs58 ? Buffer.from(bs58.decode(ix.data)) : Buffer.alloc(0);
        ixList.push(describeLoaderIx(pid, (ix.accounts || []).map(String), data));
      }
    }
  } else {
    let address = args.find((a) => !a.startsWith("--") && !Object.values({ a: opt("--program"), b: opt("--buffer"), c: opt("--spill"), d: opt("--authority"), e: opt("--latest") }).includes(a));
    const latestOf = opt("--latest");
    if (latestOf) {
      // VaultTransaction: discriminator(8) then multisig(32). Filter on that and take the highest index.
      const accounts = await conn.getProgramAccounts(new PublicKey(SQUADS), { commitment: "finalized", filters: [{ memcmp: { offset: 8, bytes: latestOf } }] });
      const parsed = [];
      for (const { pubkey, account } of accounts) {
        try { const vt = decodeVaultTransaction(account.data); if (vt.trailing === 0) parsed.push({ pubkey: pubkey.toBase58(), index: vt.index }); } catch { /* proposals, batches, config txs: not ours */ }
      }
      if (!parsed.length) throw new Error(`no VaultTransaction found for multisig ${latestOf}`);
      parsed.sort((a, b) => (a.index < b.index ? 1 : -1));
      address = parsed[0].pubkey;
      console.log(`newest VaultTransaction for ${latestOf}: index ${parsed[0].index} at ${address} (${parsed.length} on chain)`);
    }
    if (!address) throw new Error("give a VaultTransaction address, --latest <multisig>, or --sig <signature>");
    const info = await conn.getAccountInfo(new PublicKey(address), "finalized");
    if (!info) throw new Error(`no account at ${address}`);
    if (info.owner.toBase58() !== SQUADS) throw new Error(`${address} is owned by ${info.owner.toBase58()}, not the Squads v4 program`);
    let vt;
    try { vt = decodeVaultTransaction(info.data); } catch (e) { throw new Error(`not a VaultTransaction I can parse (${String(e.message || e)}) -- refusing to interpret`); }
    if (vt.trailing !== 0) throw new Error(`layout mismatch: ${vt.trailing} unparsed trailing bytes -- refusing to interpret`);
    source = `pending VaultTransaction ${address} (multisig ${vt.multisig}, index ${vt.index}, vault ${vt.vaultIndex}, creator ${vt.creator})`;
    for (const ix of vt.instructions) {
      const pid = vt.accountKeys[ix.programIdIndex];
      const accounts = ix.accountIndexes.map((i) => vt.accountKeys[i]);
      ixList.push(pid === LOADER ? describeLoaderIx(pid, accounts, ix.data) : { programId: pid, name: "(not the loader)", accounts, byRole: {} });
    }
  }

  console.log(`source: ${source}`);
  const loaderIxs = ixList.filter((ix) => ix.programId === LOADER);
  if (loaderIxs.length !== 1) { console.log(`expected exactly one BPFLoaderUpgradeable instruction, found ${loaderIxs.length}`); for (const ix of ixList) console.log(`  ${ix.programId} ${ix.name}`); process.exit(1); }
  const ix = loaderIxs[0];
  console.log(`instruction: BPFLoaderUpgradeable::${ix.name}`);
  if (ix.name !== "Upgrade" && ix.name !== "upgrade") { console.log("not an Upgrade -- refusing"); process.exit(1); }
  for (const [role, acct] of Object.entries(ix.byRole)) console.log(`  ${role.padEnd(12)} ${acct}`);
  const { ok, lines, anyExpectation } = check(ix.byRole);
  console.log("\nagainst expectations:"); for (const l of lines) console.log(l);
  if (!anyExpectation) { console.log("\n(no --program/--buffer/--spill/--authority given; decoded only)"); return; }
  console.log(ok ? "\nPROPOSAL MATCHES — safe to sign" : "\nPROPOSAL DOES NOT MATCH — DO NOT SIGN");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(String(e.message || e)); process.exit(2); });
