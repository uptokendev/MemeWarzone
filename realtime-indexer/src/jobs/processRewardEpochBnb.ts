import { getRewardEpochStage, runRewardEpochChain } from "./processRewardEpochBounded.js";

// Same watchdog as the Solana entrypoint: a hung stage exits with the stage
// name instead of being killed silently by the scheduler's timeout.
const diagnosticTimeoutMs = 60_000;
const watchdog = setTimeout(() => {
  console.error(
    `processRewardEpochBnb diagnostic timeout after ${diagnosticTimeoutMs}ms stage=${getRewardEpochStage()}`,
  );
  process.exit(1);
}, diagnosticTimeoutMs);

runRewardEpochChain(56)
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(`processRewardEpochBnb failed stage=${getRewardEpochStage()}`, error);
    process.exit(1);
  });
