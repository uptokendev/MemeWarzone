import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

export const RH46630_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://rpc.testnet.chain.robinhood.com";

// Live 46630 V3 surface reachable from the green launch factory 0xd03D.
export const LIVE_SWAP_ROUTER = "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296";
export const LIVE_WETH9 = "0x52A47A33930B8a90a2000b1bA3CB96e879569670";

// The staged 0xF170 deployment has its own V3 surface and its own already-deployed
// adapter. Binding to any of these would produce an adapter that silently trades on
// the wrong pools, so they are refused by address.
export const STAGED_SWAP_ROUTER = "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a";
export const STAGED_WETH9 = "0x632061cA786f7B585Bbd46A792FDA92B02f70671";
export const STAGED_NATIVE_SWAP_ADAPTER = "0x1948411B84424f6f67fDf83ce4A9b8ED49c8bF4F";

// Deployed 2026-09-18, tx 0x0102622e, bound to the live router/WETH below.
export const LIVE_NATIVE_SWAP_ADAPTER = "0x1BE64fC0b485319057Bf527Bcb22d0e4380F12E2";
export const LIVE_V3_FACTORY = "0x948463E91d63a7A51cEeC0342735D1B738044aea";

export const ARTIFACT_PATH =
  "artifacts/contracts/integrations/RobinhoodV3NativeSwapAdapter.sol/RobinhoodV3NativeSwapAdapter.json";
export const QUOTER_ARTIFACT_PATH =
  "artifacts/contracts/integrations/RobinhoodV3Quoter.sol/RobinhoodV3Quoter.json";

const ADAPTER_ABI = [
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
];

const QUOTER_ABI = [
  "function factory() view returns (address)",
  "function quoteExactInputSingle(address,address,uint24,uint256) returns (uint256)",
];

function loadArtifact(relativePath) {
  const resolved = path.resolve(relativePath);
  if (!fs.existsSync(resolved)) throw new Error(`ARTIFACT_MISSING:${resolved}`);
  const artifact = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!artifact?.bytecode || artifact.bytecode === "0x") throw new Error(`ARTIFACT_HAS_NO_BYTECODE:${resolved}`);
  return artifact;
}

export function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function assertChainId(chainId) {
  const id = Number(chainId);
  if (id === FORBIDDEN_PRODUCTION_CHAIN_ID) throw new Error("PRODUCTION_4663_FORBIDDEN");
  if (id !== RH46630_CHAIN_ID) throw new Error(`WRONG_CHAIN_${id}`);
  return id;
}

export function assertLiveSurface(swapRouter, weth9) {
  const router = String(swapRouter || "").trim();
  const weth = String(weth9 || "").trim();
  if (sameAddress(router, STAGED_SWAP_ROUTER)) throw new Error("STAGED_SWAP_ROUTER_FORBIDDEN");
  if (sameAddress(weth, STAGED_WETH9)) throw new Error("STAGED_WETH9_FORBIDDEN");
  if (!sameAddress(router, LIVE_SWAP_ROUTER)) throw new Error(`UNEXPECTED_SWAP_ROUTER_${router}`);
  if (!sameAddress(weth, LIVE_WETH9)) throw new Error(`UNEXPECTED_WETH9_${weth}`);
  return { swapRouter: ethers.getAddress(router), wrappedNative: ethers.getAddress(weth) };
}

export function liveRequested(env = process.env) {
  return String(env.RH46630_DEPLOY_ADAPTER_LIVE || "").trim().toLowerCase() === "true";
}

export function planAdapterDeploy(input = {}, env = process.env) {
  const chainId = assertChainId(input.chainId ?? env.T2_CHAIN_ID ?? RH46630_CHAIN_ID);
  const surface = assertLiveSurface(
    input.swapRouter ?? env.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630 ?? LIVE_SWAP_ROUTER,
    input.wrappedNative ?? env.ROBINHOOD_V3_WETH9_ADDRESS_46630 ?? LIVE_WETH9,
  );
  const live = liveRequested(env);
  return {
    mode: live ? "live-gated" : "dry-run",
    chainId,
    native: "ETH",
    contract: "RobinhoodV3NativeSwapAdapter",
    constructorArgs: [surface.swapRouter, surface.wrappedNative],
    quoterContract: "RobinhoodV3Quoter",
    quoterConstructorArgs: [ethers.getAddress(LIVE_V3_FACTORY)],
    existingAdapter: ethers.getAddress(LIVE_NATIVE_SWAP_ADAPTER),
    forbiddenStagedAdapter: STAGED_NATIVE_SWAP_ADAPTER,
    envVar: "VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630",
    quoterEnvVar: "VITE_ROBINHOOD_V3_QUOTER_ADDRESS_46630",
    liveRequested: live,
    sendRequired: live,
    sent: false,
  };
}

