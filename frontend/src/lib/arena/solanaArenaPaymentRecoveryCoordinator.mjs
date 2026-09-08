export class ArenaPaymentReplacementBlockedError extends Error {
  constructor(message = "Authoritative Arena payment state does not permit a replacement transaction.") {
    super(message);
    this.name = "ArenaPaymentReplacementBlockedError";
  }
}

/**
 * Consult durable server payment state before any fresh wallet signing.
 * A pending attempt must be recovered first. Only a server-authorized terminal
 * expiry/non-landing may reopen the lane for a replacement transaction.
 */
export async function resolveArenaPaymentBeforeSigning({
  lookup,
  recoverPending,
  expirePending,
  isExpiredError,
}) {
  const serverState = await lookup();
  if (serverState?.pending) {
    try {
      return {
        kind: "recovered",
        result: await recoverPending(serverState.pending),
        pending: serverState.pending,
      };
    } catch (error) {
      if (!isExpiredError(error)) throw error;
      await expirePending(serverState.pending);
      const reopened = await lookup();
      if (reopened?.pending || reopened?.newPaymentAllowed !== true) {
        throw new ArenaPaymentReplacementBlockedError();
      }
      return { kind: "new", pending: null };
    }
  }
  if (serverState?.newPaymentAllowed !== true) {
    throw new ArenaPaymentReplacementBlockedError();
  }
  return { kind: "new", pending: null };
}

/**
 * Persist the exact wallet-signed identity before broadcasting those exact bytes.
 * If broadcast succeeds and the browser dies immediately afterwards, a fresh
 * client can still rediscover the original signature from server state.
 */
export async function registerArenaPaymentBeforeBroadcast({ pending, register, broadcast }) {
  await register(pending);
  const sentSignature = await broadcast();
  if (sentSignature !== pending.signature) {
    throw new Error("RPC returned a signature that does not match the durably registered wallet signature.");
  }
  return sentSignature;
}
