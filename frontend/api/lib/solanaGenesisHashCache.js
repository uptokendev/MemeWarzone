/**
 * getGenesisHash never changes for an RPC endpoint, so it is asked once per process and URL.
 * A call that fails is not cached; concurrent first calls share one request. A connection without
 * an rpcEndpoint (a test double) is asked every time.
 */
const known = new Map();
const inflight = new Map();

export async function getGenesisHashCached(connection) {
  const key = String(connection?.rpcEndpoint || "");
  if (!key) return connection.getGenesisHash();
  if (known.has(key)) return known.get(key);
  let request = inflight.get(key);
  if (!request) {
    request = Promise.resolve(connection.getGenesisHash())
      .then((genesis) => {
        known.set(key, genesis);
        return genesis;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
  }
  return request;
}

/** Test hook: forget every cached hash. */
export function resetGenesisHashCache() {
  known.clear();
  inflight.clear();
}
