// EVM generation 8: DRY-RUN deployment planner. DRAFT for step 9 (design 9). It never sends anything: it has no
// RPC, reads no private key and only writes a plan file. It computes, for one chain, the exact deployment transaction
// list in the required order, the predicted addresses (hook by CREATE2 with mined flags, everything else by the
// deployer's CREATE nonces), the constructor arguments, and the two Safe batches (B: bind, H: open on the opening day).
//
//   npx hardhat --config hardhat.gen8.config.ts compile
//   node scripts/gen8/deploy/plan-gen8-deploy.mjs --chain 56 --deployer 0x... --nonce 123 [--inputs scripts/gen8/deploy/inputs.example.json]
//
// Order (each step its own founder go at step 9; design 8.5: deploys paused, opens in the combined release):
//   1. deployer EOA (holds no user money; CLAUDE.md): MwzSwapSim library, [MwzDisplayPairFactory (BNB only)],
//      CommunityRewardsVault (gen-7 code, router = the predicted splitter, admin = Safe), MwzLaunchHook through the
//      canonical CREATE2 proxy with the mined salt (owner = Safe, treasuryRouter = splitter, launcher = predicted),
//      [factory.setHook(hook)], MwzFeeSplitter (admin = Safe), MwzCreatorChoiceVault (admin = Safe), MwzReserveLock,
//      MwzV4Launcher (owner = Safe, createPaused = true), MwzLaunchLens, MwzCreatorEscrow.
//      Nothing needs an ownership transfer afterwards: every admin / owner is the Safe from the constructor.
//      The nonce order is load-bearing: the hook's init code contains the launcher and splitter addresses, and the
//      vault and reserve lock contain the launcher address; the launcher constructor reverts unless all of them point
//      at it (HookMismatch / WiringMismatch), so a nonce drift cannot produce a mis-wired live system.
//   2. Safe batch B (bind): vault.setHolderDistributorOnce, vault.setOperator, vault.setCaps, community vault
//      setRewardDistributor + setAirdropOperator, distributor.setBatchOperator(community vault) (gen-7 pot pattern).
//   3. Safe batch H (opening day, inside the combined release): launcher.setCreatePaused(false) and the gen-7
//      factories setCreatePaused(true) in the same batch (design 8.5).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadArtifacts } from "../fork-suite/artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
if (args.some((a) => /^--(send|broadcast|execute|private-key|pk)$/i.test(a))) throw new Error("dry run only: this planner never sends transactions");

const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const HOOK_FLAGS = 0x28ecn;
const chainId = Number(arg("--chain", "56"));
const deployer = ethers.getAddress(arg("--deployer", "0x0000000000000000000000000000000000000001"));
const nonce0 = Number(arg("--nonce", "0"));
const inputsFile = arg("--inputs", path.join(here, "inputs.example.json"));
const allInputs = JSON.parse(fs.readFileSync(inputsFile, "utf8"));
const I = allInputs[String(chainId)];
if (!I) throw new Error(`no inputs for chain ${chainId} in ${inputsFile}`);
const todo = Object.entries(I).filter(([, v]) => typeof v === "string" && v.startsWith("TODO"));

const { contracts: C, solcVersion } = loadArtifacts();
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = (n) => new ethers.Interface(C[n].abi);
const placeholder = (k) => (I[k] && !String(I[k]).startsWith("TODO") ? ethers.getAddress(I[k]) : ethers.getAddress("0x" + ethers.id("todo:" + k).slice(26)));

let n = nonce0;
const txs = [];
const addr = {};
const create = (label, name, ctorTypes, ctorArgs, libs) => {
  const art = libs ? C.link(name, libs) : C[name];
  const data = ethers.concat([art.bytecode, coder.encode(ctorTypes, ctorArgs)]);
  const a = ethers.getCreateAddress({ from: deployer, nonce: n });
  txs.push({ step: txs.length + 1, nonce: n, label, kind: "CREATE", contract: name, predicted: a, constructorArgs: ctorArgs.map(String), dataBytes: (data.length - 2) / 2, dataHash: ethers.keccak256(data) });
  addr[label] = a;
  n++;
  return a;
};
const call = (label, to, ifc, fn, fnArgs) => {
  txs.push({ step: txs.length + 1, nonce: n, label, kind: "CALL", to, function: fn, args: fnArgs.map(String), data: ifc.encodeFunctionData(fn, fnArgs) });
  n++;
};

