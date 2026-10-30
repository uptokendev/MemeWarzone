import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, Wallet, ZeroAddress, getAddress, getBytes, getCreateAddress, hexlify, id, keccak256, zeroPadValue, AbiCoder } from 'ethers';
import { FLAP_PORTAL, FOURMEME_HELPER, FOURMEME_TOKEN_MANAGER_V2, RH_LAUNCHPAD_ROUTER, RH_TOKEN_LAUNCHER, bloomContains, clearEvmCreatorCacheForTest, isRevertError, isWalletCode, resolveEvmProjectAuthority, verifyCreationTx } from './projectImportEvmCreator.js';
import { isCreatorAuthority } from './projectImportAssessment.js';

const reads = new Interface(['function owner() view returns (address)', 'function getOwner() view returns (address)', 'function deployer() view returns (address)', 'function creator() view returns (address)', 'function totalSupply() view returns (uint256)']);
const safeAbi = new Interface(['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])']);
const helper = new Interface(['function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)']);
const fourEvent = new Interface(['event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)']);
const flapEvent = new Interface(['event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)']);
const RH_CREATED = '0x01937e4cd42e9b7187e05b387d1e47c08cd90a82522fdaa889731e4bf52c462d';
const LAUNCHER_CREATED = '0x2e2b3f61b70d2d131b2a807371103cc98d51adcaa5e9a8f9c32658ad8426e74e';
const TRANSFER = id('Transfer(address,address,uint256)');
const ZERO_TOPIC = zeroPadValue(ZeroAddress, 32);
const addr = () => Wallet.createRandom().address;
const CONTRACT_CODE = '0x6080604052';
const revert = () => Object.assign(new Error('execution reverted (no data present; likely require(false) occurred'), { code: 'CALL_EXCEPTION', info: { error: { code: 3, message: 'execution reverted', data: '0x' } } });
// What ethers 6 makes of a JSON-RPC rate limit on eth_call: also CALL_EXCEPTION.
const rateLimited = () => Object.assign(new Error('missing revert data (action="call")'), { code: 'CALL_EXCEPTION', shortMessage: 'missing revert data', info: { error: { code: -32005, message: 'limit exceeded' } } });

function bloomFor(values) {
  const bits = new Uint8Array(256);
  for (const value of values) { const h = getBytes(keccak256(value)); for (let i = 0; i < 6; i += 2) { const bit = ((h[i] << 8) | h[i + 1]) & 2047; bits[255 - (bit >> 3)] |= 1 << (bit & 7); } }
  return hexlify(bits);
}

