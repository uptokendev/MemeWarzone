import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const TOOL_ROOT = path.resolve("tools/robinhood-testnet-infra/node_modules");
const MANIFEST_PATH = path.resolve("deployments/robinhood/testnet.infrastructure.json");
const DEFAULT_ORACLE_MAX_AGE = 900;

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadArtifact(packagePath: string): any {
  const absolute = path.join(TOOL_ROOT, packagePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`missing pinned Uniswap artifact ${absolute}; run npm install --prefix tools/robinhood-testnet-infra`);
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function linkedBytecode(artifact: any, libraries: Record<string, string>): string {
  let bytecode = String(artifact.bytecode || "");
  if (!bytecode.startsWith("0x")) bytecode = `0x${bytecode}`;
  const chars = bytecode.slice(2).split("");
  for (const [sourceName, refs] of Object.entries<any>(artifact.linkReferences || {})) {
    for (const [libraryName, positions] of Object.entries<any>(refs || {})) {
      const address = libraries[libraryName] || libraries[`${sourceName}:${libraryName}`];
      if (!address) throw new Error(`missing linked library ${sourceName}:${libraryName}`);
      const replacement = address.toLowerCase().replace(/^0x/, "");
      for (const position of positions) {
        const start = Number(position.start) * 2;
        const length = Number(position.length) * 2;
        if (replacement.length !== length) throw new Error(`invalid linked address length for ${libraryName}`);
        chars.splice(start, length, ...replacement);
      }
    }
  }
  return `0x${chars.join("")}`;
}

async function runtimeCodeEvidence(address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`runtime bytecode missing at ${address}`);
  return { code, runtimeCodeHash: ethers.keccak256(code) };
}

async function deployRoot(name: string, args: any[], signer: any) {
  const Factory = await ethers.getContractFactory(name, signer);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();
  return deploymentEvidence(name, contract);
}

async function deployArtifact(name: string, artifact: any, args: any[], signer: any, libraries: Record<string, string> = {}) {
  const factory = new ethers.ContractFactory(artifact.abi, linkedBytecode(artifact, libraries), signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return deploymentEvidence(name, contract);
}

async function deploymentEvidence(name: string, contract: any) {
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${name} deployment transaction missing`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${name} deployment failed`);
  const runtime = await runtimeCodeEvidence(address);
  return { contract, address, txHash: tx.hash, blockNumber: receipt.blockNumber, runtimeCodeHash: runtime.runtimeCodeHash };
}

