import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, Wallet, ZeroAddress, getAddress, id, zeroPadValue, AbiCoder } from 'ethers';
import { FOURMEME_HELPER, FOURMEME_TOKEN_MANAGER_V2, RH_LAUNCHPAD_ROUTER, clearEvmCreatorCacheForTest, isWalletCode, resolveEvmProjectAuthority } from './projectImportEvmCreator.js';
import { isCreatorAuthority } from './projectImportAssessment.js';

const reads = new Interface(['function owner() view returns (address)', 'function getOwner() view returns (address)', 'function deployer() view returns (address)', 'function creator() view returns (address)']);
const helper = new Interface(['function getTokenInfo(address) view returns(uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)']);
const fourEvent = new Interface(['event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 launchTime,uint256 launchFee)']);
const RH_CREATED = '0x01937e4cd42e9b7187e05b387d1e47c08cd90a82522fdaa889731e4bf52c462d';
const TRANSFER = id('Transfer(address,address,uint256)');
const addr = () => Wallet.createRandom().address;
const CONTRACT_CODE = '0x6080604052';

// A tiny fake chain: token methods, code per address, blocks with txs, receipts and logs.
function chain({ token, methods = {}, codes = {}, blocks = [], receipts = {}, txs = {}, mintLogs = [], fourInfo = null, failLogs = false }) {
  return {
    async call({ to, data }) {
      if (to.toLowerCase() === FOURMEME_HELPER.toLowerCase()) {
        if (!fourInfo) throw Error('revert');
        return helper.encodeFunctionResult('getTokenInfo', [fourInfo.version, fourInfo.manager, ZeroAddress, 0, 0, 0, 0, 0, 0, 0, 0, false]);
      }
      if (to.toLowerCase() !== token.toLowerCase()) throw Error('revert');
      const fn = reads.parseTransaction({ data })?.name;
      if (!(fn in methods)) throw Error('revert');
      return reads.encodeFunctionResult(fn, [methods[fn]]);
    },
    async getCode(a) { return codes[getAddress(a)] ?? '0x'; },
    async getBlockNumber() { return blocks.length ? blocks[blocks.length - 1].number : 100; },
    async getBlock(n) { return blocks.find((b) => b.number === n) || { number: n, timestamp: n < (blocks[0]?.number ?? 0) ? 0 : 1e12, prefetchedTransactions: [] }; },
    async getTransactionReceipt(hash) { return receipts[hash] || null; },
    async getTransaction(hash) { return txs[hash] || null; },
    async getLogs() { if (failLogs) throw Error('rate limited'); return mintLogs; },
  };
}

function fourmemeSetup({ creator = addr(), eventCreator = creator, txTo = FOURMEME_TOKEN_MANAGER_V2, status = 1, emitter = FOURMEME_TOKEN_MANAGER_V2, apiCreator = creator, eventToken = null } = {}) {
  const token = addr();
  const log = { address: emitter, ...fourEvent.encodeEventLog('TokenCreate', [eventCreator, eventToken || token, 1, 'N', 'S', 1000, 1000, 0]) };
  const tx = { hash: '0xcreate', from: creator, to: txTo };
  const blocks = [{ number: 50, timestamp: 990, prefetchedTransactions: [] }, { number: 51, timestamp: 1005, prefetchedTransactions: [{ hash: '0xother', from: addr(), to: FOURMEME_TOKEN_MANAGER_V2 }, tx] }, { number: 52, timestamp: 1200, prefetchedTransactions: [] }];
  const provider = chain({ token, methods: { owner: ZeroAddress }, blocks, receipts: { '0xcreate': { status, logs: [log], blockNumber: 51 } }, fourInfo: { version: 2, manager: FOURMEME_TOKEN_MANAGER_V2 } });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { address: token.toLowerCase(), userAddress: apiCreator.toLowerCase(), createDate: '1000000' } }) });
  return { token, creator, provider, fetchImpl };
}

test('wallet detection accepts plain EOAs and EIP-7702 delegated EOAs only', () => {
  assert.equal(isWalletCode('0x'), true);
  assert.equal(isWalletCode(`0xef0100${'ab'.repeat(20)}`), true);
  assert.equal(isWalletCode(CONTRACT_CODE), false);
  assert.equal(isWalletCode(`0xef0100${'ab'.repeat(21)}`), false);
});

test('a live owner always wins, wallet or contract, without any launchpad lookup', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), owner = addr(), safe = addr();
  const p = chain({ token, methods: { owner, deployer: addr() }, failLogs: true });
  const r = await resolveEvmProjectAuthority({ provider: p, chainId: 4663, token, signedWallet: owner, fetchImpl: () => { throw Error('no fetch'); } });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified], ['owner', owner, true]);
  const s = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner: safe }, codes: { [safe]: CONTRACT_CODE } }), chainId: 56, token, signedWallet: addr() });
  assert.deepEqual([s.method, s.currentOwner, s.automaticOwnershipVerified], ['owner', safe, false]);
});