// A small fake chain that behaves like a node: reverts are CALL_EXCEPTION, getLogs filters by address/topic/range.
function chain({ token, methods = {}, codes = {}, nonces = {}, safes = {}, blocks = [], receipts = {}, txs = {}, logs = [], fourInfo = null, supply = null, failLogs = false, failCall = null }) {
  const counts = { calls: 0, getLogs: 0, fullBlocks: 0 };
  return {
    counts,
    async call({ to, data }) {
      counts.calls++;
      if (failCall && failCall(to, data)) throw rateLimited();
      if (to.toLowerCase() === FOURMEME_HELPER.toLowerCase()) {
        if (!fourInfo) throw revert();
        return helper.encodeFunctionResult('getTokenInfo', [fourInfo.version, fourInfo.manager, ZeroAddress, 0, 0, 0, 0, 0, 0, 0, 0, false]);
      }
      const safe = safes[getAddress(to)];
      if (safe) { const fn = safeAbi.parseTransaction({ data })?.name; if (fn === 'getThreshold') return safeAbi.encodeFunctionResult(fn, [safe.threshold]); if (fn === 'getOwners') return safeAbi.encodeFunctionResult(fn, [safe.owners]); }
      if (to.toLowerCase() !== token.toLowerCase()) throw revert();
      if (data === id('totalSupply()').slice(0, 10) && supply !== null) return AbiCoder.defaultAbiCoder().encode(['uint256'], [supply]);
      const fn = reads.parseTransaction({ data })?.name;
      if (!(fn in methods)) throw revert();
      return reads.encodeFunctionResult(fn, [methods[fn]]);
    },
    async getCode(a) { return codes[getAddress(a)] ?? '0x'; },
    async getTransactionCount(a) { return nonces[getAddress(a)] ?? 0; },
    async getBlockNumber() { return blocks.length ? blocks[blocks.length - 1].number : 100; },
    async getBlock(n, full) { if (full) counts.fullBlocks++; return blocks.find((b) => b.number === n) || { number: n, timestamp: n < (blocks[0]?.number ?? 0) ? 0 : 1e12, prefetchedTransactions: [] }; },
    async send(method, [hex]) { const b = blocks.find((x) => x.number === parseInt(hex, 16)); return { logsBloom: b?.bloom || hexlify(new Uint8Array(256)) }; },
    async getTransactionReceipt(hash) { return receipts[hash] || null; },
    async getTransaction(hash) { return txs[hash] || null; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      counts.getLogs++;
      if (failLogs) throw new Error('getLogs refused');
      return logs.filter((l) => l.address.toLowerCase() === address.toLowerCase() && (!topics?.[0] || l.topics[0] === topics[0]) && (!topics?.[1] || l.topics[1] === topics[1]) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

function fourmemeSetup({ creator = addr(), eventCreator = creator, txTo = FOURMEME_TOKEN_MANAGER_V2, status = 1, emitter = FOURMEME_TOKEN_MANAGER_V2, apiCreator = creator, eventToken = null, failLogs = false, apiStatus = 200 } = {}) {
  const token = addr();
  const log = { address: emitter, blockNumber: 51, transactionHash: '0xcreate', ...fourEvent.encodeEventLog('TokenCreate', [eventCreator, eventToken || token, 1, 'N', 'S', 1000, 1000, 0]) };
  const tx = { hash: '0xcreate', from: creator, to: txTo };
  const blocks = [{ number: 50, timestamp: 990, prefetchedTransactions: [] }, { number: 51, timestamp: 1005, bloom: bloomFor([token, FOURMEME_TOKEN_MANAGER_V2]), prefetchedTransactions: [{ hash: '0xother', from: addr(), to: FOURMEME_TOKEN_MANAGER_V2 }, tx] }, { number: 52, timestamp: 1200, prefetchedTransactions: [] }];
  const provider = chain({ token, methods: { owner: ZeroAddress }, blocks, txs: { '0xcreate': tx }, receipts: { '0xcreate': { status, logs: [log], blockNumber: 51 } }, logs: [log], fourInfo: { version: 2, manager: FOURMEME_TOKEN_MANAGER_V2 }, failLogs });
  const fetchImpl = async () => ({ ok: apiStatus === 200, status: apiStatus, json: async () => ({ data: { address: token.toLowerCase(), userAddress: apiCreator.toLowerCase(), createDate: '1000000' } }) });
  return { token, creator, provider, fetchImpl };
}

test('wallet detection accepts plain EOAs and EIP-7702 delegated EOAs only', () => {
  assert.equal(isWalletCode('0x'), true);
  assert.equal(isWalletCode(`0xef0100${'ab'.repeat(20)}`), true);
  assert.equal(isWalletCode(CONTRACT_CODE), false);
  assert.equal(isWalletCode(`0xef0100${'ab'.repeat(21)}`), false);
});

test('log bloom membership matches the Ethereum bloom construction', () => {
  const a = addr(), b = addr();
  const bloom = bloomFor([a]);
  assert.equal(bloomContains(bloom, a), true);
  assert.equal(bloomContains(bloom, b), false);
});

test('a live owner always wins, wallet or contract, without any launchpad lookup', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), owner = addr(), safe = addr();
  const r = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner, deployer: addr() }, failLogs: true }), chainId: 4663, token, signedWallet: owner, fetchImpl: () => { throw Error('no fetch'); } });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified], ['owner', owner, true]);
  const s = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner: safe }, codes: { [safe]: CONTRACT_CODE } }), chainId: 56, token, signedWallet: addr() });
  assert.deepEqual([s.method, s.currentOwner, s.automaticOwnershipVerified], ['owner', safe, false]);
});