async function main() {
  const authority = await Function("specifier", "return import(specifier)")(
    pathToFileURL(path.join(__dirname, "robinhoodTestnetInfrastructureAuthority.mjs")).href,
  );

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const boundary = authority.validateBootstrapBoundary({
    chainId,
    networkName: network.name,
    broadcastToken: process.env.ROBINHOOD_TESTNET_INFRA_BROADCAST,
    manifestExists: fs.existsSync(MANIFEST_PATH),
  });

  const sourceSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const plan = {
    mode: boundary.broadcast ? "broadcast" : "dry-run",
    chainId,
    network: network.name,
    manifestPath: authority.INFRA_MANIFEST_PATH,
    feeTier: authority.V3_FEE_TIER,
    sourceSha,
    sourceIdentities: authority.BOOTSTRAP_SOURCE_IDENTITIES,
    outputs: [
      "ROBINHOOD_WETH_ADDRESS_46630",
      "ROBINHOOD_V3_FACTORY_ADDRESS_46630",
      "ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630",
      "ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630",
      "ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630",
    ],
  };
  console.log(JSON.stringify(plan, null, 2));

  if (!boundary.broadcast) {
    console.log(`[robinhood-testnet-infra] preflight PASS; no transactions sent. Broadcast requires ROBINHOOD_TESTNET_INFRA_BROADCAST=${authority.INFRA_BROADCAST_TOKEN}`);
    return;
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("explicit Robinhood testnet deployer signer is required for broadcast");
  const deployerAddress = await deployer.getAddress();
  const oracleUpdater = ethers.getAddress(required("ROBINHOOD_TESTNET_ORACLE_UPDATER"));
  const initialOracleAnswer = BigInt(required("ROBINHOOD_TESTNET_ORACLE_INITIAL_ETH_USD_8"));
  if (initialOracleAnswer <= 0n) throw new Error("ROBINHOOD_TESTNET_ORACLE_INITIAL_ETH_USD_8 must be positive");
  const maxOracleAge = Number(process.env.ROBINHOOD_NATIVE_USD_MAX_ORACLE_AGE_SECONDS || DEFAULT_ORACLE_MAX_AGE);
  if (!Number.isInteger(maxOracleAge) || maxOracleAge <= 0) throw new Error("oracle max age must be a positive integer");

  const v3FactoryArtifact = loadArtifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const npmArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const descriptorArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
  const nftDescriptorArtifact = loadArtifact("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
  const swapRouterArtifact = loadArtifact("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

  const weth = await deployRoot("RobinhoodTestnetWETH9", [false], deployer);
  const v3Factory = await deployArtifact("UniswapV3Factory", v3FactoryArtifact, [], deployer);
  const nftDescriptor = await deployArtifact("NFTDescriptor", nftDescriptorArtifact, [], deployer);
  const tokenDescriptor = await deployArtifact(
    "NonfungibleTokenPositionDescriptor",
    descriptorArtifact,
    [weth.address, ethers.encodeBytes32String("ETH")],
    deployer,
    { NFTDescriptor: nftDescriptor.address },
  );
  const positionManager = await deployArtifact(
    "NonfungiblePositionManager",
    npmArtifact,
    [v3Factory.address, weth.address, tokenDescriptor.address],
    deployer,
  );
  const swapRouter02 = await deployArtifact(
    "SwapRouter02",
    swapRouterArtifact,
    [ethers.ZeroAddress, v3Factory.address, positionManager.address, weth.address],
    deployer,
  );
  const oracle = await deployRoot("RobinhoodTestnetEthUsdOracle", [oracleUpdater, initialOracleAnswer, false], deployer);

  const factoryRead = new ethers.Contract(v3Factory.address, ["function feeAmountTickSpacing(uint24) view returns (int24)"], ethers.provider);
  const npmRead = new ethers.Contract(positionManager.address, ["function factory() view returns (address)", "function WETH9() view returns (address)"], ethers.provider);
  const routerRead = new ethers.Contract(swapRouter02.address, ["function factory() view returns (address)", "function WETH9() view returns (address)"], ethers.provider);
  const oracleRead = new ethers.Contract(oracle.address, ["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], ethers.provider);

  const spacing = BigInt(await factoryRead.feeAmountTickSpacing(authority.V3_FEE_TIER));
  if (spacing <= 0n) throw new Error("canonical V3 factory fee tier 3000 is not enabled");
  const npmFactory = await npmRead.factory();
  const npmWeth9 = await npmRead.WETH9();
  const routerFactory = await routerRead.factory();
  const routerWeth9 = await routerRead.WETH9();
  authority.requireBoundAddress("NPM factory", npmFactory, v3Factory.address);
  authority.requireBoundAddress("NPM WETH9", npmWeth9, weth.address);
  authority.requireBoundAddress("router factory", routerFactory, v3Factory.address);
  authority.requireBoundAddress("router WETH9", routerWeth9, weth.address);
  const routerRuntime = await runtimeCodeEvidence(swapRouter02.address);
  authority.requireSwapRouter02Runtime(routerRuntime.code);

  const round = await oracleRead.latestRoundData();
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("latest block unavailable");
  authority.validateOracleObservation({
    decimals: Number(await oracleRead.decimals()),
    roundId: round[0],
    answer: round[1],
    updatedAt: round[3],
    answeredInRound: round[4],
    currentTimestamp: latestBlock.timestamp,
    maxAgeSeconds: maxOracleAge,
  });

  const deployments = {
    weth: stripContract(weth),
    v3Factory: stripContract(v3Factory),
    positionManager: stripContract(positionManager),
    swapRouter02: stripContract(swapRouter02),
    oracle: stripContract(oracle),
  };
  const manifest = authority.buildInfrastructureManifest({
    chainId,
    sourceSha,
    deployer: deployerAddress,
    oracleUpdater,
    feeTier: authority.V3_FEE_TIER,
    feeTickSpacing: spacing,
    deployments,
    peripheryDependencies: {
      nftDescriptor: stripContract(nftDescriptor),
      tokenDescriptor: stripContract(tokenDescriptor),
    },
    bindings: { npmFactory, npmWeth9, routerFactory, routerWeth9 },
    oracle: {
      decimals: Number(await oracleRead.decimals()),
      roundId: round[0],
      answer: round[1],
      updatedAt: round[3],
      answeredInRound: round[4],
      certifiedAtTimestamp: latestBlock.timestamp,
      maxAgeSeconds: maxOracleAge,
    },
  });
  authority.validateInfrastructureManifest(manifest);

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ manifestPath: MANIFEST_PATH, mwzEnvironment: manifest.mwzEnvironment }, null, 2));
}

function stripContract(entry: any) {
  const { contract: _contract, ...receipt } = entry;
  return receipt;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
