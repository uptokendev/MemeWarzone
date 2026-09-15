function identity(value) { return value; }
function defaultEquals(a, b) {
  if (a && typeof a.equals === 'function') return a.equals(b);
  return String(a) === String(b);
}

function flatten(accountKeys, normalizeKey) {
  if (!accountKeys) throw new Error('transaction account keys were not resolved');
  if (typeof accountKeys.length === 'number' && typeof accountKeys.get === 'function') {
    return Array.from({ length: accountKeys.length }, (_, index) => {
      const value = accountKeys.get(index);
      if (value == null) throw new Error(`resolved account key ${index} is unavailable`);
      return normalizeKey(value, `resolved account key ${index}`);
    });
  }
  if (Array.isArray(accountKeys)) {
    return accountKeys.map((value, index) => normalizeKey(value, `resolved account key ${index}`));
  }
  if (Array.isArray(accountKeys.staticAccountKeys)) {
    return [
      ...accountKeys.staticAccountKeys,
      ...(accountKeys.accountKeysFromLookups?.writable || []),
      ...(accountKeys.accountKeysFromLookups?.readonly || []),
    ].map((value, index) => normalizeKey(value, `resolved account key ${index}`));
  }
  throw new Error('unsupported resolved account-key representation');
}

function expectedCounts(message) {
  return (message.addressTableLookups || []).reduce((totals, lookup) => {
    totals.writable += lookup.writableIndexes?.length || 0;
    totals.readonly += lookup.readonlyIndexes?.length || 0;
    return totals;
  }, { writable: 0, readonly: 0 });
}

function normalizeLoaded(loaded, normalizeKey) {
  if (!loaded || !Array.isArray(loaded.writable) || !Array.isArray(loaded.readonly)) return null;
  return {
    writable: loaded.writable.map((value, index) => normalizeKey(value, `loaded writable address ${index}`)),
    readonly: loaded.readonly.map((value, index) => normalizeKey(value, `loaded readonly address ${index}`)),
  };
}

async function tablesFromChain(connection, message, normalizeKey, equals) {
  if (!connection || typeof connection.getAddressLookupTable !== 'function') {
    throw new Error('V0 transaction requires ALT resolution but lookup-capable connection is unavailable');
  }
  const tables = [];
  for (const [lookupIndex, lookup] of message.addressTableLookups.entries()) {
    const accountKey = normalizeKey(lookup.accountKey, `ALT ${lookupIndex} account key`);
    const response = await connection.getAddressLookupTable(accountKey);
    const table = response?.value;
    if (!table) throw new Error(`ALT unavailable: ${String(accountKey)}`);
    if (table.key == null || !equals(normalizeKey(table.key, `ALT ${lookupIndex} returned key`), accountKey)) {
      throw new Error(`ALT key mismatch: ${String(accountKey)}`);
    }
    if (!Array.isArray(table.state?.addresses)) throw new Error(`ALT malformed: ${String(accountKey)}`);
    for (const [kind, indexes] of [['writable', lookup.writableIndexes || []], ['readonly', lookup.readonlyIndexes || []]]) {
      for (const rawIndex of indexes) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= table.state.addresses.length) {
          throw new Error(`ALT ${String(accountKey)} ${kind} index ${rawIndex} is out of bounds`);
        }
        normalizeKey(table.state.addresses[index], `ALT ${String(accountKey)} address ${index}`);
      }
    }
    tables.push(table);
  }
  return tables;
}

export async function resolveV0AccountKeys(connection, tx, options = {}) {
  const normalizeKey = options.normalizeKey || identity;
  const equals = options.equals || defaultEquals;
  const message = tx?.transaction?.message;
  if (!message) throw new Error('transaction message is unavailable');
  if (Array.isArray(message.accountKeys)) {
    return message.accountKeys.map((value, index) => normalizeKey(value, `legacy account key ${index}`));
  }
  if (!Array.isArray(message.staticAccountKeys) || typeof message.getAccountKeys !== 'function') {
    throw new Error('unsupported transaction message representation');
  }

  const lookups = Array.isArray(message.addressTableLookups) ? message.addressTableLookups : [];
  if (lookups.length === 0) return flatten(message.getAccountKeys(), normalizeKey);

  const expected = expectedCounts(message);
  const loaded = normalizeLoaded(tx?.meta?.loadedAddresses, normalizeKey);
  if (loaded) {
    if (loaded.writable.length !== expected.writable || loaded.readonly.length !== expected.readonly) {
      throw new Error(`RPC loaded-address count mismatch: expected ${expected.writable}/${expected.readonly}, got ${loaded.writable.length}/${loaded.readonly.length}`);
    }
    return flatten(message.getAccountKeys({ accountKeysFromLookups: loaded }), normalizeKey);
  }

  const addressLookupTableAccounts = await tablesFromChain(connection, message, normalizeKey, equals);
  return flatten(message.getAccountKeys({ addressLookupTableAccounts }), normalizeKey);
}

export async function nativeVolumeForPayer(connection, tx, payer, options = {}) {
  const normalizeKey = options.normalizeKey || identity;
  const equals = options.equals || defaultEquals;
  const keys = await resolveV0AccountKeys(connection, tx, { normalizeKey, equals });
  const payerKey = normalizeKey(payer, 'payer');
  const index = keys.findIndex((candidate) => equals(candidate, payerKey));
  if (index < 0) return null;

  const preBalances = tx?.meta?.preBalances;
  const postBalances = tx?.meta?.postBalances;
  if (!Array.isArray(preBalances) || !Array.isArray(postBalances)) throw new Error('transaction balance arrays are unavailable');
  if (preBalances.length !== keys.length || postBalances.length !== keys.length) {
    throw new Error(`balance/account-key alignment mismatch: keys=${keys.length} pre=${preBalances.length} post=${postBalances.length}`);
  }

  const pre = BigInt(preBalances[index]);
  const post = BigInt(postBalances[index]);
  const fee = index === 0 ? BigInt(tx.meta.fee || 0) : 0n;
  const delta = post - pre + fee;
  return delta < 0n ? -delta : delta;
}