test('revert detection: only a node revert or empty answer means "no such method" (ethers maps rate limits to CALL_EXCEPTION too)', () => {
  assert.equal(isRevertError(revert()), true);
  assert.equal(isRevertError(rateLimited()), false);
  assert.equal(isRevertError(Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA', value: '0x' })), true);
  assert.equal(isRevertError(Object.assign(new Error('missing response for request'), { code: 'BAD_DATA', value: [] })), false, 'a load balancer answering without a result is an RPC failure');
  assert.equal(isRevertError(Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', info: { error: { code: -32000, message: 'header not found' } } })), false);
  assert.equal(isRevertError(new Error('socket hang up')), false);
});

test('an RPC failure on owner() is retryable, never a fall-through to the deployer (review finding 1)', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), dev = addr();
  const ownerSel = reads.getFunction('owner').selector;
  const p = chain({ token, methods: { owner: addr(), deployer: dev }, failCall: (to, data) => data.startsWith(ownerSel) });
  await assert.rejects(resolveEvmProjectAuthority({ provider: p, chainId: 4663, token, signedWallet: dev }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
});

test('renounced owner falls back to the token\'s deployer()/creator() wallet, including EIP-7702', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), dev = addr();
  const r = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner: ZeroAddress, deployer: dev }, codes: { [dev]: `0xef0100${'cd'.repeat(20)}` } }), chainId: 4663, token, signedWallet: dev });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified], ['deployer', dev, true]);
  assert.equal(isCreatorAuthority({ authoritySource: `evm_${r.method}` }), true);
});

test('a Safe that deployed the token becomes the authority (claim then goes through the transfer check)', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), safe = addr(), member = addr();
  const p = chain({ token, methods: { deployer: safe }, codes: { [safe]: CONTRACT_CODE }, safes: { [getAddress(safe)]: { threshold: 1, owners: [member, addr()] } } });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 4663, token, signedWallet: member });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.threshold], ['safe_deployer', getAddress(safe), false, 1]);
  assert.equal(isCreatorAuthority({ authoritySource: 'evm_safe_deployer' }), true);
});

test('the signing wallet that CREATE-deployed the token is proven by its nonce, no input needed', async () => {
  clearEvmCreatorCacheForTest();
  const dev = addr(), token = getCreateAddress({ from: dev, nonce: 3 });
  const p = chain({ token, methods: { owner: ZeroAddress }, nonces: { [getAddress(dev)]: 10 } });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 56, token, signedWallet: dev });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.nonce], ['contract_deployer', getAddress(dev), true, 3]);
  clearEvmCreatorCacheForTest();
  const other = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner: ZeroAddress }, nonces: { [getAddress(dev)]: 3 } }), chainId: 56, token, signedWallet: dev });
  assert.equal(other.currentOwner, null, 'nonce 3 not used yet: not the deployer');
});

test('four.meme: the TokenCreate creator who sent the tx is the owner (getLogs path and bloom fallback)', async () => {
  for (const failLogs of [false, true]) {
    clearEvmCreatorCacheForTest();
    const { token, creator, provider, fetchImpl } = fourmemeSetup({ failLogs });
    const r = await resolveEvmProjectAuthority({ provider, chainId: 56, token, signedWallet: creator, fetchImpl });
    assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.creationTx], ['fourmeme_creator', getAddress(creator), true, '0xcreate']);
    assert.equal(provider.counts.fullBlocks, failLogs ? 1 : 0, 'full blocks only where the bloom matches');
  }
});

test('four.meme: the TokenManager holding owner() while bonding is not treated as the owner', async () => {
  clearEvmCreatorCacheForTest();
  const s = fourmemeSetup();
  const ownerSel = reads.getFunction('owner').selector;
  const call = s.provider.call;
  s.provider.call = async (req) => (req.to.toLowerCase() === s.token.toLowerCase() && req.data.startsWith(ownerSel)) ? reads.encodeFunctionResult('owner', [FOURMEME_TOKEN_MANAGER_V2]) : call(req);
  assert.equal((await resolveEvmProjectAuthority({ provider: s.provider, chainId: 56, token: s.token, signedWallet: s.creator, fetchImpl: s.fetchImpl })).method, 'fourmeme_creator');
});

for (const [label, setup] of [
  ['event creator is not the sender', { eventCreator: addr() }],
  ['tx not sent to the TokenManager', { txTo: addr() }],
  ['failed transaction', { status: 0 }],
  ['event emitted by another contract', { emitter: addr() }],
  ['event names another token', { eventToken: addr() }],
  ['API points at another wallet', { apiCreator: addr() }],
]) test(`four.meme fails closed: ${label}`, async () => {
  for (const failLogs of [false, true]) {
    clearEvmCreatorCacheForTest();
    const { token, creator, provider, fetchImpl } = fourmemeSetup({ ...setup, failLogs });
    const r = await resolveEvmProjectAuthority({ provider, chainId: 56, token, signedWallet: creator, fetchImpl });
    assert.equal(r.currentOwner, null);
  }
});