test('renounced owner falls back to the token\'s deployer()/creator() wallet, including EIP-7702', async () => {
  clearEvmCreatorCacheForTest();
  const token = addr(), dev = addr();
  const r = await resolveEvmProjectAuthority({ provider: chain({ token, methods: { owner: ZeroAddress, deployer: dev }, codes: { [dev]: `0xef0100${'cd'.repeat(20)}` } }), chainId: 4663, token, signedWallet: dev });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified], ['deployer', dev, true]);
  assert.equal(isCreatorAuthority({ authoritySource: `evm_${r.method}` }), true);
});

test('four.meme: the TokenCreate creator who sent the tx is the owner (TokenManager-held owner is ignored)', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider, fetchImpl } = fourmemeSetup();
  const r = await resolveEvmProjectAuthority({ provider, chainId: 56, token, signedWallet: creator, fetchImpl });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.creationTx], ['fourmeme_creator', getAddress(creator), true, '0xcreate']);
  clearEvmCreatorCacheForTest();
  const held = fourmemeSetup();
  held.provider.call = ((orig) => async (req) => (req.data.startsWith(reads.getFunction('owner').selector) && req.to.toLowerCase() === held.token.toLowerCase()) ? reads.encodeFunctionResult('owner', [FOURMEME_TOKEN_MANAGER_V2]) : orig(req))(held.provider.call);
  const h = await resolveEvmProjectAuthority({ provider: held.provider, chainId: 56, token: held.token, signedWallet: held.creator, fetchImpl: held.fetchImpl });
  assert.equal(h.method, 'fourmeme_creator');
});

for (const [label, setup] of [
  ['event creator is not the sender', { eventCreator: addr() }],
  ['tx not sent to the TokenManager', { txTo: addr() }],
  ['failed transaction', { status: 0 }],
  ['event emitted by another contract', { emitter: addr() }],
  ['event names another token', { eventToken: addr() }],
  ['API points at another wallet', { apiCreator: addr() }],
]) test(`four.meme fails closed: ${label}`, async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider, fetchImpl } = fourmemeSetup(setup);
  const r = await resolveEvmProjectAuthority({ provider, chainId: 56, token, signedWallet: creator, fetchImpl });
  assert.equal(r.currentOwner, null);
  assert.equal(r.automaticOwnershipVerification, 'unavailable');
});

test('four.meme API down or token not registered with four.meme: unavailable, no block scan', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = fourmemeSetup();
  provider.getBlock = async () => { throw Error('must not scan'); };
  const down = await resolveEvmProjectAuthority({ provider, chainId: 56, token, signedWallet: creator, fetchImpl: async () => ({ ok: false }) });
  assert.equal(down.currentOwner, null);
  clearEvmCreatorCacheForTest();
  const other = chain({ token, methods: { owner: ZeroAddress } });
  assert.equal((await resolveEvmProjectAuthority({ provider: other, chainId: 56, token, signedWallet: creator, fetchImpl: () => { throw Error('no fetch'); } })).currentOwner, null);
});

function robinhoodSetup({ creator = addr(), topicCreator = creator, curve = addr(), dataCurve = curve, txTo = RH_LAUNCHPAD_ROUTER, status = 1, creatorCode = '0x' } = {}) {
  const token = addr();
  const mint = { transactionHash: '0xmint', topics: [TRANSFER, zeroPadValue(ZeroAddress, 32)] };
  const record = { address: RH_LAUNCHPAD_ROUTER, topics: [RH_CREATED, zeroPadValue(topicCreator, 32)], data: AbiCoder.defaultAbiCoder().encode(['address'], [dataCurve]) };
  const provider = chain({ token, methods: { deployer: curve }, codes: { [getAddress(curve)]: CONTRACT_CODE, [getAddress(creator)]: creatorCode }, mintLogs: [mint], txs: { '0xmint': { hash: '0xmint', from: creator, to: txTo } }, receipts: { '0xmint': { status, logs: [record], blockNumber: 7 } } });
  return { token, creator, provider };
}

test('Robinhood launchpad: the router event naming the sender and the coin contract makes the sender the owner', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = robinhoodSetup();
  const r = await resolveEvmProjectAuthority({ provider, chainId: 4663, token, signedWallet: creator });
  assert.deepEqual([r.method, r.currentOwner, r.automaticOwnershipVerified, r.evidence.creationTx], ['launchpad_creator', getAddress(creator), true, '0xmint']);
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

test('RPC failure during the creation lookup is retryable, never "no owner"; results are cached', async () => {
  clearEvmCreatorCacheForTest();
  const { token, creator, provider } = robinhoodSetup();
  const failing = { ...provider, async getLogs() { throw Error('rate limited'); } };
  await assert.rejects(resolveEvmProjectAuthority({ provider: failing, chainId: 4663, token, signedWallet: creator }), { code: 'PROJECT_IMPORT_RPC_UNAVAILABLE' });
  let logCalls = 0;
  const counting = { ...provider, async getLogs(q) { logCalls++; return provider.getLogs(q); } };
  await resolveEvmProjectAuthority({ provider: counting, chainId: 4663, token, signedWallet: creator });
  const before = logCalls;
  await resolveEvmProjectAuthority({ provider: counting, chainId: 4663, token, signedWallet: creator });
  assert.equal(logCalls, before, 'verified creator is cached');
});
