import { startCanonicalCandleMaterializerLoop } from "./canonicalCandleMaterializer.js";
import { startCanonicalCandleRealtimeLoop } from "./canonicalCandleRealtime.js";
import { startSupportedFactoryDiscoveryLoop } from "./factoryDiscovery.js";
import { startMeteoraSwapIndexerLoop } from "./meteoraSwapIndexer.js";
import { startSolanaMarketStatsLoop } from "./solanaMarketStats.js";
import { startSolanaFeeEscrowWorker } from "./solanaFeeEscrowWorker.js";
import { startSolanaIndexerLoop } from "./solanaIndexer.js";

startSupportedFactoryDiscoveryLoop();
startSolanaIndexerLoop();
startSolanaFeeEscrowWorker();
startMeteoraSwapIndexerLoop();
if (String(process.env.ENABLE_SOLANA_MARKET_STATS || "1") === "1") startSolanaMarketStatsLoop();
startCanonicalCandleMaterializerLoop();
startCanonicalCandleRealtimeLoop();
await import("./server.js");