test('four.meme API outage is retryable and not cached as "no creator" (review finding 3)', async () => {
  clearEvmCreatorCacheForTest();
  const down = fourmemeSetup({ apiStatus: 503 });
  await assert.rejects(resolveEvmProjectAuthority({ provider: down.provider, chainId: 56, token: down.token, signedWallet: down.creator, fetchImpl: down.fetchImpl }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  clearEvmCreatorCacheForTest();
  const unknown = fourmemeSetup();
  const r = await resolveEvmProjectAuthority({ provider: unknown.provider, chainId: 56, token: unknown.token, signedWallet: unknown.creator, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: null }) }) });
  assert.equal(r.currentOwner, null);
});

const MINT_TX = `0x${'7'.repeat(64)}`;
function robinhoodSetup({ creator = addr(), topicCreator = creator, curve = addr(), dataCurve = curve, txTo = RH_LAUNCHPAD_ROUTER, status = 1, creatorCode = '0x', mintBlocks = [7] } = {}) {
  const token = addr();
  const mints = mintBlocks.map((block, i) => ({ address: token, blockNumber: block, transactionHash: i === 0 ? MINT_TX : `0x${String(i).repeat(64)}`, topics: [TRANSFER, ZERO_TOPIC] }));
  const record = { address: RH_LAUNCHPAD_ROUTER, topics: [RH_CREATED, zeroPadValue(topicCreator, 32)], data: AbiCoder.defaultAbiCoder().encode(['address'], [dataCurve]) };
  const provider = chain({ token, methods: { deployer: curve }, codes: { [getAddress(curve)]: CONTRACT_CODE, [getAddress(creator)]: creatorCode }, logs: mints, blocks: [{ number: 30_000_000, timestamp: 1, prefetchedTransactions: [] }], txs: { [MINT_TX]: { hash: MINT_TX, from: creator, to: txTo } }, receipts: { [MINT_TX]: { status, logs: [record], blockNumber: mintBlocks[0] } } });
  return { token, creator, provider };
}

test('Robinhood launchpad: the router event naming the sender and the coin contract makes the sender the owner', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = robinhoodSetup({ mintBlocks: [7, 25_000_000] });
  const r = await resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.creationTx], ['launchpad_creator', getAddress(creator), true, MINT_TX]);
});

for (const [label, setup] of [
  ['event names another creator', { topicCreator: addr() }],
  ['event names another coin contract', { dataCurve: addr() }],
  ['tx not sent to the router', { txTo: addr() }],
  ['failed transaction', { status: 0 }],
  ['creator is a contract', { creatorCode: CONTRACT_CODE }],
]) test(`Robinhood launchpad fails closed: ${label}`, async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = robinhoodSetup(setup);
  assert.equal((await resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator })).currentOwner, null);
});

test('RPC failure during the creation lookup is retryable, briefly cached, and verified creators are cached', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = robinhoodSetup();
  const failing = { ...provider, async getLogs() { throw Error('rate limited'); } };
  await assert.rejects(resolveEvmProjectAuthority({ provider: failing, chainId: 4663, token, signedWallet: creator }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  await assert.rejects(resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' }, 'error cached for a minute');
  clearEvmCreatorCacheForTest();
  await resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator });
  const before = provider.counts.getLogs;
  await resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator });
  assert.equal(provider.counts.getLogs, before, 'verified creator is cached');
});

// Pasted creation transactions: the hash is only a pointer, every condition comes from the chain.
function pasted({ chainId, token, tx, receipt, methods = {}, supply = null }) {
  return chain({ token, methods, supply, txs: { [tx.hash]: tx }, receipts: { [tx.hash]: receipt } });
}
const H = (n) => `0x${String(n).repeat(64)}`.slice(0, 66);

