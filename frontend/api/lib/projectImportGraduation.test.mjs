import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Interface, Wallet, ZeroAddress, AbiCoder, getAddress, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { AMM_POOL_PROGRAMS, AMM_VAULT_AUTHORITIES, BONDING_VAULT_AUTHORITIES, readSolanaPoolHoldings, solanaGraduationProof } from './projectImportMeteoraCustody.js';
import { pumpGraduationProof } from './projectSolanaProjectAuthority.js';
import { bnbGraduationProof } from './projectImportResolverAdapters.js';
import { RH_POST_GRADUATION_HOOKS, RH_V3_FACTORY, RH_V4_POOL_MANAGER, clearRobinhoodGraduationCacheForTest, robinhoodGraduationProof } from './projectImportRobinhoodGraduation.js';

// HARD RULE (founder 2026-10-29): no token in its bonding phase may be imported. These pin what counts as proof.

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const pk = () => Keypair.generate().publicKey.toBase58();

test('the program-wide Solana vault authorities are the PDAs their programs derive', () => {
  const pda = (seed, program) => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(program))[0].toBase58();
  assert.ok(AMM_VAULT_AUTHORITIES[pda('vault_and_lp_mint_auth_seed', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')]);
  assert.ok(AMM_VAULT_AUTHORITIES[pda('amm authority', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')]);
  assert.ok(AMM_VAULT_AUTHORITIES[pda('pool_authority', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')]);
  assert.ok(BONDING_VAULT_AUTHORITIES[pda('pool_authority', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')]);
  assert.ok(BONDING_VAULT_AUTHORITIES[pda('vault_auth_seed', 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj')]);
});

// A fake Solana node: largest accounts with owners, owner-account programs, and supply.
function solana({ mint, holders, supply = 1_000_000n }) {
  const programs = Object.fromEntries(holders.filter((h) => h.ownerProgram).map((h) => [h.owner, h.ownerProgram]));
  return {
    async getTokenLargestAccounts() { return { value: holders.map((h) => ({ address: new PublicKey(h.account), amount: String(h.amount) })) }; },
    async getTokenSupply() { return { value: { amount: String(supply) } }; },
    async getMultipleParsedAccounts(keys) { return { value: keys.map((k) => { const h = holders.find((x) => x.account === k.toBase58()); return { owner: new PublicKey(TOKEN), data: { parsed: { type: 'account', info: { owner: h.owner, mint } } } }; }) }; },
    async getMultipleAccountsInfo(keys) { return keys.map((k) => (programs[k.toBase58()] ? { owner: new PublicKey(programs[k.toBase58()]) } : null)); },
  };
}

test('Solana: a verified exchange vault with a real share of supply proves graduation', async () => {
  const mint = pk();
  for (const holder of [
    { account: pk(), owner: 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', amount: 300_000n },
    { account: pk(), owner: pk(), ownerProgram: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', amount: 300_000n },
    { account: pk(), owner: pk(), ownerProgram: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', amount: 2_000n },
  ]) {
    const holdings = await readSolanaPoolHoldings({ connection: solana({ mint, holders: [holder, { account: pk(), owner: pk(), amount: 10_000n }] }), mint });
    const proof = solanaGraduationProof({ holdings, dbcPool: null });
    assert.equal(proof.proven, true, JSON.stringify(proof));
    assert.equal(proof.method, 'solana_amm_pool');
  }
});

test('Solana: bonding vaults, dust pools, unknown programs and lookup failures never prove graduation', async () => {
  const mint = pk();
  const amm = { account: pk(), owner: 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', amount: 300_000n };
  const cases = [
    [[amm, { account: pk(), owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', amount: 500_000n }], 'bonding_vault_holds_supply'],
    [[amm, { account: pk(), owner: pk(), ownerProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', amount: 50_000n }], 'bonding_vault_holds_supply'],
    [[{ ...amm, amount: 50n }], 'no_verified_dex_pool'],
    [[{ account: pk(), owner: pk(), ownerProgram: pk(), amount: 900_000n }], 'no_verified_dex_pool'],
  ];
  for (const [holders, reason] of cases) {
    const proof = solanaGraduationProof({ holdings: await readSolanaPoolHoldings({ connection: solana({ mint, holders }), mint }), dbcPool: null });
    assert.deepEqual([proof.proven, proof.reason], [false, reason]);
  }
  const broken = { async getTokenLargestAccounts() { throw Error('429'); }, async getMultipleParsedAccounts() { return { value: [] }; } };
  const proof = solanaGraduationProof({ holdings: await readSolanaPoolHoldings({ connection: broken, mint }), dbcPool: null });
  assert.deepEqual([proof.proven, proof.retryable], [false, true]);
});

test('Solana: Meteora DBC proves graduation only once migrated; Pump.fun only once the curve is complete', () => {
  const empty = { custody: [], ammBps: 0n, bondingBps: 0n, holdings: [] };
  assert.equal(solanaGraduationProof({ holdings: empty, dbcPool: { pool: 'P', isMigrated: false } }).reason, 'meteora_dbc_bonding');
  assert.equal(solanaGraduationProof({ holdings: empty, dbcPool: { pool: 'P', isMigrated: true } }).method, 'meteora_dbc_migrated');
  assert.equal(pumpGraduationProof({ curveComplete: true }).proven, true);
  assert.equal(pumpGraduationProof({ curveComplete: false }).reason, 'pump_curve_bonding');
  assert.equal(pumpGraduationProof(null).proven, false);
});

test('BNB: only a verified post-launch market proves graduation', () => {
  assert.equal(bnbGraduationProof({ market: { verified: true, phase: 'postgrad', venue: 'PancakeSwap V2' }, launchEvidence: { platform: 'fourmeme' } }).proven, true);
  assert.equal(bnbGraduationProof({ market: { verified: true, phase: 'dex_market' }, launchEvidence: { platform: 'unidentified' } }).proven, true);
  assert.equal(bnbGraduationProof({ market: { verified: true, phase: 'bonding', platform: 'flapsh' } }).reason, 'flapsh_bonding');
  assert.equal(bnbGraduationProof({ market: { verified: false, phase: 'unknown', reason: 'supported_market_not_verified' } }).proven, false);
  assert.equal(bnbGraduationProof({ market: { verified: false, phase: 'unknown', reason: 'launch_registry_unavailable' } }).retryable, true);
});

// A fake Robinhood node for the Uniswap v3/v4 checks.
const I = new Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function deployer() view returns (address)', 'function creator() view returns (address)', 'function liquidity() view returns (uint128)', 'function extsload(bytes32) view returns (bytes32)', 'function getThreshold() view returns (uint256)']);
const v4Init = new Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
const v3Created = new Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']);
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', info: { error: { code: 3, message: 'execution reverted' } } });
const addr = () => Wallet.createRandom().address;
function liquiditySlot(poolId) { const s = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [poolId, 6n]))); return toBeHex(s + 3n, 32).toLowerCase(); }
function robinhood({ token, balances = {}, deployer = null, codes = {}, v3 = [], v4 = [], liquidity = {}, v4Liquidity = {} }) {
  return {
    async getBlockNumber() { return 100; },
    async getCode(a) { return codes[getAddress(a)] ?? '0x'; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const source = getAddress(address) === getAddress(RH_V3_FACTORY) ? v3 : getAddress(address) === getAddress(RH_V4_POOL_MANAGER) ? v4 : [];
      return source.filter((l) => topics.every((t, i) => t == null || l.topics[i] === t) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async call({ to, data }) {
      const fn = I.parseTransaction({ data }); const target = getAddress(to);
      if (fn.name === 'totalSupply' && target === getAddress(token)) return I.encodeFunctionResult(fn.name, [1_000_000n]);
      if (fn.name === 'balanceOf' && target === getAddress(token)) return I.encodeFunctionResult(fn.name, [balances[getAddress(fn.args[0])] ?? 0n]);
      if (fn.name === 'deployer' && target === getAddress(token) && deployer) return I.encodeFunctionResult(fn.name, [deployer]);
      if (fn.name === 'liquidity' && liquidity[target] !== undefined) return I.encodeFunctionResult(fn.name, [liquidity[target]]);
      if (fn.name === 'extsload' && target === getAddress(RH_V4_POOL_MANAGER)) return I.encodeFunctionResult(fn.name, [toBeHex(v4Liquidity[String(fn.args[0]).toLowerCase()] ?? 0n, 32)]);
      throw revert();
    },
  };
}
function v4Pool(token, hooks) {
  const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address'], [token, hooks]));
  const [c0, c1] = [token, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { poolId, log: { blockNumber: 50, ...v4Init.encodeEventLog('Initialize', [poolId, c0, c1, 0, 60, hooks, 1n << 96n, 0]) } };
}

test('Robinhood: v3 pool with liquidity, hook-less v4 pool, or a known post-graduation hook pool proves graduation', async () => {
  clearRobinhoodGraduationCacheForTest();
  const token = addr(), pool = addr();
  const [c0, c1] = [token, addr()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const created = { blockNumber: 10, ...v3Created.encodeEventLog('PoolCreated', [c0, c1, 3000, 60, pool]) };
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token, v3: [created], balances: { [getAddress(pool)]: 100_000n }, liquidity: { [getAddress(pool)]: 5n } }), token })).method, 'robinhood_uniswap_v3');
  for (const hooks of [ZeroAddress, Object.keys(RH_POST_GRADUATION_HOOKS)[0]]) {
    clearRobinhoodGraduationCacheForTest();
    const t = addr(), { poolId, log } = v4Pool(t, hooks);
    const proof = await robinhoodGraduationProof({ provider: robinhood({ token: t, v4: [log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 500_000n }, v4Liquidity: { [liquiditySlot(poolId)]: 9n } }), token: t });
    assert.equal(proof.method, 'robinhood_uniswap_v4');
  }
});

test('Robinhood: a launch contract holding supply, an unknown v4 hook, or no liquidity is never proof', async () => {
  clearRobinhoodGraduationCacheForTest();
  const t1 = addr(), curve = addr(), { poolId, log } = v4Pool(t1, ZeroAddress);
  const bonding = await robinhoodGraduationProof({ provider: robinhood({ token: t1, deployer: curve, codes: { [getAddress(curve)]: '0x6080' }, v4: [log], balances: { [getAddress(curve)]: 800_000n, [getAddress(RH_V4_POOL_MANAGER)]: 100_000n }, v4Liquidity: { [liquiditySlot(poolId)]: 9n } }), token: t1 });
  assert.equal(bonding.reason, 'launch_contract_holds_supply', 'a side pool cannot outvote the curve still holding supply');
  const t2 = addr(), unknownHook = v4Pool(t2, addr());
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token: t2, v4: [unknownHook.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n }, v4Liquidity: { [liquiditySlot(unknownHook.poolId)]: 9n } }), token: t2 })).proven, false, 'an unknown hook may be a bonding curve');
  const t3 = addr(), empty = v4Pool(t3, ZeroAddress);
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token: t3, v4: [empty.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n } }), token: t3 })).proven, false, 'no liquidity');
  const t4 = addr(), dust = v4Pool(t4, ZeroAddress);
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token: t4, v4: [dust.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 50n }, v4Liquidity: { [liquiditySlot(dust.poolId)]: 9n } }), token: t4 })).proven, false, 'dust pool');
  const t5 = addr();
  const failing = { ...robinhood({ token: t5 }), async getLogs() { throw Error('rate limited'); } };
  await assert.rejects(robinhoodGraduationProof({ provider: { ...failing, async call(req) { return robinhood({ token: t5, balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n } }).call(req); } }, token: t5 }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
});

test('Robinhood v3: the pool is found whether the coin is token0 or token1', async () => {
  for (const [token, other] of [['0x1000000000000000000000000000000000000001', '0x9000000000000000000000000000000000000009'], ['0x9000000000000000000000000000000000000009', '0x1000000000000000000000000000000000000001']]) {
    clearRobinhoodGraduationCacheForTest();
    const pool = addr();
    const [c0, c1] = [token, other].sort();
    const created = { blockNumber: 10, ...v3Created.encodeEventLog('PoolCreated', [c0, c1, 3000, 60, pool]) };
    const proof = await robinhoodGraduationProof({ provider: robinhood({ token, v3: [created], balances: { [getAddress(pool)]: 100_000n }, liquidity: { [getAddress(pool)]: 5n } }), token });
    assert.equal(proof.method, 'robinhood_uniswap_v3', `token is ${token === c0 ? 'token0' : 'token1'}`);
  }
});

test('Pump.fun: the complete flag is read from the curve bytes, including old 49-byte curves', async () => {
  const { pumpCurveComplete, PUMP_PROGRAM_ID } = await import('./projectSolanaProjectAuthority.js');
  const curve = (complete, length) => { const data = Buffer.alloc(length); Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data, 0); data[48] = complete; return { owner: PUMP_PROGRAM_ID, executable: false, data }; };
  assert.equal(pumpCurveComplete(curve(1, 49)), true, 'old layout, graduated (SN)');
  assert.equal(pumpCurveComplete(curve(0, 166)), false, 'current layout, bonding (Glen)');
  assert.equal(pumpGraduationProof({}, curve(1, 49)).proven, true);
  assert.equal(pumpGraduationProof({}, curve(0, 166)).reason, 'pump_curve_bonding');
  assert.equal(pumpCurveComplete({ ...curve(1, 49), owner: new PublicKey(pk()) }), null, 'not owned by Pump.fun');
  const forged = curve(1, 49); forged.data[0] ^= 1;
  assert.equal(pumpCurveComplete(forged), null, 'wrong discriminator');
});
