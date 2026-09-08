import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

function sameAddress(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function loadFreeze() {
  const freezeMod = await Function(
    "specifier",
    "return import(specifier)",
  )(pathToFileURL(path.join(__dirname, "robinhoodTestnetFreeze.mjs")).href);
  return freezeMod.requireRobinhoodTestnetFreeze();
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`5C freeze verifier refuses chain ${chainId}; expected ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  }

  const freeze = await loadFreeze();
  const currentBlock = await ethers.provider.getBlockNumber();
  const factory = await ethers.getContractAt("LaunchFactory", freeze.factory);
  const code = await ethers.provider.getCode(freeze.factory);
  if (!code || code === "0x") throw new Error(`no bytecode at frozen factory ${freeze.factory}`);

  const [live, createPaused, routeAuthority, factoryGeneration, campaignGeneration, campaignsCount] = await Promise.all([
    factory.live(),
    factory.createPaused(),
    factory.routeAuthority(),
    factory.FACTORY_GENERATION(),
    factory.CAMPAIGN_GENERATION(),
    factory.campaignsCount(),
  ]);

  if (Number(factoryGeneration) !== 4 || Number(campaignGeneration) !== 3) {
    throw new Error(`on-chain generations ${factoryGeneration}/${campaignGeneration} are not frozen 4/3`);
  }
  if (!sameAddress(routeAuthority, freeze.routeAuthority)) {
    throw new Error(`on-chain routeAuthority ${routeAuthority} != frozen ${freeze.routeAuthority}`);
  }
  if (sameAddress(routeAuthority, freeze.admin)) {
    throw new Error("on-chain route authority must not equal admin");
  }
  if (live !== true) throw new Error("5C freeze requires factory.live() === true");
  if (createPaused !== true) throw new Error("5C freeze requires factory.createPaused() === true");

  const result = {
    kind: "robinhood-testnet-acceptance-5c-verify",
    chainId,
    network: network.name,
    verifiedAt: new Date().toISOString(),
    currentBlock,
    accepted5BSha: freeze.accepted5BSha,
    factory: freeze.factory,
    factoryGeneration: Number(factoryGeneration),
    campaignGeneration: Number(campaignGeneration),
    admin: freeze.admin,
    routeAuthority,
    routeAuthorityDiffersFromAdmin: !sameAddress(routeAuthority, freeze.admin),
    live: Boolean(live),
    createPaused: Boolean(createPaused),
    campaignsCount: campaignsCount.toString(),
    factoryStartBlock: freeze.factoryStartBlock,
    result: "PASS",
  };
  const out = path.resolve(
    String(process.env.ROBINHOOD_5C_VERIFY_RESULT_FILE || path.join(__dirname, "..", "reports/robinhood-testnet-acceptance-5c.verify.json")),
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log("[robinhood-5c-verify] PASS");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
