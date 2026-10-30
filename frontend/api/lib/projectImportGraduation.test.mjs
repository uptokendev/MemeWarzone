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

// A fake Solana node: largest accounts with owners, owner accounts (program + data), pool-owned token accounts.
const WSOL = 'So11111111111111111111111111111111111111112';
function solana({ mint, holders, supply = 1_000_000n, ownerAccounts = {}, poolTokens = {}, extraAccounts = {} }) {
  return {
    async getTokenLargestAccounts() { return { value: holders.map((h) => ({ address: new PublicKey(h.account), amount: String(h.amount) })) }; },
    async getTokenSupply() { return { value: { amount: String(supply) } }; },
    async getMultipleParsedAccounts(keys) { return { value: keys.map((k) => { const a = k.toBase58(); const h = holders.find((x) => x.account === a); const e = extraAccounts[a]; if (!h && !e) return null; return { owner: new PublicKey(TOKEN), data: { parsed: { type: 'account', info: h ? { owner: h.owner, mint, tokenAmount: { amount: String(h.amount) } } : { owner: e.owner, mint: e.mint, tokenAmount: { amount: String(e.amount) } } } } }; }) }; },
    async getMultipleAccountsInfo(keys) { return keys.map((k) => ownerAccounts[k.toBase58()] || null); },
    async getParsedTokenAccountsByOwner(owner) { return { value: (poolTokens[owner.toBase58()] || []).map((t) => ({ pubkey: new PublicKey(t.address), account: { data: { parsed: { info: { mint: t.mint, tokenAmount: { amount: String(t.amount) } } } } } })) }; },
  };
}
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
function perPoolSetup({ quoteAmount = 5_000_000_000n, recordVault = true, recordMint = true, baseAmount = 300_000n } = {}) {
  const mint = pk(), pool = pk(), vault = pk(), quoteVault = pk();
  const data = Buffer.concat([Buffer.alloc(8), recordMint ? new PublicKey(mint).toBuffer() : Buffer.alloc(32), recordVault ? new PublicKey(vault).toBuffer() : Buffer.alloc(32), new PublicKey(quoteVault).toBuffer()]);
  const connection = solana({ mint, holders: [{ account: vault, owner: pool, amount: baseAmount }, { account: pk(), owner: pk(), amount: 10_000n }], ownerAccounts: { [pool]: { owner: new PublicKey(ORCA), data } }, poolTokens: { [pool]: [{ address: quoteVault, mint: WSOL, amount: quoteAmount }] } });
  return { mint, connection };
}
async function proofFor(connection, mint, poolPointers = []) {
  const { readMeteoraImportEvidence } = await import('./projectImportMeteoraCustody.js');
  return (await readMeteoraImportEvidence({ connection, mint, dbcLookup: async () => null, poolPointers })).graduationProof;
}

test('Solana: a real pool (pool account records vault + mint) with a funded quote side proves graduation', async () => {
  const { mint, connection } = perPoolSetup();
  const proof = await proofFor(connection, mint);
  assert.equal(proof.proven, true, JSON.stringify(proof));
  assert.equal(proof.pools[0].kind, 'orca_whirlpool_vault');
});

test('Solana: CPMM / DAMM v2 vaults count only as the PDA of a DexScreener-pointed pool that records them', async () => {
  const { PublicKey: PK } = await import('@solana/web3.js');
  const mint = pk(), pool = pk(), program = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', authority = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL';
  const vault = PK.findProgramAddressSync([Buffer.from('pool_vault'), new PK(pool).toBuffer(), new PK(mint).toBuffer()], new PK(program))[0].toBase58();
  const quoteVault = PK.findProgramAddressSync([Buffer.from('pool_vault'), new PK(pool).toBuffer(), new PK(WSOL).toBuffer()], new PK(program))[0].toBase58();
  const data = Buffer.concat([Buffer.alloc(8), new PK(mint).toBuffer(), new PK(vault).toBuffer(), new PK(quoteVault).toBuffer()]);
  const make = (holderAccount, quoteAmount = 9_000_000_000n) => solana({ mint, holders: [{ account: holderAccount, owner: authority, amount: 400_000n }], ownerAccounts: { [pool]: { owner: new PK(program), data } }, extraAccounts: { [quoteVault]: { owner: authority, mint: WSOL, amount: quoteAmount } } });
  assert.equal((await proofFor(make(vault), mint, [{ pool, quoteMint: WSOL }])).proven, true);
  assert.equal((await proofFor(make(pk()), mint, [{ pool, quoteMint: WSOL }])).proven, false, 'a token account merely owned by the CPMM authority is not a vault');
  assert.equal((await proofFor(make(vault, 10n), mint, [{ pool, quoteMint: WSOL }])).proven, false, 'empty quote side');
  assert.equal((await proofFor(make(vault), mint, [])).proven, false, 'no pool pointer, no proof');
});