test('pasted creation tx: direct deploy, four.meme, flap.sh, Robinhood launchpad and launcher are recognised', async () => {
  const dev = addr();
  const direct = addr();
  assert.equal((await verifyCreationTx({ provider: pasted({ token: direct, tx: { hash: H(1), from: dev, to: null }, receipt: { status: 1, contractAddress: direct, logs: [], blockNumber: 5 } }), chainId: 56, token: direct, txHash: H(1) })).launchpad, 'direct_deploy');

  const four = addr();
  const fourLog = { address: FOURMEME_TOKEN_MANAGER_V2, ...fourEvent.encodeEventLog('TokenCreate', [dev, four, 1, 'N', 'S', 1, 1, 0]) };
  assert.equal((await verifyCreationTx({ provider: pasted({ token: four, tx: { hash: H(2), from: dev, to: FOURMEME_TOKEN_MANAGER_V2 }, receipt: { status: 1, logs: [fourLog], blockNumber: 5 } }), chainId: 56, token: four, txHash: H(2) })).creator, getAddress(dev));

  const flap = addr();
  const flapLog = { address: FLAP_PORTAL, ...flapEvent.encodeEventLog('TokenCreated', [1, dev, 7, flap, 'N', 'S', 'm']) };
  assert.equal((await verifyCreationTx({ provider: pasted({ token: flap, tx: { hash: H(3), from: dev, to: FLAP_PORTAL }, receipt: { status: 1, logs: [flapLog], blockNumber: 5 } }), chainId: 56, token: flap, txHash: H(3) })).launchpad, 'flap');
  const flapOther = { address: FLAP_PORTAL, ...flapEvent.encodeEventLog('TokenCreated', [1, addr(), 7, flap, 'N', 'S', 'm']) };
  assert.equal(await verifyCreationTx({ provider: pasted({ token: flap, tx: { hash: H(3), from: dev, to: FLAP_PORTAL }, receipt: { status: 1, logs: [flapOther], blockNumber: 5 } }), chainId: 56, token: flap, txHash: H(3) }), null, 'flap creator must be the sender');

  const launched = addr();
  const mint = { address: launched, topics: [TRANSFER, ZERO_TOPIC, zeroPadValue(dev, 32)], data: AbiCoder.defaultAbiCoder().encode(['uint256'], [1000n]) };
  const announce = { address: RH_TOKEN_LAUNCHER, topics: [LAUNCHER_CREATED, zeroPadValue(launched, 32)], data: '0x' };
  const launcherTx = { hash: H(4), from: dev, to: RH_TOKEN_LAUNCHER, data: id('multicall(bytes[])').slice(0, 10) + '00' };
  const ok = await verifyCreationTx({ provider: pasted({ token: launched, tx: launcherTx, receipt: { status: 1, logs: [mint, announce], blockNumber: 5 }, methods: { creator: RH_TOKEN_LAUNCHER }, supply: 1000n }), chainId: 4663, token: launched, txHash: H(4) });
  assert.equal(ok.launchpad, 'robinhood_token_launcher');
  assert.equal(await verifyCreationTx({ provider: pasted({ token: launched, tx: launcherTx, receipt: { status: 1, logs: [mint], blockNumber: 5 }, methods: { creator: RH_TOKEN_LAUNCHER }, supply: 1000n }), chainId: 4663, token: launched, txHash: H(4) }), null, 'the launcher must announce this token');
  assert.equal(await verifyCreationTx({ provider: pasted({ token: launched, tx: launcherTx, receipt: { status: 1, logs: [mint, announce], blockNumber: 5 }, methods: { creator: RH_TOKEN_LAUNCHER }, supply: 2000n }), chainId: 4663, token: launched, txHash: H(4) }), null, 'partial mint is not the creation');
  assert.equal(await verifyCreationTx({ provider: pasted({ token: launched, tx: { ...launcherTx, data: '0xdeadbeef' }, receipt: { status: 1, logs: [mint, announce], blockNumber: 5 }, methods: { creator: RH_TOKEN_LAUNCHER }, supply: 1000n }), chainId: 4663, token: launched, txHash: H(4) }), null, 'other launcher calls are not creations');
});

test('pasted creation tx: unrelated, failed, malformed or other-chain transactions prove nothing', async () => {
  const dev = addr(), token = addr();
  assert.equal(await verifyCreationTx({ provider: pasted({ token, tx: { hash: H(5), from: dev, to: addr() }, receipt: { status: 1, logs: [], blockNumber: 5 } }), chainId: 56, token, txHash: H(5) }), null);
  assert.equal(await verifyCreationTx({ provider: pasted({ token, tx: { hash: H(6), from: dev, to: null }, receipt: { status: 0, contractAddress: token, logs: [], blockNumber: 5 } }), chainId: 56, token, txHash: H(6) }), null);
  assert.equal(await verifyCreationTx({ provider: pasted({ token, tx: { hash: H(7), from: dev, to: FLAP_PORTAL }, receipt: { status: 1, logs: [], blockNumber: 5 } }), chainId: 4663, token, txHash: H(7) }), null);
  assert.equal(await verifyCreationTx({ provider: chain({ token }), chainId: 56, token, txHash: 'https://bscscan.com/tx/nope' }), null);
});

