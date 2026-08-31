export {};

process.env.REWARD_CHAIN_ID = "101";
await import("./processRewardEpoch.js");
