import { AsyncLocalStorage } from "async_hooks";
import type { Pool, PoolClient } from "pg";

export function createIndexerSql(
  queryPool: Pick<Pool, "query">,
  store: AsyncLocalStorage<PoolClient>,
) {
  return function sql(text: string, values?: unknown[]) {
    const client = store.getStore();
    if (client) {
      return client.query({ text, values, simple: true } as any);
    }
    return queryPool.query(text, values);
  };
}