test('Solana: fake or thin pools, bonding vaults and unknown-program holders never prove graduation (review 2026-10-29)', async () => {
  for (const [label, setup, reason] of [
    ['tokens parked under a pool that does not record the vault', { recordVault: false }, 'no_verified_dex_pool'],
    ['pool for another mint', { recordMint: false }, 'no_verified_dex_pool'],
    ['quote side under 1 SOL', { quoteAmount: 900_000_000n }, 'no_verified_dex_pool'],
    ['dust in the pool', { baseAmount: 50n }, 'no_verified_dex_pool'],
  ]) {
    const { mint, connection } = perPoolSetup(setup);
    const proof = await proofFor(connection, mint);
    assert.deepEqual([proof.proven, proof.reason], [false, reason], label);
  }
  const mint = pk();
  const real = perPoolSetup();
  for (const [holder, reason] of [
    [{ account: pk(), owner: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', amount: 500_000n }, 'bonding_vault_holds_supply'],
    [{ account: pk(), owner: PublicKey.findProgramAddressSync([Buffer.from('curve')], new PublicKey(pk()))[0].toBase58(), amount: 500_000n }, 'unknown_program_holds_supply'],
  ]) {
    const proof = solanaGraduationProof({ holdings: await readSolanaPoolHoldings({ connection: solana({ mint, holders: [holder] }), mint }), dbcPool: null, verifiedPools: [{ kind: 'x' }] });
    assert.deepEqual([proof.proven, proof.reason], [false, reason], 'refusals win over a verified pool');
  }
  const broken = { async getTokenLargestAccounts() { throw Error('429'); }, async getMultipleParsedAccounts() { return { value: [] }; } };
  const proof = solanaGraduationProof({ holdings: await readSolanaPoolHoldings({ connection: broken, mint }), dbcPool: null });
  assert.deepEqual([proof.proven, proof.retryable], [false, true]);
  assert.ok(real);
});

test('Solana: Meteora DBC proves graduation only once migrated; Pump.fun only once the curve is complete', () => {
  const empty = { custody: [], ammBps: 0n, bondingBps: 0n, holdings: [], totalSupply: 1_000_000n };
  assert.equal(solanaGraduationProof({ holdings: empty, dbcPool: { pool: 'P', isMigrated: false } }).reason, 'meteora_dbc_bonding');
  assert.equal(solanaGraduationProof({ holdings: empty, dbcPool: { pool: 'P', isMigrated: true } }).method, 'meteora_dbc_migrated');
  assert.equal(pumpGraduationProof({ curveComplete: true }).proven, true);
  assert.equal(pumpGraduationProof({ curveComplete: false }).reason, 'pump_curve_bonding');
  assert.equal(pumpGraduationProof(null).proven, false);
});

test('BNB: four.meme graduation, or a PancakeSwap market with a real share, funded quote side and no launch contract', async () => {
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  assert.equal((await bnbGraduationProof({ market: { verified: true, phase: 'postgrad', venue: 'PancakeSwap V2' }, launchEvidence: { platform: 'fourmeme' } })).proven, true);
  const dex = (o = {}) => ({ market: { verified: true, phase: 'dex_market', quoteMint: WBNB, baseReserve: '100000', quoteReserve: String(10n ** 18n), ...o } });
  assert.equal((await bnbGraduationProof(dex(), { totalSupply: '1000000' })).proven, true);
  assert.equal((await bnbGraduationProof(dex({ baseReserve: '50' }), { totalSupply: '1000000' })).reason, 'pool_holds_too_little_supply', '1-wei style pair');
  assert.equal((await bnbGraduationProof(dex({ quoteReserve: '1000' }), { totalSupply: '1000000' })).reason, 'pool_quote_side_too_thin');
  assert.equal((await bnbGraduationProof(dex({ quoteMint: addr() }), { totalSupply: '1000000' })).reason, 'pool_quote_side_too_thin', 'unknown quote');
  const token = addr(), curve = addr();
  const reads = new Interface(['function owner() view returns (address)', 'function balanceOf(address) view returns (uint256)']);
  const provider = { async getCode(a) { return getAddress(a) === getAddress(curve) ? '0x6080' : '0x'; }, async call({ to, data }) {
    const fn = reads.parseTransaction({ data })?.name;
    if (getAddress(to) === getAddress(token) && fn === 'owner') return reads.encodeFunctionResult('owner', [curve]);
    if (getAddress(to) === getAddress(token) && fn === 'balanceOf') return reads.encodeFunctionResult('balanceOf', [600_000n]);
    throw revert(); } };
  assert.equal((await bnbGraduationProof(dex(), { provider, token, totalSupply: '1000000' })).reason, 'launch_contract_holds_supply');
  assert.equal((await bnbGraduationProof({ market: { verified: true, phase: 'bonding', platform: 'flapsh' } })).reason, 'flapsh_bonding');
  assert.equal((await bnbGraduationProof({ market: { verified: false, phase: 'unknown', reason: 'market_checks_unavailable' } })).retryable, true);
});

// A fake Robinhood node for the Uniswap v3/v4 checks.
const I = new Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function deployer() view returns (address)', 'function creator() view returns (address)', 'function liquidity() view returns (uint128)', 'function extsload(bytes32) view returns (bytes32)', 'function getThreshold() view returns (uint256)', 'function token0() view returns (address)']);
const v4Init = new Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
const v3Created = new Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']);
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', info: { error: { code: 3, message: 'execution reverted' } } });
const addr = () => Wallet.createRandom().address;
const RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
function liquiditySlot(poolId) { const s = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [poolId, 6n]))); return toBeHex(s + 3n, 32).toLowerCase(); }
function robinhood({ token, balances = {}, quoteBalances = {}, deployer = null, codes = {}, v3 = [], v4 = [], mints = [], liquidity = {}, v4Liquidity = {} }) {
  return {
    async getBlockNumber() { return 100; },
    async getCode(a) { return codes[getAddress(a)] ?? '0x'; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const target = getAddress(address);
      const source = target === getAddress(RH_V3_FACTORY) ? v3 : target === getAddress(RH_V4_POOL_MANAGER) ? v4 : target === getAddress(token) ? mints : [];
      return source.filter((l) => topics.every((t, i) => t == null || l.topics[i] === t) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async call({ to, data }) {
      const fn = I.parseTransaction({ data }); const target = getAddress(to);
      if (fn.name === 'totalSupply' && target === getAddress(token)) return I.encodeFunctionResult(fn.name, [1_000_000n]);
      if (fn.name === 'balanceOf' && target === getAddress(token)) return I.encodeFunctionResult(fn.name, [balances[getAddress(fn.args[0])] ?? 0n]);
      if (fn.name === 'balanceOf' && target === getAddress(RH_WETH)) return I.encodeFunctionResult(fn.name, [quoteBalances[getAddress(fn.args[0])] ?? 0n]);
      if (fn.name === 'deployer' && target === getAddress(token) && deployer) return I.encodeFunctionResult(fn.name, [deployer]);
      if (fn.name === 'liquidity' && liquidity[target] !== undefined) return I.encodeFunctionResult(fn.name, [liquidity[target]]);
      if (fn.name === 'extsload' && target === getAddress(RH_V4_POOL_MANAGER)) return I.encodeFunctionResult(fn.name, [toBeHex(v4Liquidity[String(fn.args[0]).toLowerCase()] ?? 0n, 32)]);
      throw revert();
    },
  };
}
function v4Pool(token, hooks) {
  const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address'], [token, hooks]));
  const [c0, c1] = [token, RH_WETH].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { poolId, log: { blockNumber: 50, ...v4Init.encodeEventLog('Initialize', [poolId, c0, c1, 0, 60, hooks, 1n << 96n, 0]) } };
}
function v3Setup({ token = addr(), quoteAmount = 10n ** 18n, baseAmount = 100_000n } = {}) {
  const pool = addr();
  const [c0, c1] = [token, RH_WETH].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const created = { blockNumber: 10, ...v3Created.encodeEventLog('PoolCreated', [c0, c1, 3000, 60, pool]) };
  return { token, provider: robinhood({ token, v3: [created], balances: { [getAddress(pool)]: baseAmount }, quoteBalances: { [getAddress(pool)]: quoteAmount }, liquidity: { [getAddress(pool)]: 5n } }) };
}

test('Robinhood: a funded v3 pool, a hook-less v4 pool, or a known post-graduation hook pool proves graduation', async () => {
  clearRobinhoodGraduationCacheForTest();
  const v3 = v3Setup();
  assert.equal((await robinhoodGraduationProof({ provider: v3.provider, token: v3.token })).method, 'robinhood_uniswap_v3');
  for (const hooks of [ZeroAddress, Object.keys(RH_POST_GRADUATION_HOOKS)[0]]) {
    clearRobinhoodGraduationCacheForTest();
    const t = addr(), { poolId, log } = v4Pool(t, hooks);
    const proof = await robinhoodGraduationProof({ provider: robinhood({ token: t, v4: [log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 500_000n }, v4Liquidity: { [liquiditySlot(poolId)]: 9n } }), token: t });
    assert.equal(proof.method, 'robinhood_uniswap_v4');
  }
});

test('Robinhood v3: the pool is found whether the coin is token0 or token1', async () => {
  for (const token of ['0x1000000000000000000000000000000000000001', '0xF000000000000000000000000000000000000009']) {
    clearRobinhoodGraduationCacheForTest();
    const v3 = v3Setup({ token });
    assert.equal((await robinhoodGraduationProof({ provider: v3.provider, token })).method, 'robinhood_uniswap_v3');
  }
});

test('Robinhood: launch contracts, unknown-hook liquidity, thin or empty pools are never proof (review 2026-10-29)', async () => {
  clearRobinhoodGraduationCacheForTest();
  const t1 = addr(), curve = addr(), { poolId, log } = v4Pool(t1, ZeroAddress);
  const bonding = await robinhoodGraduationProof({ provider: robinhood({ token: t1, deployer: curve, codes: { [getAddress(curve)]: '0x6080' }, v4: [log], balances: { [getAddress(curve)]: 800_000n, [getAddress(RH_V4_POOL_MANAGER)]: 100_000n }, v4Liquidity: { [liquiditySlot(poolId)]: 9n } }), token: t1 });
  assert.equal(bonding.reason, 'launch_contract_holds_supply', 'deployer() curve still holding supply');
  const t1b = addr(), hiddenCurve = addr(), side = v4Pool(t1b, ZeroAddress);
  const mint = { blockNumber: 5, topics: [TRANSFER_TOPIC, zeroPadValue(ZeroAddress, 32), zeroPadValue(hiddenCurve, 32)], data: '0x' };
  const hidden = await robinhoodGraduationProof({ provider: robinhood({ token: t1b, mints: [mint], codes: { [getAddress(hiddenCurve)]: '0x6080' }, v4: [side.log], balances: { [getAddress(hiddenCurve)]: 600_000n, [getAddress(RH_V4_POOL_MANAGER)]: 100_000n }, v4Liquidity: { [liquiditySlot(side.poolId)]: 9n } }), token: t1b });
  assert.equal(hidden.reason, 'launch_contract_holds_supply', 'the contract that received the minted supply still holds it');
  const t2 = addr(), hooked = v4Pool(t2, addr()), plain = v4Pool(t2, ZeroAddress);
  const unknownHook = await robinhoodGraduationProof({ provider: robinhood({ token: t2, v4: [hooked.log, plain.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n }, v4Liquidity: { [liquiditySlot(hooked.poolId)]: 9n, [liquiditySlot(plain.poolId)]: 1n } }), token: t2 });
  assert.equal(unknownHook.reason, 'unknown_hook_pool_has_liquidity', 'a hook-less side pool cannot outvote a liquid unknown-hook pool');
  const t3 = addr(), empty = v4Pool(t3, ZeroAddress);
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token: t3, v4: [empty.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n } }), token: t3 })).proven, false, 'no liquidity');
  const t4 = addr(), dust = v4Pool(t4, ZeroAddress);
  assert.equal((await robinhoodGraduationProof({ provider: robinhood({ token: t4, v4: [dust.log], balances: { [getAddress(RH_V4_POOL_MANAGER)]: 50n }, v4Liquidity: { [liquiditySlot(dust.poolId)]: 9n } }), token: t4 })).proven, false, 'dust pool');
  clearRobinhoodGraduationCacheForTest();
  const thin = v3Setup({ quoteAmount: 10n ** 15n });
  assert.equal((await robinhoodGraduationProof({ provider: thin.provider, token: thin.token })).proven, false, 'v3 quote side under 0.05 WETH');
  const t5 = addr();
  const failing = { ...robinhood({ token: t5, balances: { [getAddress(RH_V4_POOL_MANAGER)]: 900_000n } }), async getLogs() { throw Error('rate limited'); } };
  await assert.rejects(robinhoodGraduationProof({ provider: failing, token: t5 }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
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
