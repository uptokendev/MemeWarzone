import { runRewardEpochChain } from "./processRewardEpochBounded.js";

runRewardEpochChain(56)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("processRewardEpochBnb failed", error);
    process.exit(1);
  });
