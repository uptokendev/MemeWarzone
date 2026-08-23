export function createIndexerSql(
  queryPool: { query: (text: string, values?: unknown[]) => any },
  isRepair: () => boolean,
  repairQuery: (text: string, values?: unknown[]) => any,
) {
  return function sql(text: string, values?: unknown[]) {
    if (isRepair()) return repairQuery(text, values);
    return queryPool.query(text, values);
  };
}