/**
 * Deploys the native ETH<->token adapter for the LIVE 46630 V3 surface.
 *
 * The only adapter currently on chain belongs to the staged 0xF170 deployment:
 * its swapRouter/wrappedNative point at a different V3 surface, so the frontend
 * rejects it and graduated Robinhood tokens cannot be traded from the UI at all.
 */
export async function runAdapterDeploy(input = {}, env = process.env) {
  const plan = planAdapterDeploy(input, env);
  if (!plan.liveRequested) return { ...plan, sent: false };

  const artifact = loadArtifact(String(env.RH46630_ADAPTER_ARTIFACT || ARTIFACT_PATH));
  const quoterArtifact = loadArtifact(String(env.RH46630_QUOTER_ARTIFACT || QUOTER_ARTIFACT_PATH));

  const rpcUrl = String(env.ROBINHOOD_TESTNET_RPC_URL || DEFAULT_RPC_URL).trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  assertChainId((await provider.getNetwork()).chainId);

  const deployerKey = String(env.ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY || "").trim();
  if (!deployerKey) throw new Error("MISSING_DEPLOYER_KEY");
  const deployer = new ethers.Wallet(deployerKey, provider);

  const [router, weth] = plan.constructorArgs;
  // Refuse to bind to addresses that are not live contracts.
  for (const [label, address] of [["swapRouter", router], ["wrappedNative", weth]]) {
    const code = await provider.getCode(address);
    if (!code || code === "0x") throw new Error(`${label.toUpperCase()}_HAS_NO_BYTECODE:${address}`);
  }

  // Reuse the live adapter rather than deploying a duplicate. Its immutables are
  // re-verified below either way, so a wrong or missing one still fails loudly.
  let address = ethers.getAddress(LIVE_NATIVE_SWAP_ADAPTER);
  let adapterTxHash = null;
  let adapterBlockNumber = null;
  let adapterReused = true;
  if ((await provider.getCode(address)) === "0x") {
    adapterReused = false;
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const contract = await factory.deploy(router, weth);
    const receipt = await contract.deploymentTransaction()?.wait();
    address = ethers.getAddress(await contract.getAddress());
    adapterTxHash = receipt?.hash || contract.deploymentTransaction()?.hash || null;
    adapterBlockNumber = receipt?.blockNumber ?? null;
  }

  // The adapter stores both dependencies immutably; verify what actually landed.
  const deployed = new ethers.Contract(address, ADAPTER_ABI, provider);
  const [onChainRouter, onChainWeth] = await Promise.all([deployed.swapRouter(), deployed.wrappedNative()]);
  if (!sameAddress(onChainRouter, router)) throw new Error(`DEPLOYED_ROUTER_MISMATCH_${onChainRouter}`);
  if (!sameAddress(onChainWeth, weth)) throw new Error(`DEPLOYED_WETH_MISMATCH_${onChainWeth}`);
  if (sameAddress(address, STAGED_NATIVE_SWAP_ADAPTER)) throw new Error("DEPLOYED_STAGED_ADAPTER");

  // Quoter. The live SwapRouter02 exposes no quoting, so Token Details cannot
  // price a trade without this; the staged mock router had it built in.
  const quoterFactoryAddress = ethers.getAddress(LIVE_V3_FACTORY);
  const quoterFactory = new ethers.ContractFactory(quoterArtifact.abi, quoterArtifact.bytecode, deployer);
  const quoterContract = await quoterFactory.deploy(quoterFactoryAddress);
  const quoterReceipt = await quoterContract.deploymentTransaction()?.wait();
  const quoterAddress = ethers.getAddress(await quoterContract.getAddress());

  const quoter = new ethers.Contract(quoterAddress, QUOTER_ABI, provider);
  const quoterOnChainFactory = ethers.getAddress(await quoter.factory());
  if (!sameAddress(quoterOnChainFactory, quoterFactoryAddress)) {
    throw new Error(`QUOTER_FACTORY_MISMATCH_${quoterOnChainFactory}`);
  }

  return {
    ...plan,
    sent: true,
    deployer: deployer.address,
    adapterAddress: address,
    adapterReused,
    quoterAddress,
    quoterFactory: quoterOnChainFactory,
    swapRouter: ethers.getAddress(onChainRouter),
    wrappedNative: ethers.getAddress(onChainWeth),
    txHash: adapterTxHash,
    blockNumber: adapterBlockNumber,
    quoterTxHash: quoterReceipt?.hash || quoterContract.deploymentTransaction()?.hash || null,
    quoterBlockNumber: quoterReceipt?.blockNumber ?? null,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    setEnv: {
      VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630: address,
      ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS_46630: address,
      VITE_ROBINHOOD_V3_QUOTER_ADDRESS_46630: quoterAddress,
      ROBINHOOD_V3_QUOTER_ADDRESS_46630: quoterAddress,
    },
  };
}
