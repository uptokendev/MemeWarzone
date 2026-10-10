import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// DogeOS Chikyū testnet (6281971) identity across chainConfig, the chain registry, the EVM
// wallet adapter and the WalletConnect RPC map. Existing chains are pinned by a snapshot taken
// from the code before DogeOS was added, so any drift on 56/97/101/4663/46630 fails here.

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, "..");
const frontendRoot = path.resolve(srcRoot, "..");

const DOGEOS = 6281971;
const DOGEOS_RPC = "https://rpc.testnet.dogeos.com";
const DOGEOS_EXPLORER = "https://dogeos-testnet.l2scan.co";
const BSC_TESTNET_SENTINEL = "https://bsc-testnet.sentinel.invalid/";

const BASE_ENV = {
  DEV: false,
  PROD: true,
  VITE_DEFAULT_CHAIN_ID: "97",
  VITE_ALLOWED_CHAIN_IDS: "56,97,101,4663,46630,6281971",
  // A configured BSC testnet RPC: an unknown chain that falls through would pick this up.
  VITE_BSC_TESTNET_RPC: BSC_TESTNET_SENTINEL,
  VITE_SOLANA_RPC: "https://solana.sentinel.invalid/",
};

async function loadHarness(name, env) {
  // Namespace imports so a missing export shows up as a failing assertion, not a build error.
  const compiled = await build({
    absWorkingDir: dir,
    stdin: {
      contents: `
import * as chainConfig from "./chainConfig.ts";
import * as chainRegistry from "./chainRegistry.ts";
import * as evmChainAdapter from "./evmChainAdapter.ts";
import { walletConnectTestContract } from "./walletConnect.ts";
export { chainConfig, chainRegistry, evmChainAdapter, walletConnectTestContract };
`,
      resolveDir: dir,
      sourcefile: `${name}.ts`,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@": srcRoot },
    define: { "import.meta.env": JSON.stringify(env) },
  });
  // Inside the frontend package tree so Node resolves frontend/node_modules (gitignored dir).
  const tmpDir = await mkdtemp(path.join(frontendRoot, ".mwz-feed-isolation-"));
  const outfile = path.join(tmpDir, `${name}.mjs`);
  await writeFile(outfile, compiled.outputFiles[0].text);
  return import(pathToFileURL(outfile).href);
}

const base = await loadHarness("dogeosIdentityHarness", BASE_ENV);
const withEnvRpc = await loadHarness("dogeosIdentityEnvRpcHarness", {
  ...BASE_ENV,
  VITE_PUBLIC_RPC_6281971: "https://dogeos-a.example/, https://dogeos-b.example/",
});

const { chainConfig, chainRegistry, evmChainAdapter, walletConnectTestContract } = base;

// Captured from chainConfig/chainRegistry/evmChainAdapter/walletConnect at the task's starting
// commit (93f762b47) with BASE_ENV, before any DogeOS change. Never edit these to make a test pass.
const PRE_EXISTING_CHAIN_SNAPSHOT = {
  56: {"isSupportedChainId":true,"isEvmChainId":true,"isRobinhoodChainId":false,"isSolanaChainId":false,"nativeSymbol":"BNB","publicRpcUrl":"https://bsc-dataseed.binance.org/","publicRpcUrls":["https://bsc-dataseed.binance.org/"],"explorerTxBase":"https://bscscan.com/tx/","chainParams":{"chainId":"0x38","chainName":"BNB Smart Chain","nativeCurrency":{"name":"BNB","symbol":"BNB","decimals":18},"rpcUrls":["https://bsc-dataseed.binance.org/"],"blockExplorerUrls":["https://bscscan.com/"]},"chainLabel":"BNB","isKnownEvmChainId":true,"isActiveEvmChainId":true,"walletParams":{"chainId":"0x38","chainName":"BNB Smart Chain","nativeCurrency":{"name":"BNB","symbol":"BNB","decimals":18},"rpcUrls":["https://bsc-dataseed.binance.org/"],"blockExplorerUrls":["https://bscscan.com/"]},"evmChainLabel":"BNB","evmExplorerTxBase":"https://bscscan.com/tx/"},
  97: {"isSupportedChainId":true,"isEvmChainId":true,"isRobinhoodChainId":false,"isSolanaChainId":false,"nativeSymbol":"BNB","publicRpcUrl":"https://bsc-testnet.sentinel.invalid/","publicRpcUrls":["https://bsc-testnet.sentinel.invalid/"],"explorerTxBase":"https://testnet.bscscan.com/tx/","chainParams":{"chainId":"0x61","chainName":"BNB Smart Chain Testnet","nativeCurrency":{"name":"tBNB","symbol":"tBNB","decimals":18},"rpcUrls":["https://bsc-testnet.sentinel.invalid/"],"blockExplorerUrls":["https://testnet.bscscan.com/"]},"chainLabel":"BNB Testnet","isKnownEvmChainId":true,"isActiveEvmChainId":true,"walletParams":{"chainId":"0x61","chainName":"BNB Smart Chain Testnet","nativeCurrency":{"name":"tBNB","symbol":"tBNB","decimals":18},"rpcUrls":["https://bsc-testnet.sentinel.invalid/"],"blockExplorerUrls":["https://testnet.bscscan.com/"]},"evmChainLabel":"BNB Testnet","evmExplorerTxBase":"https://testnet.bscscan.com/tx/"},
  101: {"isSupportedChainId":true,"isEvmChainId":false,"isRobinhoodChainId":false,"isSolanaChainId":true,"nativeSymbol":"SOL","publicRpcUrl":"https://solana.sentinel.invalid/","publicRpcUrls":["https://solana.sentinel.invalid/"],"explorerTxBase":"https://solscan.io/tx/","chainParams":{"chainId":"0x65","chainName":"Solana mainnet","nativeCurrency":{"name":"SOL","symbol":"SOL","decimals":9},"rpcUrls":["https://solana.sentinel.invalid/"],"blockExplorerUrls":["https://solscan.io/"]},"chainLabel":"Solana","isKnownEvmChainId":false,"isActiveEvmChainId":false},
  4663: {"isSupportedChainId":true,"isEvmChainId":true,"isRobinhoodChainId":true,"isSolanaChainId":false,"nativeSymbol":"ETH","publicRpcUrl":"https://rpc.mainnet.chain.robinhood.com","publicRpcUrls":["https://rpc.mainnet.chain.robinhood.com"],"explorerTxBase":"https://robinhoodchain.blockscout.com/tx/","chainParams":{"chainId":"0x1237","chainName":"Robinhood Chain","nativeCurrency":{"name":"Ether","symbol":"ETH","decimals":18},"rpcUrls":["https://rpc.mainnet.chain.robinhood.com"],"blockExplorerUrls":["https://robinhoodchain.blockscout.com/"]},"chainLabel":"Robinhood","isKnownEvmChainId":true,"isActiveEvmChainId":false,"walletParams":{"chainId":"0x1237","chainName":"Robinhood Chain","nativeCurrency":{"name":"ETH","symbol":"ETH","decimals":18},"rpcUrls":["https://rpc.mainnet.chain.robinhood.com"],"blockExplorerUrls":["https://robinhoodchain.blockscout.com/"]},"evmChainLabel":"Robinhood","evmExplorerTxBase":"https://robinhoodchain.blockscout.com/tx/"},
  46630: {"isSupportedChainId":true,"isEvmChainId":true,"isRobinhoodChainId":true,"isSolanaChainId":false,"nativeSymbol":"ETH","publicRpcUrl":"https://rpc.testnet.chain.robinhood.com","publicRpcUrls":["https://rpc.testnet.chain.robinhood.com"],"explorerTxBase":"https://explorer.testnet.chain.robinhood.com/tx/","chainParams":{"chainId":"0xb626","chainName":"Robinhood Chain Testnet","nativeCurrency":{"name":"Ether","symbol":"ETH","decimals":18},"rpcUrls":["https://rpc.testnet.chain.robinhood.com"],"blockExplorerUrls":["https://explorer.testnet.chain.robinhood.com/"]},"chainLabel":"Robinhood Testnet","isKnownEvmChainId":true,"isActiveEvmChainId":false,"walletParams":{"chainId":"0xb626","chainName":"Robinhood Chain Testnet","nativeCurrency":{"name":"ETH","symbol":"ETH","decimals":18},"rpcUrls":["https://rpc.testnet.chain.robinhood.com"],"blockExplorerUrls":["https://explorer.testnet.chain.robinhood.com/"]},"evmChainLabel":"Robinhood Testnet","evmExplorerTxBase":"https://explorer.testnet.chain.robinhood.com/tx/"},
};

const PRE_EXISTING_REGISTRY_SNAPSHOT = {
  "bnb-mainnet": {"key":"bnb-mainnet","displayName":"BNB Chain","family":"evm","networkClass":"production","runtimeEnvironment":"production","chainId":56,"nativeAsset":"BNB","explorerBaseUrl":"https://bscscan.com","publicRpcEnvKey":"VITE_PUBLIC_RPC_56","deploymentManifest":"deployments/bnb/mainnet.json","graduationAdapter":"topaz","swapAdapter":"topaz","oracleAdapter":"bnb-usd","supportsCreation":true},
  "bnb-testnet": {"key":"bnb-testnet","displayName":"BNB Chain Testnet","family":"evm","networkClass":"test","runtimeEnvironment":"staging","chainId":97,"nativeAsset":"tBNB","explorerBaseUrl":"https://testnet.bscscan.com","publicRpcEnvKey":"VITE_PUBLIC_RPC_97","deploymentManifest":"deployments/bnb/testnet.json","graduationAdapter":"topaz-testnet","swapAdapter":"topaz-testnet","oracleAdapter":"bnb-usd-test","supportsCreation":true},
  "solana-mainnet": {"key":"solana-mainnet","displayName":"Solana","family":"solana","networkClass":"production","runtimeEnvironment":"production","chainId":101,"nativeAsset":"SOL","explorerBaseUrl":"https://solscan.io","publicRpcEnvKey":"VITE_SOLANA_MAINNET_RPC","deploymentManifest":"deployments/solana/mainnet.json","graduationAdapter":"meteora","swapAdapter":"meteora","oracleAdapter":"sol-usd","supportsCreation":true},
  "solana-devnet": {"key":"solana-devnet","displayName":"Solana Devnet","family":"solana","networkClass":"test","runtimeEnvironment":"staging","chainId":101,"nativeAsset":"SOL","explorerBaseUrl":"https://solscan.io","publicRpcEnvKey":"VITE_SOLANA_DEVNET_RPC","deploymentManifest":"deployments/solana/devnet.json","graduationAdapter":"meteora-devnet","swapAdapter":"meteora-devnet","oracleAdapter":"sol-usd-test","supportsCreation":true},
  "robinhood-mainnet": {"key":"robinhood-mainnet","displayName":"Robinhood","family":"evm","networkClass":"production","runtimeEnvironment":"production","chainId":4663,"nativeAsset":"ETH","explorerBaseUrl":"https://robinhoodchain.blockscout.com","publicRpcEnvKey":"VITE_PUBLIC_RPC_4663","deploymentManifest":"deployments/robinhood/mainnet.json","graduationAdapter":"robinhood-dex","swapAdapter":"robinhood-dex","oracleAdapter":"eth-usd","supportsCreation":false},
  "robinhood-testnet": {"key":"robinhood-testnet","displayName":"Robinhood Testnet","family":"evm","networkClass":"test","runtimeEnvironment":"staging","chainId":46630,"nativeAsset":"ETH","explorerBaseUrl":"https://explorer.testnet.chain.robinhood.com","publicRpcEnvKey":"VITE_PUBLIC_RPC_46630","deploymentManifest":"deployments/robinhood/testnet.json","graduationAdapter":"robinhood-dex-testnet","swapAdapter":"robinhood-dex-testnet","oracleAdapter":"eth-usd-test","supportsCreation":false},
};

const PRE_EXISTING_WALLETCONNECT_RPC_MAP = {"56":"https://bsc-dataseed.binance.org/","97":"https://data-seed-prebsc-1-s1.binance.org:8545/","4663":"https://rpc.mainnet.chain.robinhood.com","46630":"https://rpc.testnet.chain.robinhood.com"};

function snapshotRow(id) {
  const c = chainConfig;
  const e = evmChainAdapter;
  const row = {
    isSupportedChainId: c.isSupportedChainId(id),
    isEvmChainId: c.isEvmChainId(id),
    isRobinhoodChainId: c.isRobinhoodChainId(id),
    isSolanaChainId: c.isSolanaChainId(id),
    nativeSymbol: c.getNativeSymbol(id),
    publicRpcUrl: c.getPublicRpcUrl(id),
    publicRpcUrls: c.getPublicRpcUrls(id),
    explorerTxBase: c.getExplorerTxBase(id),
    chainParams: c.getChainParams(id),
    chainLabel: c.getChainLabel(id),
    isKnownEvmChainId: e.isKnownEvmChainId(id),
    isActiveEvmChainId: e.isActiveEvmChainId(id),
  };
  if (e.isKnownEvmChainId(id)) {
    row.walletParams = e.buildEvmWalletChainParams(id, c.getPublicRpcUrls(id));
    row.evmChainLabel = e.getEvmChainLabel(id);
    row.evmExplorerTxBase = e.getEvmExplorerTxBase(id);
  }
  return row;
}

test("pre-existing chains 56/97/101/4663/46630 keep byte-identical outputs", () => {
  for (const [id, expected] of Object.entries(PRE_EXISTING_CHAIN_SNAPSHOT)) {
    assert.deepEqual(snapshotRow(Number(id)), expected, `chain ${id} drifted`);
  }
});

test("pre-existing registry entries and WalletConnect RPC fallbacks are unchanged", () => {
  for (const [key, expected] of Object.entries(PRE_EXISTING_REGISTRY_SNAPSHOT)) {
    assert.deepEqual({ ...chainRegistry.CHAIN_REGISTRY[key] }, expected, `registry ${key} drifted`);
  }
  assert.deepEqual(
    walletConnectTestContract.rpcMapFor([56, 97, 4663, 46630]),
    PRE_EXISTING_WALLETCONNECT_RPC_MAP,
  );
});

test("supported and known lists keep their existing members and order, DogeOS appended", () => {
  assert.deepEqual(chainConfig.SUPPORTED_CHAIN_IDS, [56, 97, 101, 4663, 46630, DOGEOS]);
  assert.deepEqual(evmChainAdapter.KNOWN_EVM_CHAIN_IDS, [56, 97, 4663, 46630, DOGEOS]);
  // Activation is a separate gate: DogeOS never joins ACTIVE.
  assert.deepEqual(evmChainAdapter.ACTIVE_EVM_CHAIN_IDS, [56, 97]);
  assert.equal(evmChainAdapter.isActiveEvmChainId(DOGEOS), false);
});

test("isDogeosChainId recognises only 6281971 and DogeOS is never a Robinhood chain", () => {
  assert.equal(chainConfig.DOGEOS_TESTNET_CHAIN_ID, DOGEOS);
  assert.equal(typeof chainConfig.isDogeosChainId, "function");
  assert.equal(chainConfig.isDogeosChainId(DOGEOS), true);
  for (const other of [56, 97, 101, 4663, 46630, 0, null, undefined, 628197, 62819710]) {
    assert.equal(chainConfig.isDogeosChainId(other), false, `isDogeosChainId(${other})`);
  }
  assert.equal(chainConfig.isRobinhoodChainId(DOGEOS), false);
  assert.equal(chainConfig.isSolanaChainId(DOGEOS), false);
});

test("DogeOS is a supported EVM chain, allowed only because VITE_ALLOWED_CHAIN_IDS lists it", () => {
  assert.equal(chainConfig.isSupportedChainId(DOGEOS), true);
  assert.equal(chainConfig.isEvmChainId(DOGEOS), true);
  assert.equal(chainConfig.coerceSupportedChainId(String(DOGEOS)), DOGEOS);
  assert.ok(chainConfig.getAllowedChainIds().includes(DOGEOS));
  assert.equal(chainConfig.isAllowedChainId(DOGEOS), true);
  assert.equal(evmChainAdapter.isKnownEvmChainId(DOGEOS), true);
});

test("native symbol is DOGE, never BNB or ETH", () => {
  assert.equal(chainConfig.getNativeSymbol(DOGEOS), "DOGE");
});

test("public RPC defaults to the DogeOS RPC and never falls through to BSC testnet", () => {
  assert.equal(chainConfig.getPublicRpcUrl(DOGEOS), DOGEOS_RPC);
  assert.deepEqual(chainConfig.getPublicRpcUrls(DOGEOS), [DOGEOS_RPC]);
  for (const url of chainConfig.getPublicRpcUrls(DOGEOS)) {
    assert.doesNotMatch(url, /bsc|binance|sentinel/i);
  }
});

test("VITE_PUBLIC_RPC_6281971 overrides the DogeOS default", () => {
  assert.equal(withEnvRpc.chainConfig.getPublicRpcUrl(DOGEOS), "https://dogeos-a.example/");
  assert.deepEqual(withEnvRpc.chainConfig.getPublicRpcUrls(DOGEOS), [
    "https://dogeos-a.example/",
    "https://dogeos-b.example/",
  ]);
});

test("explorer is L2Scan for both tx links and the EVM adapter", () => {
  assert.equal(chainConfig.getExplorerTxBase(DOGEOS), `${DOGEOS_EXPLORER}/tx/`);
  assert.equal(evmChainAdapter.getEvmExplorerTxBase(DOGEOS), `${DOGEOS_EXPLORER}/tx/`);
});

test("getChainParams has its own DogeOS block (0x5fdaf3, DOGE/18, L2Scan)", () => {
  assert.equal(`0x${DOGEOS.toString(16)}`, "0x5fdaf3");
  assert.deepEqual(chainConfig.getChainParams(DOGEOS), {
    chainId: "0x5fdaf3",
    chainName: "DogeOS Chikyū Testnet",
    nativeCurrency: { name: "DOGE", symbol: "DOGE", decimals: 18 },
    rpcUrls: [DOGEOS_RPC],
    blockExplorerUrls: [`${DOGEOS_EXPLORER}/`],
  });
});

test("wallet add-chain params for DogeOS: hex chain id, DOGE/18, DogeOS RPC, L2Scan", () => {
  const params = evmChainAdapter.buildEvmWalletChainParams(DOGEOS, chainConfig.getPublicRpcUrls(DOGEOS));
  assert.deepEqual(params, {
    chainId: "0x5fdaf3",
    chainName: "DogeOS Chikyū Testnet",
    nativeCurrency: { name: "DOGE", symbol: "DOGE", decimals: 18 },
    rpcUrls: [DOGEOS_RPC],
    blockExplorerUrls: [`${DOGEOS_EXPLORER}/`],
  });
});

test("chain labels name DogeOS Chikyū Testnet", () => {
  assert.equal(chainConfig.getChainLabel(DOGEOS), "DogeOS Chikyū Testnet");
  assert.equal(evmChainAdapter.getEvmChainLabel(DOGEOS), "DogeOS Chikyū Testnet");
});

test("WalletConnect RPC map gets the DogeOS RPC when DogeOS is negotiated", () => {
  assert.deepEqual(walletConnectTestContract.rpcMapFor([DOGEOS]), { [DOGEOS]: DOGEOS_RPC });
  assert.deepEqual(withEnvRpc.walletConnectTestContract.rpcMapFor([DOGEOS]), {
    [DOGEOS]: "https://dogeos-a.example/, https://dogeos-b.example/",
  });
});

test("registry entry dogeos-testnet: evm, test, staging, DOGE/18 via L2Scan, RH-testnet adapters", () => {
  const entry = chainRegistry.CHAIN_REGISTRY["dogeos-testnet"];
  assert.ok(entry, "missing dogeos-testnet registry entry");
  assert.deepEqual({ ...entry }, {
    key: "dogeos-testnet",
    displayName: "DogeOS Chikyū Testnet",
    family: "evm",
    networkClass: "test",
    runtimeEnvironment: "staging",
    chainId: DOGEOS,
    nativeAsset: "DOGE",
    explorerBaseUrl: DOGEOS_EXPLORER,
    publicRpcEnvKey: "VITE_PUBLIC_RPC_6281971",
    deploymentManifest: "deployments/dogeos/testnet.json",
    graduationAdapter: "robinhood-dex-testnet",
    swapAdapter: "robinhood-dex-testnet",
    oracleAdapter: "doge-usd-test",
    supportsCreation: false,
  });
  assert.equal(chainRegistry.getChainDefinition("dogeos-testnet"), entry);
  assert.equal(evmChainAdapter.getEvmChainDefinition(DOGEOS), entry);
  assert.ok(chainRegistry.getEvmChainsForEnvironment("staging").includes(entry));
  assert.ok(!chainRegistry.getChainsForEnvironment("production").includes(entry));
});
