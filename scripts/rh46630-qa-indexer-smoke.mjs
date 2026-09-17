export const RH46630_CHAIN_ID = 46630;
export const GREEN_FACTORY = "0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943";
export const FORBIDDEN_STAGED_FACTORY = "0xF170F31dCeaBd2d0b3D32A14FbB6d22661148242";
export const RH5661 = "0xB69E19C4387905170aa17E986aAA3b805dAfe440";
export const RH5661_PAIR = "0xE1b9106d7BFef9F62C0ccbd87F2479a93C8f838D";
export const QA5019 = "0x5D12B2e19C5EfC4dB0fB727C98766b029d129AA8";
export const QA_INDEXER = "https://s75mnp6dfpjtv8m8fcefxlay.178.104.232.231.sslip.io";

export function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function planQaIndexerSmoke(input = {}) {
  const indexerBase = String(input.indexerBase || QA_INDEXER).replace(/\/+$/, "");
  return {
    chainId: RH46630_CHAIN_ID,
    factory: GREEN_FACTORY,
    forbiddenFactory: FORBIDDEN_STAGED_FACTORY,
    campaign: RH5661,
    indexerBase,
    urls: {
      health: `${indexerBase}/health`,
      marketState: `${indexerBase}/api/token/${RH5661}/market-state?chainId=${RH46630_CHAIN_ID}`,
      qa5019Trades: `${indexerBase}/api/token/${QA5019}/market-trades?chainId=${RH46630_CHAIN_ID}&limit=10`,
    },
    secretsAllowed: [],
  };
}

export function evaluateHealth(body) {
  const robinhood = body?.robinhood || {};
  const rawChainIds = robinhood?.evmChainIds;
  const chainIds = Array.isArray(rawChainIds)
    ? rawChainIds.map(Number).filter(Number.isFinite)
    : String(rawChainIds || "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter(Number.isFinite);
  return {
    ok: body?.ok === true,
    sourceCommit: String(body?.sourceCommit || "unset"),
    rpc46630Configured: Boolean(robinhood?.rpc46630Configured),
    poolIndexerEnvEnabled: Boolean(robinhood?.poolIndexerEnabled),
    chain46630Enabled: chainIds.includes(RH46630_CHAIN_ID),
    loopStarted: Boolean(robinhood?.v3?.loopStarted),
    lastPassAt: robinhood?.v3?.lastPassAt ?? null,
    lastError: robinhood?.v3?.lastError ?? null,
  };
}

export function evaluateMarketState(body) {
  const factory = String(body?.factoryAddress || "");
  if (sameAddress(factory, FORBIDDEN_STAGED_FACTORY)) throw new Error("STAGED_F170_FACTORY_FORBIDDEN");
  if (factory && !sameAddress(factory, GREEN_FACTORY)) throw new Error(`LIVE_FACTORY_MISMATCH_${factory}`);
  const pair = String(body?.pairAddress || "");
  if (!pair || pair === "null") throw new Error("RH5661_CMS_PAIR_MISSING");
  if (!sameAddress(pair, RH5661_PAIR)) throw new Error(`RH5661_CMS_PAIR_MISMATCH_${pair}`);
  return {
    chainId: RH46630_CHAIN_ID,
    factory: factory || GREEN_FACTORY,
    campaign: RH5661,
    marketStage: body?.marketStage ?? null,
    pairAddress: pair,
    poolIndexerEnvEnabled: Boolean(body?.poolIndexerEnvEnabled),
    bondingActive: body?.bondingActive ?? null,
  };
}

export function evaluateQa5019Trades(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length < 2) throw new Error(`QA5019_TRADES_MISSING count=${items.length}`);
  return { campaign: QA5019, tradeCount: items.length };
}
