export const RH46630_CHAIN_ID = 46630;
export const GREEN_FACTORY = "0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943";
export const FORBIDDEN_STAGED_FACTORY = "0xF170F31dCeaBd2d0b3D32A14FbB6d22661148242";
export const RH5661 = "0xB69E19C4387905170aa17E986aAA3b805dAfe440";
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
    },
    secretsAllowed: [],
  };
}

export function evaluateMarketState(body) {
  const factory = String(body?.factoryAddress || "");
  if (sameAddress(factory, FORBIDDEN_STAGED_FACTORY)) throw new Error("STAGED_F170_FACTORY_FORBIDDEN");
  if (factory && !sameAddress(factory, GREEN_FACTORY)) throw new Error(`LIVE_FACTORY_MISMATCH_${factory}`);
  return {
    chainId: RH46630_CHAIN_ID,
    factory: factory || GREEN_FACTORY,
    campaign: RH5661,
    marketStage: body?.marketStage ?? null,
    pairAddress: body?.pairAddress ?? null,
    poolIndexerEnvEnabled: Boolean(body?.poolIndexerEnvEnabled),
    bondingActive: body?.bondingActive ?? null,
  };
}
