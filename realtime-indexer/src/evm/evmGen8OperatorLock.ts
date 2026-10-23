/**
 * One in-process async lock per signing key (lowercase address). The gen-8 fee-routing worker (evmGen8FeeRouting.ts)
 * and the gen-8 creator-choice operator (evmGen8ChoicePass.ts) sign with the same EVM_GEN8_OPERATOR_KEY_<id>; each
 * holds this lock from reading its nonce until its transaction has a receipt (or its wait timed out), so the two never
 * sign the same nonce. FIFO; a throwing holder releases the lock. In-process only: both run in the indexer process.
 */
const tails = new Map<string, Promise<void>>();

export async function withOperatorLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const key = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) throw new Error(`operator lock needs an address, got ${address}`);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** True while some holder or waiter has the key's lock (tests and logs). */
export function operatorLockBusy(address: string): boolean {
  return tails.has(String(address || "").toLowerCase());
}
