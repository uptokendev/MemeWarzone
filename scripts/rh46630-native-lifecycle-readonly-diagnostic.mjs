import fs from 'node:fs';
import { ethers } from 'ethers';

const CHAIN_ID = 46630;
const FORBIDDEN_CHAIN_ID = 4663;
const FACTORY = '0xa20388579323e22076b07e89Ac916aE6Ff91A0E0';
const CAMPAIGN_IMPL = '0x1e463947d28f2c878312139b87aD482a614F1cDC';
const LOCKER = '0x401B2F703B4756E0BC98dd4BCD92eaa9AaAd70c9';
const TREASURY = '0xF8A14d0e91A02DEc487615Ce13286b11dDad7efF';
const WETH = '0x52A47A33930B8a90a2000b1bA3CB96e879569670';
const V3_FACTORY = '0x948463E91d63a7A51cEeC0342735D1B738044aea';
const POSITION_MANAGER = '0xfF64Bd6970966dB58F0dd65BA76669D3b8BE9eC4';
const DEPLOY_BLOCK = 119497671;
const FEE_TIER = 3000;

const req = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`MISSING_PROTECTED_INPUT_${name}`);
  return value;
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const errText = (e) => String(e?.shortMessage || e?.reason || e?.message || e);
const json = (value) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const loadAbi = (path) => JSON.parse(fs.readFileSync(path, 'utf8')).abi;

const factoryAbi = loadAbi('artifacts/contracts/LaunchFactory.sol/LaunchFactory.json');
const campaignAbi = loadAbi('artifacts/contracts/LaunchCampaign.sol/LaunchCampaign.json');
const lockerAbi = loadAbi('artifacts/contracts/PermanentV3PositionLocker.sol/PermanentV3PositionLocker.json');
const treasuryAbi = loadAbi('artifacts/contracts/TreasuryRouterV3.sol/TreasuryRouterV3.json');
const v3FactoryAbi = ['function getPool(address,address,uint24) view returns(address)'];
const pmAbi = [
  'function ownerOf(uint256) view returns(address)',
  'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
];

function requireFunction(iface, signature) {
  try { return iface.getFunction(signature).selector; }
  catch { throw new Error(`COMPILED_ARTIFACT_MISSING_${signature}`); }
}

async function optionalRead(label, fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: `${label}:${errText(e)}` }; }
}

