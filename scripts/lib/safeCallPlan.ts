/**
 * Admin calls that the deployer cannot send, turned into a Safe Transaction Builder batch and simulated as
 * the Safe before anyone signs.
 *
 * The generation 6 adapters and the creator vault take the Safe as an immutable admin, so every route
 * change is a Safe transaction. A script that only knew how to send from its own signer would either
 * refuse (admin mismatch) or, worse, tempt someone to pass the Safe's owner key. Instead the caller builds
 * the calls, `simulateAsAdmin` replays each one with eth_call from the admin (read-only on a live RPC, the
 * same state a fork would execute against), and `writeSafeBatch` writes the batch through
 * scripts/make-safe-batch.ts, which re-encodes every call from the artifact ABI and checks it.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { buildBatch, verifyBatchFile } from "../make-safe-batch";

export type PlannedCall = { contract: string; to: string; fn: string; args: unknown[]; note?: string };

/** Encode one planned call from the compiled artifact (the same encoder the batch uses). */
export async function encodePlannedCall(call: PlannedCall): Promise<string> {
  const factory = await ethers.getContractFactory(call.contract);
  return factory.interface.encodeFunctionData(call.fn, call.args as any[]);
}

function revertText(error: any, iface: any): string {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch {}
    return `revert data ${data.slice(0, 74)}`;
  }
  return String(error?.shortMessage || error?.message || error).split("\n")[0];
}

/**
 * eth_call each planned call from `admin`, in order. Calls are independent state changes (route
 * configuration, one-shot binds), so a per-call eth_call against the current state is what the batch
 * would see; on a fork the rehearsal then executes the batch for real. Throws listing every refusal.
 */
export async function simulateAsAdmin(admin: string, calls: PlannedCall[], log: (line: string) => void = console.log) {
  const refusals: string[] = [];
  for (const call of calls) {
    const factory = await ethers.getContractFactory(call.contract);
    const data = factory.interface.encodeFunctionData(call.fn, call.args as any[]);
    try {
      await ethers.provider.call({ from: admin, to: call.to, data });
      log(`  sim ok   ${call.contract}.${call.fn}(${call.args.map(String).join(", ")}) -> ${call.to}`);
    } catch (error) {
      const why = revertText(error, factory.interface);
      refusals.push(`${call.contract}.${call.fn} on ${call.to}: ${why}`);
      log(`  sim FAIL ${call.contract}.${call.fn}(${call.args.map(String).join(", ")}) -> ${call.to}: ${why}`);
    }
  }
  if (refusals.length) throw new Error(`simulation as ${admin} refused ${refusals.length} call(s):\n  ${refusals.join("\n  ")}`);
}

/** Write and verify a Safe Transaction Builder batch; returns the parsed batch. */
export function writeSafeBatch(file: string, chainId: number, name: string, description: string, calls: PlannedCall[]) {
  const batch = buildBatch(chainId, name, description, calls.map(({ note: _note, ...c }) => c) as any);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
  verifyBatchFile(file, chainId);
  return batch;
}

/** Normalise a structured (tuple) argument so the Builder JSON and the re-encoder see plain values. */
export function tupleArg(values: Record<string, unknown>, order: string[]): unknown[] {
  return order.map((k) => {
    const v = values[k];
    return typeof v === "bigint" ? v.toString() : v;
  });
}