const safe = placeholder("safe");
const display = chainId === 56 || chainId === 97;
// fixed nonce plan: lib, [factory], community, hook tx, [setHook], splitter, vault, lock, launcher, lens, escrow
const plan = { lib: nonce0, factory: display ? nonce0 + 1 : null };
let k = nonce0 + (display ? 2 : 1);
plan.community = k++;
plan.hookTx = k++;
if (display) plan.setHook = k++;
plan.splitter = k++;
plan.vault = k++;
plan.lock = k++;
plan.launcher = k++;
const predicted = (key) => ethers.getCreateAddress({ from: deployer, nonce: plan[key] });

const swapSim = create("MwzSwapSim", "MwzSwapSim", [], []);
const factory = display ? create("MwzDisplayPairFactory", "MwzDisplayPairFactory", ["address"], [placeholder("wrappedNative")]) : ethers.ZeroAddress;
create("CommunityRewardsVault (gen-8 pot, gen-7 code)", "CommunityRewardsVault", ["address", "address"], [safe, predicted("splitter")]);
const hookArt = C.link("MwzLaunchHook", { MwzSwapSim: swapSim });
const hookInit = ethers.concat([hookArt.bytecode, coder.encode(["address", "address", "address", "address", "address"], [placeholder("poolManager"), predicted("launcher"), safe, predicted("splitter"), factory])]);
const initHash = ethers.keccak256(hookInit);
let salt, hook, tries = 0;
for (let i = 0n; ; i++) {
  tries++;
  const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
  const a = ethers.getCreate2Address(CREATE2_PROXY, s, initHash);
  if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) {
    salt = s;
    hook = a;
    break;
  }
}
txs.push({ step: txs.length + 1, nonce: n, label: "MwzLaunchHook (CREATE2 proxy)", kind: "CALL", to: CREATE2_PROXY, salt, predicted: hook, initCodeHash: initHash, saltTries: tries, dataBytes: 32 + (hookInit.length - 2) / 2 });
addr.MwzLaunchHook = hook;
n++;
if (display) call("MwzDisplayPairFactory.setHook", factory, iface("MwzDisplayPairFactory"), "setHook", [hook]);
const splitter = create("MwzFeeSplitter", "MwzFeeSplitter", ["address", "address", "address", "address", "address", "address", "address", "address"], [
  hook, safe, placeholder("weeklyLeagueVault"), placeholder("monthlyLeagueTreasury"), placeholder("recruiterRewardsVault"), addr["CommunityRewardsVault (gen-8 pot, gen-7 code)"], placeholder("protocolRevenue"), placeholder("splitterOperator"),
]);
const vault = create("MwzCreatorChoiceVault", "MwzCreatorChoiceVault", ["address", "address", "address", "uint256"], [safe, hook, predicted("launcher"), BigInt(I.holderBatchDelaySeconds ?? 86400)]);
const lock = create("MwzReserveLock", "MwzReserveLock", ["address", "address", "address"], [hook, predicted("launcher"), vault]);
const launcher = create("MwzV4Launcher", "MwzV4Launcher", ["address", "address", "address", "address", "address", "address", "address", "uint256", "uint256"], [
  placeholder("poolManager"), hook, placeholder("graduationOracle"), lock, vault, safe, placeholder("createSigner"), ethers.parseEther(String(I.minNativeUsd)), ethers.parseEther(String(I.maxNativeUsd)),
]);
create("MwzLaunchLens", "MwzLaunchLens", ["address"], [hook], { MwzSwapSim: swapSim });
create("MwzCreatorEscrow", "MwzCreatorEscrow", ["address"], [hook]);

const wiring = [
  ["splitter at the address baked into the hook", splitter === predicted("splitter")],
  ["launcher at the address baked into hook, vault and reserve lock", launcher === predicted("launcher")],
  ["hook carries flags 0x28EC", (BigInt(hook) & 0x3fffn) === HOOK_FLAGS],
];

