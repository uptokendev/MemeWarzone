import { getRewardEpochStage, runRewardEpochChain } from "./processRewardEpochBounded.js";

const diagnosticTimeoutMs = 60_000;
const watchdog = setTimeout(() => {
  console.error(
    `processRewardEpochSolana diagnostic timeout after ${diagnosticTimeoutMs}ms stage=${getRewardEpochStage()}`,
  );
  process.exit(1);
}, diagnosticTimeoutMs);

runRewardEpochChain(101)
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(`processRewardEpochSolana failed stage=${getRewardEpochStage()}`, error);
    process.exit(1);
  });
