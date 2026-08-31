import fs from "node:fs";
import path from "node:path";

const LIVE_FACTORY_GENERATION_DECL = "uint32 public constant FACTORY_GENERATION = 3;";
const LIVE_CAMPAIGN_GENERATION_DECL = "uint32 public constant CAMPAIGN_GENERATION = 2;";

export const SOURCE_HEAD_NOT_LIVE_BNB =
  "source factory generation 4 / campaign 3 != accepted live BNB generation 3 / campaign 2. Refusing BNB factory broadcast.";

export function refuseBnbFactoryBroadcastIfSourceHeadIsNotLive() {
  const factorySource = fs.readFileSync(path.join(__dirname, "../../contracts/LaunchFactory.sol"), "utf8");
  if (
    !factorySource.includes(LIVE_FACTORY_GENERATION_DECL) ||
    !factorySource.includes(LIVE_CAMPAIGN_GENERATION_DECL)
  ) {
    throw new Error(SOURCE_HEAD_NOT_LIVE_BNB);
  }
}
