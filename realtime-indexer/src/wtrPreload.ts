import express from "express";
import { ENV } from "./env.js";
import { registerCanonicalCandleRoutes } from "./canonicalCandleApi.js";
import { startGraduationReconcilerLoop } from "./graduationReconciler.js";
import { registerMarketContinuityRoutes } from "./marketApi.js";
import { registerRobinhoodMarketContinuityRoutes } from "./robinhoodMarketApi.js";
import { startTopazPoolIndexerLoop } from "./topazPoolIndexer.js";
import { startRobinhoodV3PoolIndexerLoop } from "./robinhoodV3PoolIndexer.js";

const WTR_ROUTES_SYMBOL = Symbol.for("memewarzone.wtrMarketRoutesRegistered");
const originalListen = express.application.listen as unknown as (
  this: typeof express.application,
  ...args: any[]
) => any;

express.application.listen = function wtrPatchedListen(this: any, ...args: any[]) {
  if (!this[WTR_ROUTES_SYMBOL]) {
    this[WTR_ROUTES_SYMBOL] = true;
    // Robinhood V3 routes must register before legacy Topaz handlers so chain
    // 4663/46630 never enter BNB-specific graduation repair or route logic.
    registerRobinhoodMarketContinuityRoutes(this);
    registerMarketContinuityRoutes(this);
    registerCanonicalCandleRoutes(this);
    console.log("[wtr] market continuity routes registered", {
      ENABLE_UNIFIED_MARKET_API: ENV.ENABLE_UNIFIED_MARKET_API,
      ENABLE_TOPAZ_POOL_INDEXER: ENV.ENABLE_TOPAZ_POOL_INDEXER,
      ENABLE_ROBINHOOD_V3_POOL_INDEXER: ENV.ENABLE_ROBINHOOD_V3_POOL_INDEXER,
      ENABLE_GRADUATION_HANDOFF_RECONCILER: ENV.ENABLE_GRADUATION_HANDOFF_RECONCILER,
    });
  }
  return originalListen.apply(this, args);
} as any;

console.log("[wtr] preload boot flags", {
  ENABLE_UNIFIED_MARKET_API: ENV.ENABLE_UNIFIED_MARKET_API,
  ENABLE_TOPAZ_POOL_INDEXER: ENV.ENABLE_TOPAZ_POOL_INDEXER,
  ENABLE_ROBINHOOD_V3_POOL_INDEXER: ENV.ENABLE_ROBINHOOD_V3_POOL_INDEXER,
  ENABLE_GRADUATION_HANDOFF_RECONCILER: ENV.ENABLE_GRADUATION_HANDOFF_RECONCILER,
});

startGraduationReconcilerLoop();
startTopazPoolIndexerLoop();
startRobinhoodV3PoolIndexerLoop();