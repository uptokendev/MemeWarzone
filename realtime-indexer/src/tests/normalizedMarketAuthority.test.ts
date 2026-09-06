import test from "node:test";
import assert from "node:assert/strict";
import {
  bindBnbGraduatedMarketToCatalogResult, bindMarketToCatalogResult, normalizeChartValueUsd, normalizeLpFeeReport, normalizeMarketUsd,
  rawAmountToDecimal, toArenaMarketSnapshot, validateTradeIntent,
  type AssetRef, type NormalizedMarketIdentity, type QuoteCatalogResult, type QuoteUsdReference,
} from "../normalizedMarketAuthority.js";

const MEME: AssetRef = { asset: "MEME", address: "0x0000000000000000000000000000000000000abc", symbol: "MEME" };
const BNB: AssetRef = { asset: "BNB", address: "native:56", symbol: "BNB" };
const WBNB: AssetRef = { asset: "WBNB", address: "0x00000000000000000000000000000000000000bb", symbol: "WBNB" };
const USDC_BNB: AssetRef = { asset: "USDC", address: "0x00000000000000000000000000000000000000cc", symbol: "USDC" };
const SOL: AssetRef = { asset: "SOL", address: "native:101", symbol: "SOL" };
const USDC_SOL: AssetRef = { asset: "USDC", address: "USDc111111111111111111111111111111111111111", symbol: "USDC" };
const ETH: AssetRef = { asset: "ETH", address: "native:4663", symbol: "ETH" };
const STOCK: AssetRef = { asset: "STOCK", address: "0x0000000000000000000000000000000000000055", symbol: "STOCK" };
const RH_USDC: AssetRef = { asset: "USDC", address: "0x0000000000000000000000000000000000000066", symbol: "USDC" };
const NOW = new Date("2026-09-06T12:01:00.000Z");

function catalog(overrides: Partial<QuoteCatalogResult> = {}): QuoteCatalogResult {
  return {
    id: "11111111-1111-1111-1111-111111111111", assetId: "22222222-2222-2222-2222-222222222222",
    provider: { id: "33333333-3333-3333-3333-333333333333", key: "canonical-stable", authorityMode: "GENERIC" },
    chainId: "56", identityKind: "EVM_ADDRESS", contractAddressOrMint: USDC_BNB.address,
    assetClass: "STABLECOIN", symbol: "USDC", stateVersion: 4,
    newGraduationEligible: true, existingMarketSupport: true,
    policy: { authority: "generic", policyKey: "bnb-usdc-basic", version: 3 }, ...overrides,
  };
}
function market(overrides: Partial<NormalizedMarketIdentity> = {}): NormalizedMarketIdentity {
  return {
    baseAsset: "MEME", baseAddress: MEME.address, quoteAsset: "USDC", quoteAddress: USDC_BNB.address,
    quoteAssetClass: "STABLECOIN", provider: "canonical-stable", poolAddress: "0x0000000000000000000000000000000000000def",
    venue: "TOPAZ", chainId: "56", campaignGeneration: "basic-multi-quote-v1", marketGeneration: "normalized-market-v1",
    quoteAssetId: "22222222-2222-2222-2222-222222222222", quoteDeploymentId: "11111111-1111-1111-1111-111111111111",
    quotePolicyKey: "bnb-usdc-basic", quotePolicyVersion: 3, quotePolicyAuthority: "generic", ...overrides,
  };
}
function ref(m: NormalizedMarketIdentity, priceUsd = "1.0025"): QuoteUsdReference {
  return { status: "available", quoteAddress: m.quoteAddress, quotePolicyKey: m.quotePolicyKey,
    quotePolicyVersion: m.quotePolicyVersion, provider: "authoritative-oracle", priceUsd,
    observedAt: "2026-09-06T12:00:00.000Z", validUntil: "2026-09-06T12:05:00.000Z" };
}

test("Agent 4 consumes Agent 1 eligibility and binds deployment/asset/provider/policy/address without recalculating it", () => {
  const unbound = { baseAsset: "MEME", baseAddress: MEME.address, quoteAsset: "display-only", quoteAddress: USDC_BNB.address,
    poolAddress: "0xpool", venue: "TOPAZ", chainId: "56", campaignGeneration: "basic-multi-quote-v1", marketGeneration: "normalized-market-v1" };
  const bound = bindMarketToCatalogResult(unbound, catalog());
  assert.equal(bound.quoteDeploymentId, "11111111-1111-1111-1111-111111111111");
  assert.equal(bound.quoteAssetId, "22222222-2222-2222-2222-222222222222");
  assert.equal(bound.provider, "canonical-stable");
  assert.equal(bound.quotePolicyKey, "bnb-usdc-basic"); assert.equal(bound.quotePolicyVersion, 3);
  assert.equal(bound.quoteAddress, USDC_BNB.address); assert.equal(bound.quoteAsset, "USDC");
  assert.throws(() => bindMarketToCatalogResult(unbound, catalog({ newGraduationEligible: false })), /did not approve/);
  assert.throws(() => bindMarketToCatalogResult({ ...unbound, quoteAddress: "0xdead" }, catalog()), /address mismatch/);
});

