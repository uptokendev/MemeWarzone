import fs from "node:fs"; import path from "node:path";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com", "confirmed");
if ((await conn.getGenesisHash()) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new Error("not devnet");
const to = new PublicKey("HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9");
let total = 0;
for (const dir of fs.readdirSync("/tmp").filter((d) => d.startsWith("mwz-dbc-prove-"))) {
  const file = path.join("/tmp", dir, "keys.json"); if (!fs.existsSync(file)) continue;
  for (const [name, v] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
    if (!Array.isArray(v)) continue; const kp = Keypair.fromSecretKey(Uint8Array.from(v));
    const bal = await conn.getBalance(kp.publicKey); if (bal <= 10_000) continue;
    try { await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: bal - 5000 })), [kp]); total += bal - 5000; }
    catch (e) { console.log(dir, name, "not swept:", e.message.split("\n")[0].slice(0, 80)); }
  }
}
console.log("swept", (total / 1e9).toFixed(4), "SOL; funder", (await conn.getBalance(to)) / 1e9);
