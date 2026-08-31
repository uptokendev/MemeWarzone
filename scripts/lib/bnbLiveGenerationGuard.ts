import fs from "node:fs";
import path from "node:path";

const LIVE_FACTORY_GENERATION_DECL = "uint32 public constant FACTORY_GENERATION = 3;";
const LIVE_CAMPAIGN_GENERATION_DECL = "uint32 public constant CAMPAIGN_GENERATION = 2;";
const SOURCE_FACTORY_GENERATION_DECL = "uint32 public constant FACTORY_GENERATION = 4;";
const SOURCE_CAMPAIGN_GENERATION_DECL = "uint32 public constant CAMPAIGN_GENERATION = 3;";

export const BNB_MAINNET_CHAIN_ID = 56;
export const BNB_TESTNET_CHAIN_ID = 97;
export const LOCAL_HARDHAT_CHAIN_ID = 31337;

export const SOURCE_HEAD_NOT_LIVE_BNB =
  "source factory generation 4 / campaign 3 != accepted live BNB generation 3 / campaign 2. Refusing BNB factory broadcast.";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function factorySource(): string {
  return fs.readFileSync(path.join(__dirname, "../../contracts/LaunchFactory.sol"), "utf8");
}

export function refuseBnbFactoryBroadcastIfSourceHeadIsNotLive() {
  const source = factorySource();
  if (!source.includes(LIVE_FACTORY_GENERATION_DECL) || !source.includes(LIVE_CAMPAIGN_GENERATION_DECL)) {
    throw new Error(SOURCE_HEAD_NOT_LIVE_BNB);
  }
}

/** Isolated 6C 97/31337 staging only. Never unlocks chain 56. */
export function allowBnb6cTestnetSourceHeadBroadcast(chainId: number) {
  const id = Number(chainId);
  if (id === BNB_MAINNET_CHAIN_ID) {
    throw new Error("6C forbids every factory/treasury broadcast on chain 56");
  }
  const source = factorySource();
  if (!source.includes(SOURCE_FACTORY_GENERATION_DECL) || !source.includes(SOURCE_CAMPAIGN_GENERATION_DECL)) {
    throw new Error("6C source-head broadcast requires LaunchFactory factory 4 / campaign 3");
  }
  if (id === LOCAL_HARDHAT_CHAIN_ID) {
    if (!truthy(process.env.ALLOW_LOCAL_BNB_PROTOCOL_STAGE)) {
      throw new Error("6C local rehearsal requires ALLOW_LOCAL_BNB_PROTOCOL_STAGE=true");
    }
    return { chainId: id, localRehearsal: true };
  }
  if (id !== BNB_TESTNET_CHAIN_ID) {
    throw new Error(`6C source-head broadcast is restricted to chain 97 or 31337; got ${id}`);
  }
  if (!truthy(process.env.BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST)) {
    throw new Error("6C chain-97 deploy requires BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true");
  }
  return { chainId: id, localRehearsal: false };
}