test("Agent 3 BNB catalog binding is verified before the graduated MEME/QUOTE market is normalized", () => {
  const item = catalog();
  const graduated = { baseAsset: "MEME", baseAddress: MEME.address, quoteAsset: "USDC", quoteAddress: USDC_BNB.address,
    poolAddress: "0x0000000000000000000000000000000000000def", venue: "TOPAZ", chainId: "56",
    campaignGeneration: "4", marketGeneration: "5" };
  const bound = bindBnbGraduatedMarketToCatalogResult(graduated, {
    deploymentId: item.id, quoteToken: item.contractAddressOrMint, providerKey: item.provider.key,
    policyKey: item.policy.policyKey!, policyVersion: BigInt(item.policy.version!),
  }, item);
  assert.equal(bound.quoteDeploymentId, item.id);
  assert.equal(bound.quoteAssetId, item.assetId);
  assert.equal(bound.quoteAddress, item.contractAddressOrMint);
  assert.equal(bound.provider, item.provider.key);
  assert.equal(bound.quotePolicyKey, item.policy.policyKey);
  assert.equal(bound.quotePolicyVersion, item.policy.version);
  assert.equal(bound.quoteAssetClass, item.assetClass);
  assert.equal(bound.chainId, item.chainId);
});

test("BNB stable quote normalizes price/cap/liquidity/volume from explicit quote USD", () => {
  const m = market(); const s = normalizeMarketUsd(m, { priceQuote:"0.125", marketCapQuote:"250000", liquidityQuote:"75000.25", volumeQuote:"10000.5" }, ref(m), NOW);
  assert.equal(s.priceUsd,"0.1253125"); assert.equal(s.marketCapUsd,"250625"); assert.equal(s.liquidityUsd,"75187.750625"); assert.equal(s.volumeUsd,"10025.50125");
});
test("missing stable reference degrades explicitly and never assumes $1", () => {
  const m=market(); const s=normalizeMarketUsd(m,{priceQuote:"2",marketCapQuote:"20",liquidityQuote:"10",volumeQuote:"5"},{status:"missing",quoteAddress:m.quoteAddress,quotePolicyKey:m.quotePolicyKey,quotePolicyVersion:m.quotePolicyVersion,reason:"reference unavailable"},NOW);
  assert.equal(s.referenceStatus,"missing"); assert.equal(s.priceUsd,null); assert.equal(s.marketCapUsd,null);
});
test("native quote requires explicit reference; no automatic native fallback", () => {
  const m=market({quoteAsset:"WBNB",quoteAddress:WBNB.address,quoteAssetClass:"NATIVE",quoteDeploymentId:"native-wbnb",quoteAssetId:null});
  const s=normalizeMarketUsd(m,{priceQuote:"0.0001",marketCapQuote:"10",liquidityQuote:"5",volumeQuote:"2"},{status:"missing",quoteAddress:m.quoteAddress,quotePolicyKey:m.quotePolicyKey,quotePolicyVersion:m.quotePolicyVersion,reason:"BNB/USD unavailable"},NOW);
  assert.equal(s.priceUsd,null); assert.equal(s.referenceStatus,"missing");
});
test("stale reference cannot produce USD metrics or chart values", () => {
  const m=market(); const stale={...ref(m),validUntil:"2026-09-06T11:59:59.000Z"} as QuoteUsdReference;
  const s=normalizeMarketUsd(m,{priceQuote:"3",marketCapQuote:"30",liquidityQuote:"20",volumeQuote:"10"},stale,NOW);
  assert.equal(s.referenceStatus,"stale"); assert.equal(s.priceUsd,null); assert.equal(normalizeChartValueUsd(m,"4.25",stale,NOW).valueUsd,null);
});
test("raw accounting remains exact beyond Number.MAX_SAFE_INTEGER",()=>assert.equal(rawAmountToDecimal("123456789012345678901234567890123456",18),"123456789012345678.901234567890123456"));

