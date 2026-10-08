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
import { startPayoutWatchdogWorker } from "./evm/payoutWatchdogWorker.js";
import { startSolanaFeeEscrowWorker } from "./solanaFeeEscrowWorker.js";
import { startSolanaIndexerLoop } from "./solanaIndexer.js";
import { startSolanaLpHarvestLoop } from "./solanaLpHarvestLoop.js";
import { startProtocolForwarderKeeper } from "./protocolForwarderKeeper.js";
import { startImportCreatorFeeWorker } from "./importCreatorFeeWorker.js";
import { startImportCreatorFeeEvmWorker } from "./importCreatorFeeEvmWorker.js";

startSupportedFactoryDiscoveryLoop();
startSolanaIndexerLoop();
startSolanaFeeEscrowWorker();
startSolanaLpHarvestLoop();
startDbcFeeRoutingWorker();
startDbcCreatorChoiceWorker();
startDbcGraduationWorker();
startEvmGraduationKeeperWorker();
startEvmCreatorChoiceWorker();
void startPayoutWatchdogWorker().catch((error) => console.error("[payout-watchdog] start failed", error));
// Off unless IMPORT_FEE_WORKER_ENABLED; dry run unless IMPORT_FEE_PAYOUT_SEND.
startImportCreatorFeeWorker();
// EVM side (56 / 4663 / 97 / 46630): off unless IMPORT_FEE_EVM_WORKER_ENABLED; dry run unless IMPORT_FEE_PAYOUT_SEND.
void startImportCreatorFeeEvmWorker().catch((error) => console.error("[import-fees-evm] start failed", error));
// Off unless PROTOCOL_FORWARDER_KEEPER=dry|send; never blocks startup (own timers, errors stay in its status).
void startProtocolForwarderKeeper().catch((error) => console.error("[forwarder-keeper] start failed", error));
startMeteoraSwapIndexerLoop();
startDbcIndexerLoop();
if (String(process.env.ENABLE_SOLANA_MARKET_STATS || "1") === "1") startSolanaMarketStatsLoop();
startCanonicalCandleMaterializerLoop();
startCanonicalCandleRealtimeLoop();
await import("./server.js");
