import { runRewardEpochChain } from "./processRewardEpochBounded.js";

runRewardEpochChain(101)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("processRewardEpochSolana failed", error);
    process.exit(1);
  });
