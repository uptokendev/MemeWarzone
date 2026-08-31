export {};

process.env.REWARD_CHAIN_ID = "56";
await import("./processRewardEpoch.js");
