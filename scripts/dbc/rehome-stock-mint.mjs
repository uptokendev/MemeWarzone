#!/usr/bin/env node
/**
 * Local rehearsal only: copy a dumped Token-2022 mint account and point its mint authority, freeze
 * authority and pause authority at a local key. Every other byte stays as mainnet wrote it.
 *
 *   node rehome-stock-mint.mjs <in.json> <out.json> <authority pubkey>
 *
 * Layout: mint authority COption<Pubkey> at 0 (4 + 32), supply 36, decimals 44, initialized 45,
 * freeze authority COption<Pubkey> at 46 (4 + 32); account type at 165; TLV from 166 (u16 type,
 * u16 length). PausableConfig is type 26: authority (32) then paused (1).
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { PublicKey } = require("@solana/web3.js");

const [input, output, authorityText] = process.argv.slice(2);
if (!input || !output || !authorityText) throw new Error("usage: rehome-stock-mint.mjs <in.json> <out.json> <authority>");
const authority = new PublicKey(authorityText).toBuffer();
// Parse only to read; write by replacing the data string in the original text, because JSON.parse
// turns rentEpoch (u64::MAX) into a float the validator refuses.
const text = fs.readFileSync(input, "utf8");
const dump = JSON.parse(text);
const original = dump.account.data[0];
const data = Buffer.from(original, "base64");
if (data.length <= 166 || data[165] !== 1) throw new Error("not a Token-2022 mint with extensions");

data.writeUInt32LE(1, 0);
authority.copy(data, 4);
data.writeUInt32LE(1, 46);
authority.copy(data, 50);

let offset = 166;
let pausable = false;
while (offset + 4 <= data.length) {
  const type = data.readUInt16LE(offset);
  const length = data.readUInt16LE(offset + 2);
  if (type === 0 && length === 0) break;
  if (type === 26) {
    if (length < 33) throw new Error("PausableConfig shorter than 33 bytes");
    authority.copy(data, offset + 4);
    pausable = true;
  }
  offset += 4 + length;
}
if (!pausable) throw new Error("mint has no PausableConfig");

if (text.split(original).length !== 2) throw new Error("data string not unique in the dump");
fs.writeFileSync(output, text.replace(original, data.toString("base64")));
console.log(`==> ${dump.pubkey}: mint, freeze and pause authority -> ${authorityText}`);
