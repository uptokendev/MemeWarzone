import { startCanonicalCandleMaterializerLoop } from "./canonicalCandleMaterializer.js";
import { startCanonicalCandleRealtimeLoop } from "./canonicalCandleRealtime.js";
import { startSupportedFactoryDiscoveryLoop } from "./factoryDiscovery.js";
import { startDbcIndexerLoop } from "./dbcIndexer.js";
import { startMeteoraSwapIndexerLoop } from "./meteoraSwapIndexer.js";
import { startSolanaMarketStatsLoop } from "./solanaMarketStats.js";
import { startDbcFeeRoutingWorker } from "./dbcFeeRoutingWorker.js";
import { startDbcCreatorChoiceWorker } from "./dbcCreatorChoiceWorker.js";
import { startDbcGraduationWorker } from "./dbcGraduationWorker.js";
import { startEvmGraduationKeeperWorker } from "./evm/evmGraduationKeeperWorker.js";
import { startEvmCreatorChoiceWorker } from "./evm/evmCreatorChoiceWorker.js";
import { startSolanaFeeEscrowWorker } from "./solanaFeeEscrowWorker.js";
import { startSolanaIndexerLoop } from "./solanaIndexer.js";
import { startSolanaLpHarvestLoop } from "./solanaLpHarvestLoop.js";
import { startProtocolForwarderKeeper } from "./protocolForwarderKeeper.js";
import { startImportCreatorFeeWorker } from "./importCreatorFeeWorker.js";

startSupportedFactoryDiscoveryLoop();
startSolanaIndexerLoop();
startSolanaFeeEscrowWorker();
startSolanaLpHarvestLoop();
startDbcFeeRoutingWorker();
startDbcCreatorChoiceWorker();
startDbcGraduationWorker();
startEvmGraduationKeeperWorker();
startEvmCreatorChoiceWorker();
// Off unless IMPORT_FEE_WORKER_ENABLED; dry run unless IMPORT_FEE_PAYOUT_SEND.
startImportCreatorFeeWorker();
// Off unless PROTOCOL_FORWARDER_KEEPER=dry|send; never blocks startup (own timers, errors stay in its status).
void startProtocolForwarderKeeper().catch((error) => console.error("[forwarder-keeper] start failed", error));
startMeteoraSwapIndexerLoop();
startDbcIndexerLoop();
if (String(process.env.ENABLE_SOLANA_MARKET_STATS || "1") === "1") startSolanaMarketStatsLoop();
startCanonicalCandleMaterializerLoop();
startCanonicalCandleRealtimeLoop();
await import("./server.js");