// Safe batches (Transaction Builder JSON shape), not executed here
const vaultI = iface("MwzCreatorChoiceVault");
const comI = new ethers.Interface(["function setRewardDistributor(address)", "function setAirdropOperator(address)"]);
const distI = new ethers.Interface(["function setBatchOperator(address)"]);
const batchB = [
  { to: vault, data: vaultI.encodeFunctionData("setHolderDistributorOnce", [placeholder("holderDistributor")]), note: "holder distributor (gen-8 vault is a new batch operator on it: the distributor's Safe authorization must name it)" },
  { to: vault, data: vaultI.encodeFunctionData("setOperator", [placeholder("vaultOperator"), false]), note: "vault operator (same key as the gen-7 vault operator)" },
  { to: vault, data: vaultI.encodeFunctionData("setCaps", [ethers.parseEther(String(I.caps.maxBuyPerTx)), ethers.parseEther(String(I.caps.maxBuybackPerCoinWeek)), BigInt(I.caps.minBuyIntervalSeconds), BigInt(I.caps.maxImpactBps), ethers.parseEther(String(I.caps.maxHolderBatchPerWeek))]), note: "E15 caps (gen-7 values)" },
  { to: addr["CommunityRewardsVault (gen-8 pot, gen-7 code)"], data: comI.encodeFunctionData("setRewardDistributor", [placeholder("airdropDistributor")]), note: "gen-8 airdrop pot distributor (D8: the gen-7 community vault pins its router, so gen-8 has its own vault)" },
  { to: addr["CommunityRewardsVault (gen-8 pot, gen-7 code)"], data: comI.encodeFunctionData("setAirdropOperator", [placeholder("airdropOperator")]), note: "airdrop operator (as gen-7)" },
  { to: placeholder("airdropDistributor"), data: distI.encodeFunctionData("setBatchOperator", [addr["CommunityRewardsVault (gen-8 pot, gen-7 code)"]]), note: "only if the gen-8 pot gets its own RewardDistributor" },
];
const launcherI = iface("MwzV4Launcher");
const factoryI = new ethers.Interface(["function setCreatePaused(bool)"]);
const batchH = [
  { to: launcher, data: launcherI.encodeFunctionData("setCreatePaused", [false]), note: "gen-8 opens (opening day, combined release only)" },
  ...(I.gen7Factories || []).map((f) => ({ to: f, data: factoryI.encodeFunctionData("setCreatePaused", [true]), note: "gen-7 factory stops new launches (C11 pattern); its coins keep trading" })),
];

const out = {
  dryRun: true,
  generatedAt: new Date().toISOString(),
  chainId,
  deployer,
  nonce0,
  solcVersion,
  compiler: { version: "0.8.26", evmVersion: "cancun", viaIR: true, optimizerRuns: 200, bytecodeHash: "none" },
  pins: { "@uniswap/v4-core": "1.0.2", "@uniswap/v4-periphery": "1.0.3" },
  inputsWithTodo: todo.map(([k2]) => k2),
  addresses: addr,
  wiring: Object.fromEntries(wiring),
  transactions: txs,
  safeBatches: { B_bind: batchB, H_open: batchH },
  preconditions: [
    `canonical CREATE2 proxy ${CREATE2_PROXY} has code on chain ${chainId}`,
    `deployer ${deployer} nonce is exactly ${nonce0} when step 1 starts, and nothing else sends from it until step 1 ends`,
    "graduation oracle maxPriceAge <= 2 days and its price inside [minNativeUsd, maxNativeUsd] (launcher constructor checks the first)",
    "weekly league vault, monthly league treasury, recruiter vault and protocol revenue destination accept plain native from the splitter (gen-7 router paths do the same)",
    "create signer is the API create-authorization key (D3); the Safe can rotate it",
  ],
};
fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
const file = path.join(ROOT, "output", `gen8-deploy-plan-${chainId}.dry-run.json`);
fs.writeFileSync(file, JSON.stringify(out, (k2, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(`DRY RUN ONLY (nothing sent). chain ${chainId}, deployer ${deployer}, nonce ${nonce0}`);
for (const t of txs) console.log(`  ${String(t.step).padStart(2)} nonce ${t.nonce}  ${t.kind.padEnd(6)} ${t.label}${t.predicted ? "  -> " + t.predicted : ""}`);
for (const [w, ok] of wiring) console.log(`  wiring: ${w}: ${ok ? "ok" : "MISMATCH"}`);
if (todo.length) console.log(`  inputs still TODO (placeholders used): ${todo.map(([k2]) => k2).join(", ")}`);
console.log(`  plan written to ${path.relative(ROOT, file)}`);
if (wiring.some(([, ok]) => !ok)) process.exit(1);
