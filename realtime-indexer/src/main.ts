import { startCanonicalCandleMaterializerLoop } from "./canonicalCandleMaterializer.js";
import { startCanonicalCandleRealtimeLoop } from "./canonicalCandleRealtime.js";
import { startSupportedFactoryDiscoveryLoop } from "./factoryDiscovery.js";
import { startMeteoraSwapIndexerLoop } from "./meteoraSwapIndexer.js";
import { startSolanaFeeEscrowWorker } from "./solanaFeeEscrowWorker.js";
import { startSolanaIndexerLoop } from "./solanaIndexer.js";

startSupportedFactoryDiscoveryLoop();
startSolanaIndexerLoop();
startSolanaFeeEscrowWorker();
startMeteoraSwapIndexerLoop();
startCanonicalCandleMaterializerLoop();
startCanonicalCandleRealtimeLoop();
await import("./server.js");
