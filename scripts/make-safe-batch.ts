/**
 * Build a Safe Transaction Builder batch from compiled ABIs.
 *
 * The Builder imports a JSON file and shows each call decoded, so the founder
 * reviews "setRecruiterRewardsVault(newVault: 0x40ac…)" rather than hex. Every
 * `data` here is encoded from the artifact ABI and then re-encoded through an
 * independent Interface and compared, so the hex the Safe signs and the method
 * the Builder displays cannot disagree. The shape mirrors
 * deployments/bscMainnet.post-deploy.safe-batch.json, which imported cleanly
 * before (no checksum field: the Builder computes its own).
 *
 * Usage (plain node, no network):
 *   npx ts-node scripts/make-safe-batch.ts <out.json> <chainId> "<name>" "<description>" <calls.json>
 * where calls.json is [{ "contract": "TreasuryRouterV3", "to": "0x…", "fn": "setRecruiterRewardsVault", "args": ["0x…"] }, …]
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

type Call = { contract: string; to: string; fn: string; args: unknown[] };

function artifactAbi(contract: string): any[] {
  const dir = path.join(__dirname, "..", "artifacts", "contracts");
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === `${contract}.json`) hits.push(p);
    }
  };
  walk(dir);
  if (hits.length !== 1) throw new Error(`expected exactly one artifact for ${contract}, found ${hits.length}`);
  return JSON.parse(fs.readFileSync(hits[0], "utf8")).abi;
}

export function buildBatch(chainId: number, name: string, description: string, calls: Call[]) {
  const transactions = calls.map((call) => {
    const abi = artifactAbi(call.contract);
    const fragment = abi.find((f: any) => f.type === "function" && f.name === call.fn);
    if (!fragment) throw new Error(`${call.contract} has no function ${call.fn}`);
    if (fragment.inputs.length !== call.args.length) throw new Error(`${call.fn} takes ${fragment.inputs.length} args, got ${call.args.length}`);
    const iface = new ethers.Interface([fragment]);
    const data = iface.encodeFunctionData(call.fn, call.args as any[]);
    // Independent re-encoding from a human-readable signature.
    const sig = `function ${call.fn}(${fragment.inputs.map((i: any) => `${i.type} ${i.name}`).join(",")})`;
    const check = new ethers.Interface([sig]).encodeFunctionData(call.fn, call.args as any[]);
    if (check.toLowerCase() !== data.toLowerCase()) throw new Error(`encoding disagreement for ${call.fn}`);
    const contractInputsValues: Record<string, string> = {};
    fragment.inputs.forEach((input: any, i: number) => { contractInputsValues[input.name] = String(call.args[i]); });
    return {
      to: ethers.getAddress(call.to),
      value: "0",
      data,
      contractMethod: {
        inputs: fragment.inputs.map((i: any) => ({ internalType: i.internalType, name: i.name, type: i.type })),
        name: call.fn,
        payable: fragment.stateMutability === "payable",
      },
      contractInputsValues,
    };
  });
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.16.5" },
    transactions,
  };
}

/** Re-derive every data field from the decoded method and values; used after writing. */
export function verifyBatchFile(file: string, expectedChainId: number, expectedTo?: string) {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  if (batch.chainId !== String(expectedChainId)) throw new Error(`chainId ${batch.chainId} != ${expectedChainId}`);
  if (batch.meta?.checksum) throw new Error("unexpected checksum field; the Builder computes its own");
  for (const tx of batch.transactions) {
    if (expectedTo && tx.to.toLowerCase() !== expectedTo.toLowerCase()) throw new Error(`tx to ${tx.to} != ${expectedTo}`);
    if (tx.value !== "0") throw new Error(`tx ${tx.contractMethod.name} carries value ${tx.value}`);
    const sig = `function ${tx.contractMethod.name}(${tx.contractMethod.inputs.map((i: any) => `${i.type} ${i.name}`).join(",")})`;
    const args = tx.contractMethod.inputs.map((i: any) => tx.contractInputsValues[i.name]);
    const data = new ethers.Interface([sig]).encodeFunctionData(tx.contractMethod.name, args);
    if (data.toLowerCase() !== tx.data.toLowerCase()) throw new Error(`data mismatch on ${tx.contractMethod.name}`);
  }
  return batch;
}

if (require.main === module) {
  const [out, chainId, name, description, callsFile] = process.argv.slice(2);
  if (!out || !chainId || !name || !description || !callsFile) throw new Error("usage: make-safe-batch <out.json> <chainId> <name> <description> <calls.json>");
  const calls: Call[] = JSON.parse(fs.readFileSync(callsFile, "utf8"));
  const batch = buildBatch(Number(chainId), name, description, calls);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`);
  verifyBatchFile(out, Number(chainId));
  console.log(`wrote ${out} (${batch.transactions.length} transactions, chain ${chainId})`);
  for (const tx of batch.transactions) console.log(`  ${tx.contractMethod.name}(${Object.values(tx.contractInputsValues).join(", ")}) -> ${tx.to}`);
}