test('a pasted creation tx makes its sender the authority for this token', async () => {
  clearEvmCreatorCacheForTest();
  const dev = addr(), flap = addr();
  const flapLog = { address: FLAP_PORTAL, ...flapEvent.encodeEventLog('TokenCreated', [1, dev, 7, flap, 'N', 'S', 'm']) };
  const p = chain({ token: flap, methods: { owner: ZeroAddress }, txs: { [H(8)]: { hash: H(8), from: dev, to: FLAP_PORTAL } }, receipts: { [H(8)]: { status: 1, logs: [flapLog], blockNumber: 5 } } });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 56, token: flap, signedWallet: dev, creationTx: H(8), fetchImpl: () => { throw Error('no fetch'); } });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.launchpad], ['creation_tx', getAddress(dev), true, 'flap']);
});

test('Robinhood: the first-mint tx is checked with every recogniser, so launcher coins resolve without a paste', async () => {
  clearEvmCreatorCacheForTest();
  const dev = addr(), token = addr();
  const hash = `0x${'9'.repeat(64)}`;
  const mint = { address: token, blockNumber: 12, transactionHash: hash, topics: [TRANSFER, ZERO_TOPIC, zeroPadValue(dev, 32)], data: AbiCoder.defaultAbiCoder().encode(['uint256'], [500n]) };
  const announce = { address: RH_TOKEN_LAUNCHER, topics: [LAUNCHER_CREATED, zeroPadValue(token, 32)], data: '0x' };
  const p = chain({ token, methods: { creator: RH_TOKEN_LAUNCHER }, codes: { [getAddress(RH_TOKEN_LAUNCHER)]: CONTRACT_CODE }, supply: 500n, logs: [mint], blocks: [{ number: 20, timestamp: 1, prefetchedTransactions: [] }], txs: { [hash]: { hash, from: dev, to: RH_TOKEN_LAUNCHER, data: id('multicall(bytes[])').slice(0, 10) } }, receipts: { [hash]: { status: 1, logs: [mint, announce], blockNumber: 12 } } });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 4663, token, signedWallet: dev });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.launchpad], ['launchpad_creator', getAddress(dev), true, 'robinhood_token_launcher']);
});

test('flap.sh: the portal holding owner() while bonding is not treated as the owner', async () => {
  clearEvmCreatorCacheForTest();
  const dev = addr(), flap = addr(), hash = `0x${'8'.repeat(64)}`;
  const flapLog = { address: FLAP_PORTAL, ...flapEvent.encodeEventLog('TokenCreated', [1, dev, 7, flap, 'N', 'S', 'm']) };
  const p = chain({ token: flap, methods: { owner: FLAP_PORTAL }, codes: { [getAddress(FLAP_PORTAL)]: CONTRACT_CODE }, txs: { [hash]: { hash, from: dev, to: FLAP_PORTAL } }, receipts: { [hash]: { status: 1, logs: [flapLog], blockNumber: 5 } } });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 56, token: flap, signedWallet: dev, creationTx: hash, fetchImpl: () => { throw Error('no fetch'); } });
  assert.deepEqual([r.method, r.automaticOwnershipVerified], ['creation_tx', true]);
});

test('a full scan queue is not cached against the token (review finding 4)', async () => {
  clearEvmCreatorCacheForTest();
  const slow = fourmemeSetup(), other = fourmemeSetup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  for (const s of [slow]) { const g = s.provider.getBlockNumber; s.provider.getBlockNumber = async () => { await gate; return g(); }; }
  const a = resolveEvmProjectAuthority({ provider: slow.provider, chainId: 56, token: slow.token, signedWallet: slow.creator, fetchImpl: slow.fetchImpl });
  const b = resolveEvmProjectAuthority({ provider: slow.provider, chainId: 56, token: slow.token + '', signedWallet: slow.creator, fetchImpl: slow.fetchImpl });
  const third = fourmemeSetup(); const g3 = third.provider.getBlockNumber; third.provider.getBlockNumber = async () => { await gate; return g3(); };
  const c = resolveEvmProjectAuthority({ provider: third.provider, chainId: 56, token: third.token, signedWallet: third.creator, fetchImpl: third.fetchImpl });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(resolveEvmProjectAuthority({ provider: other.provider, chainId: 56, token: other.token, signedWallet: other.creator, fetchImpl: other.fetchImpl }), /busy/);
  release(); await Promise.all([a, b, c]);
  const r = await resolveEvmProjectAuthority({ provider: other.provider, chainId: 56, token: other.token, signedWallet: other.creator, fetchImpl: other.fetchImpl });
  assert.equal(r.method, 'fourmeme_creator', 'retry after a slot frees succeeds');
});