test("BNB BUY/SELL UX routing does not rewrite actual MEME/USDC pool identity",()=>{
  const m=market(); assert.doesNotThrow(()=>validateTradeIntent({side:"BUY",userInputAsset:BNB,userOutputAsset:MEME,routingPath:[BNB,WBNB,USDC_BNB,MEME],market:m}));
  assert.doesNotThrow(()=>validateTradeIntent({side:"SELL",userInputAsset:MEME,userOutputAsset:BNB,routingPath:[MEME,USDC_BNB,WBNB,BNB],market:m})); assert.equal(m.quoteAddress,USDC_BNB.address);
});
test("Solana SOL UX routing preserves actual MEME/approved quote identity",()=>{
  const base={...MEME,address:"MeMe111111111111111111111111111111111111111"}; const m=market({baseAddress:base.address,quoteAddress:USDC_SOL.address,poolAddress:"Pool111111111111111111111111111111111111111",venue:"METEORA",chainId:"101",quoteDeploymentId:"sol-usdc"});
  assert.doesNotThrow(()=>validateTradeIntent({side:"BUY",userInputAsset:SOL,userOutputAsset:base,routingPath:[SOL,USDC_SOL,base],market:m})); assert.equal(m.quoteAddress,USDC_SOL.address);
});
test("Robinhood Stock regression keeps STOCK quote and ETH-in/ETH-out route semantics",()=>{
  const m=market({quoteAsset:"STOCK",quoteAddress:STOCK.address,quoteAssetClass:"PROVIDER_RWA",provider:"robinhood-stock-token",venue:"ROBINHOOD_V3",chainId:"4663",quotePolicyKey:"robinhood-stock-authority",quotePolicyVersion:7,quotePolicyAuthority:"delegated",quoteDeploymentId:"rh-stock:stock-id",quoteAssetId:null});
  assert.doesNotThrow(()=>validateTradeIntent({side:"BUY",userInputAsset:ETH,userOutputAsset:MEME,routingPath:[ETH,STOCK,MEME],market:m}));
  assert.doesNotThrow(()=>validateTradeIntent({side:"SELL",userInputAsset:MEME,userOutputAsset:ETH,routingPath:[MEME,STOCK,ETH],market:m}));
  assert.equal(normalizeMarketUsd(m,{priceQuote:"0.01",marketCapQuote:"100",liquidityQuote:"50",volumeQuote:"25"},ref(m,"197.25"),NOW).priceUsd,"1.9725");
});
test("Robinhood BASIC stable uses generic reference, not Stock rules or $1",()=>{
  const m=market({quoteAddress:RH_USDC.address,provider:"robinhood-basic",venue:"ROBINHOOD_V3",chainId:"4663",quotePolicyKey:"robinhood-usdc-basic",quotePolicyVersion:1,quoteDeploymentId:"rh-usdc",quoteAssetId:"rh-usdc-asset"});
  assert.equal(normalizeMarketUsd(m,{priceQuote:"2",marketCapQuote:"200",liquidityQuote:"100",volumeQuote:"50"},ref(m,"0.9997"),NOW).priceUsd,"1.9994");
});
test("LP fee representation preserves exact base/quote raw amounts and quote USD estimate",()=>{
  const m=market(); const r=normalizeLpFeeReport({market:m,baseFeeAmountRaw:"999999999999999999999999999",quoteFeeAmountRaw:"2500000",quoteDecimals:6,quoteSymbol:"USDC",quoteReference:ref(m)},NOW);
  assert.equal(r.baseFeeAmountRaw,"999999999999999999999999999"); assert.equal(r.quoteFeeAmountRaw,"2500000"); assert.equal(r.quoteUsdEstimate,"2.50625");
});
test("Arena receives identical normalized shape for native/native, native/RWA, RWA/stable, stable/imported",()=>{
  const variants: Array<[string,NormalizedMarketIdentity,string]>=[["native",market({quoteAsset:"WBNB",quoteAddress:WBNB.address,quoteAssetClass:"NATIVE"}),"600"],["stock",market({quoteAsset:"STOCK",quoteAddress:STOCK.address,quoteAssetClass:"PROVIDER_RWA"}),"197.25"],["stable",market(),"1.0025"],["imported",market({baseAsset:"IMPORTED",baseAddress:"0x0000000000000000000000000000000000000999"}),"1.0025"]];
  const snapshots=Object.fromEntries(variants.map(([id,m,p])=>[id,toArenaMarketSnapshot(id,normalizeMarketUsd(m,{priceQuote:"1",marketCapQuote:"10",liquidityQuote:"5",volumeQuote:"2"},ref(m,p),NOW))]));
  for(const [a,b] of [["native","native"],["native","stock"],["stock","stable"],["stable","imported"]]) assert.deepEqual(Object.keys(snapshots[a]).sort(),Object.keys(snapshots[b]).sort());
});