function decodeLogs(iface, logs, accepted) {
  const out = [];
  for (const log of logs) {
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || !accepted.has(parsed.name)) continue;
      const args = {};
      for (let i = 0; i < parsed.fragment.inputs.length; i++) {
        const name = parsed.fragment.inputs[i].name || String(i);
        const value = parsed.args[i];
        args[name] = typeof value === 'bigint' ? value.toString() : value;
      }
      out.push({ event: parsed.name, txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index, args });
    } catch {}
  }
  return out;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(req('ROBINHOOD_TESTNET_RPC_URL'));
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) throw new Error(`WRONG_CHAIN_${network.chainId}`);
  if (Number(network.chainId) === FORBIDDEN_CHAIN_ID) throw new Error('PRODUCTION_4663_FORBIDDEN');

  const factoryIface = new ethers.Interface(factoryAbi);
  const campaignIface = new ethers.Interface(campaignAbi);
  const lockerIface = new ethers.Interface(lockerAbi);
  const treasuryIface = new ethers.Interface(treasuryAbi);
  const artifactSelectors = {
    factoryGetCampaign: requireFunction(factoryIface, 'getCampaign(uint256)'),
    factoryGraduationRecorded: requireFunction(factoryIface, 'campaignGraduationRecorded(address)'),
    factoryGeneration: requireFunction(factoryIface, 'FACTORY_GENERATION()'),
    campaignGeneration: requireFunction(factoryIface, 'CAMPAIGN_GENERATION()'),
    campaignGraduationState: requireFunction(campaignIface, 'getGraduationState()'),
    campaignGraduationTarget: requireFunction(campaignIface, 'graduationTarget()'),
    lockerPoolInfo: requireFunction(lockerIface, 'poolInfo(address)'),
    treasuryForwardingPaused: requireFunction(treasuryIface, 'forwardingPaused()')
  };

  const latest = await provider.getBlockNumber();
  const factory = new ethers.Contract(FACTORY, factoryAbi, provider);
  const locker = new ethers.Contract(LOCKER, lockerAbi, provider);
  const treasury = new ethers.Contract(TREASURY, treasuryAbi, provider);
  const v3Factory = new ethers.Contract(V3_FACTORY, v3FactoryAbi, provider);
  const positionManager = new ethers.Contract(POSITION_MANAGER, pmAbi, provider);

  const [factoryGeneration, campaignGeneration, campaignImplementation, permanentLpLocker, liquidityKind, count] = await Promise.all([
    factory.FACTORY_GENERATION(), factory.CAMPAIGN_GENERATION(), factory.campaignImplementation(),
    factory.permanentLpLocker(), factory.liquidityKind(), factory.campaignsCount()
  ]);
  if (Number(factoryGeneration) !== 4 || Number(campaignGeneration) !== 3) {
    throw new Error(`DEPLOYED_GENERATION_MISMATCH_F${factoryGeneration}_C${campaignGeneration}`);
  }
  if (!same(campaignImplementation, CAMPAIGN_IMPL)) throw new Error(`DEPLOYED_CAMPAIGN_IMPL_MISMATCH_${campaignImplementation}`);
  if (!same(permanentLpLocker, LOCKER)) throw new Error(`DEPLOYED_LOCKER_MISMATCH_${permanentLpLocker}`);

  const [factoryLogsRaw, lockerLogsRaw, treasuryLogsRaw] = await Promise.all([
    provider.getLogs({ address: FACTORY, fromBlock: DEPLOY_BLOCK, toBlock: latest }),
    provider.getLogs({ address: LOCKER, fromBlock: DEPLOY_BLOCK, toBlock: latest }),
    provider.getLogs({ address: TREASURY, fromBlock: DEPLOY_BLOCK, toBlock: latest })
  ]);
  const factoryEvents = decodeLogs(factoryIface, factoryLogsRaw, new Set(['CampaignCreated', 'CampaignGraduated', 'LiveEnabled', 'CreatePauseUpdated', 'GlobalPauseUpdated']));
  const lockerEvents = decodeLogs(lockerIface, lockerLogsRaw, new Set(['V3PositionReceived', 'GraduationPoolRegistered', 'FeesHarvested', 'HarvestPaymentPending']));
  const treasuryEvents = decodeLogs(treasuryIface, treasuryLogsRaw, new Set(['RouteExecuted', 'LpTokenRouted', 'LpNativeRouted']));

  const campaigns = [];
  const start = count > 5n ? count - 5n : 0n;
  for (let i = start; i < count; i++) {
    const infoRead = await optionalRead('getCampaign', () => factory.getCampaign(i));
    if (!infoRead.ok) { campaigns.push({ id: i.toString(), readError: infoRead.error }); continue; }
    const info = infoRead.value;
    const c = new ethers.Contract(info.campaign, campaignAbi, provider);

    const [
      launchedRead, raisedRead, soldRead, targetUsdRead, targetNativeRead, gradRead, recordedRead,
      pausedRead, buyPausedRead, sellPausedRead, graduationPausedRead, canonicalPoolRead,
      campaignCode, tokenCode
    ] = await Promise.all([
      optionalRead('launched', () => c.launched()),
      optionalRead('netRaisedWei', () => c.netRaisedWei()),
      optionalRead('sold', () => c.sold()),
      optionalRead('graduationTarget', () => c.graduationTarget()),
      optionalRead('graduationNativeTarget', () => c.graduationNativeTarget()),
      optionalRead('getGraduationState', () => c.getGraduationState()),
      optionalRead('campaignGraduationRecorded', () => factory.campaignGraduationRecorded(info.campaign)),
      optionalRead('paused', () => c.paused()),
      optionalRead('buyPaused', () => c.buyPaused()),
      optionalRead('sellPaused', () => c.sellPaused()),
      optionalRead('graduationPaused', () => c.graduationPaused()),
      optionalRead('v3Factory.getPool', () => v3Factory.getPool(info.token, WETH, FEE_TIER)),
      provider.getCode(info.campaign),
      provider.getCode(info.token)
    ]);

    const row = {
      id: i.toString(), campaign: info.campaign, token: info.token, creator: info.creator,
      name: info.name, symbol: info.symbol, createdAt: info.createdAt.toString(),
      campaignCodePresent: campaignCode !== '0x', tokenCodePresent: tokenCode !== '0x',
      launched: launchedRead.ok ? launchedRead.value : null,
      netRaisedWei: raisedRead.ok ? raisedRead.value.toString() : null,
      sold: soldRead.ok ? soldRead.value.toString() : null,
      graduationTargetUsdWad: targetUsdRead.ok ? targetUsdRead.value.toString() : null,
      graduationNativeTarget: targetNativeRead.ok ? targetNativeRead.value.toString() : null,
      graduationNativeTargetReadError: targetNativeRead.ok ? null : targetNativeRead.error,
      graduationRecorded: recordedRead.ok ? recordedRead.value : null,
      graduationRecordedReadError: recordedRead.ok ? null : recordedRead.error,
      pauseState: {
        paused: pausedRead.ok ? pausedRead.value : null,
        buyPaused: buyPausedRead.ok ? buyPausedRead.value : null,
        sellPaused: sellPausedRead.ok ? sellPausedRead.value : null,
        graduationPaused: graduationPausedRead.ok ? graduationPausedRead.value : null
      },
      canonicalPool: canonicalPoolRead.ok ? canonicalPoolRead.value : null,
      canonicalPoolReadError: canonicalPoolRead.ok ? null : canonicalPoolRead.error
    };

    if (gradRead.ok) {
      const g = gradRead.value;
      row.graduationState = {
        dexPair: g[0], finalCurvePrice: g[1].toString(), initialDexPrice: g[2].toString(),
        graduatedLiquidityTokens: g[3].toString(), graduatedLiquidityNative: g[4].toString(),
        graduatedLiquidityPosition: g[5].toString(), burnedUnsoldTokens: g[6].toString(),
        burnedUnusedLpTokens: g[7].toString(), postBurnTotalSupply: g[8].toString(),
        graduationBalance: g[9].toString(), graduationOvershoot: g[10].toString()
      };
    } else {
      row.graduationStateReadError = gradRead.error;
    }

    const pool = canonicalPoolRead.ok ? canonicalPoolRead.value : ethers.ZeroAddress;
    if (pool && pool !== ethers.ZeroAddress) {
      const [poolInfoRead, registeredRead, pendingIdRead, lockedBalanceRead] = await Promise.all([
        optionalRead('locker.poolInfo', () => locker.poolInfo(pool)),
        optionalRead('locker.registeredLpToken', () => locker.registeredLpToken(pool)),
        optionalRead('locker.pendingPositionByPool', () => locker.pendingPositionByPool(pool)),
        optionalRead('locker.lockedBalance', () => locker.lockedBalance(pool))
      ]);
      row.lockerState = {
        registeredLpToken: registeredRead.ok ? registeredRead.value : null,
        pendingPositionTokenId: pendingIdRead.ok ? pendingIdRead.value.toString() : null,
        lockedBalance: lockedBalanceRead.ok ? lockedBalanceRead.value.toString() : null
      };
      if (poolInfoRead.ok) {
        const li = poolInfoRead.value;
        row.lockerState.poolInfo = {
          campaign: li.campaign, creator: li.creator, creatorFeeRecipient: li.creatorFeeRecipient,
          pool: li.pool, token0: li.token0, token1: li.token1, tokenId: li.tokenId.toString(),
          lockedLiquidity: li.lockedLiquidity.toString(), feeTier: li.feeTier.toString(),
          creatorFeeBps: li.creatorFeeBps.toString(), protocolFeeBps: li.protocolFeeBps.toString(),
          registered: li.registered
        };
        if (li.tokenId > 0n) {
          const [ownerRead, posRead] = await Promise.all([
            optionalRead('positionManager.ownerOf', () => positionManager.ownerOf(li.tokenId)),
            optionalRead('positionManager.positions', () => positionManager.positions(li.tokenId))
          ]);
          row.positionState = {
            tokenId: li.tokenId.toString(),
            owner: ownerRead.ok ? ownerRead.value : null,
            ownerReadError: ownerRead.ok ? null : ownerRead.error,
            liquidity: posRead.ok ? posRead.value[7].toString() : null,
            tokensOwed0: posRead.ok ? posRead.value[10].toString() : null,
            tokensOwed1: posRead.ok ? posRead.value[11].toString() : null,
            positionReadError: posRead.ok ? null : posRead.error
          };
        }
      } else {
        row.lockerState.poolInfoReadError = poolInfoRead.error;
      }
    }

    const routeEvents = treasuryEvents.filter((e) => e.event === 'RouteExecuted' && same(e.args.campaign, info.campaign));
    const feeTotals = routeEvents.reduce((acc, e) => {
      for (const key of ['amountIn', 'leagueAmount', 'creatorAmount', 'recruiterAmount', 'airdropAmount', 'squadAmount', 'protocolAmount']) {
        acc[key] = (BigInt(acc[key]) + BigInt(e.args[key] || '0')).toString();
      }
      return acc;
    }, { amountIn: '0', leagueAmount: '0', creatorAmount: '0', recruiterAmount: '0', airdropAmount: '0', squadAmount: '0', protocolAmount: '0' });
    row.treasuryFeeEvidence = { routeEventCount: routeEvents.length, totals: feeTotals, events: routeEvents };
    row.lockerEvents = lockerEvents.filter((e) => same(e.args.campaign, info.campaign) || (pool !== ethers.ZeroAddress && same(e.args.pool, pool)));
    campaigns.push(row);
  }

  const [live, createPaused, globalPaused, treasuryForwardingPaused, lockerRegistrationCount, lockerPendingPositionCount, treasuryBalance] = await Promise.all([
    factory.live(), factory.createPaused(), factory.globalPaused(), treasury.forwardingPaused(),
    locker.registrationCount(), locker.pendingPositionCount(), provider.getBalance(TREASURY)
  ]);

  console.log(json({
    chainId: CHAIN_ID,
    latestBlock: latest,
    compiledArtifactSelectors: artifactSelectors,
    deployedRuntime: {
      factory: FACTORY,
      factoryGeneration: factoryGeneration.toString(),
      campaignGeneration: campaignGeneration.toString(),
      campaignImplementation,
      permanentLpLocker,
      liquidityKind: liquidityKind.toString(),
      live, createPaused, globalPaused
    },
    lockerGlobalState: { registrationCount: lockerRegistrationCount.toString(), pendingPositionCount: lockerPendingPositionCount.toString() },
    treasuryGlobalState: { address: TREASURY, forwardingPaused: treasuryForwardingPaused, balanceWei: treasuryBalance.toString() },
    campaignsCount: count.toString(),
    recentCampaigns: campaigns,
    relevantFactoryEvents: factoryEvents.slice(-40),
    relevantLockerEvents: lockerEvents.slice(-40),
    relevantTreasuryEvents: treasuryEvents.slice(-80)
  }));
}

main().catch((e) => { console.error(errText(e)); process.exit(1); });
