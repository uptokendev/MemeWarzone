/**
 * Shared plan for a paused gen-8 deploy on BNB chain 56 and Robinhood chain 4663.
 * No private keys.
 *
 * A CREATE address is keccak256(rlp([deployer, nonce])) and does not include the
 * chain id. The same deployer at the same nonce yields the same address on 56 and
 * on 4663. Signing batches are not predicted from that formula. writeSigningBatches
 * reads deployments/{bsc,robinhood}/mainnet.gen8.json after the real deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { loadArtifacts } from "../fork-suite/artifacts.mjs";

export const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
export const CREATE_SIGNER = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
export const FORBIDDEN_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const VAULT_OPERATOR = "0x20652bdb1d986220fEc30f4733587F279403E773";
export const AIRDROP_OPERATOR = "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50";
export const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const HOOK_FLAGS = 0x28ecn;
export const UR_RUNTIME = 24380;
export const HOLDER_BATCH_DELAY = 24 * 3600;
export const MIN_NATIVE_USD = ethers.parseEther("10");
export const MAX_NATIVE_USD = ethers.parseEther("100000");
export const MAX_ORACLE_AGE = 2 * 24 * 3600;

export const CHAINS = {
  56: {
    id: 56,
    name: "BNB",
    dir: "bsc",
    rpc: "https://bsc-dataseed.bnbchain.org",
    native: "BNB",
    poolManager: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
    quoter: "0x9F75dD27D6664c475B90e105573E550ff69437B0",
    router: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f",
    routerLayout: "v2.1",
    wrapped: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    wrappedSymbol: "WBNB",
    oracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    displayFactory: true,
    gen7Factory: "0x948463E91d63a7A51cEeC0342735D1B738044aea",
    weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
    monthly: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
    recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
    protocol: "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D",
    caps: {
      maxBuyPerTx: 650000000000000000n,
      maxBuybackPerCoinWeek: 6500000000000000000n,
      minBuyInterval: 21600n,
      maxImpactBps: 50n,
      maxHolderBatchPerWeek: 32000000000000000000n,
    },
  },
  4663: {
    id: 4663,
    name: "Robinhood",
    dir: "robinhood",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    native: "ETH",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    router: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    routerLayout: "v2.1",
    wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    wrappedSymbol: "WETH",
    oracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    displayFactory: false,
    gen7Factory: "0x399E529c0C6888543E6501FD137ac49CA3E1Df58",
    weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
    monthly: "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
    recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
    protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    caps: {
      maxBuyPerTx: 190000000000000000n,
      maxBuybackPerCoinWeek: 1900000000000000000n,
      minBuyInterval: 21600n,
      maxImpactBps: 50n,
      maxHolderBatchPerWeek: 9300000000000000000n,
    },
  },
};

export function chainById(id) {
  const chain = CHAINS[Number(id)];
  if (!chain) throw new Error(`gen-8 mainnet deploy supports 56 and 4663, not ${id}`);
  return chain;
}

function mineHook(initHash) {
  for (let i = 0n; i < 200000n; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const address = ethers.getCreate2Address(CREATE2_PROXY, salt, initHash);
    if ((BigInt(address) & 0x3fffn) === HOOK_FLAGS) return { salt, address };
  }
  throw new Error("hook salt not found");
}

function iface(abi, fn, args) {
  return new ethers.Interface(abi).encodeFunctionData(fn, args);
}

/**
 * Every contract address and the exact creation transactions for one chain.
 * `nonce0` is the deployer's next nonce. Nothing is sent.
 */
export function buildDeployment(chain, deployer, nonce0) {
  const from = ethers.getAddress(deployer);
  if (from === ethers.getAddress(FORBIDDEN_DEPLOYER)) throw new Error("refusing the old deployer");
  if (from === ethers.getAddress(SAFE) || from === ethers.getAddress(CREATE_SIGNER)) {
    throw new Error("deployer must not be the Safe or the create signer");
  }
  const { contracts: C } = loadArtifacts();
  for (const name of ["MwzSwapSim", "MwzLaunchHook", "MwzDisplayPairFactory", "MwzFeeSplitter", "MwzCreatorChoiceVault", "MwzReserveLock", "MwzV4Launcher", "MwzLaunchLens", "MwzCreatorEscrow", "CommunityRewardsVault", "RewardDistributor"]) {
    if (!C[name]) throw new Error(`artifact ${name} missing under artifacts-gen8`);
  }
  const steps = chain.displayFactory
    ? ["swapSim", "factory", "community", "hook", "setHook", "splitter", "vault", "lock", "launcher", "lens", "escrow", "holder", "airdrop"]
    : ["swapSim", "community", "hook", "splitter", "vault", "lock", "launcher", "lens", "escrow", "holder", "airdrop"];
  const nonceOf = Object.fromEntries(steps.map((name, i) => [name, nonce0 + i]));
  const at = (step) => ethers.getCreateAddress({ from, nonce: nonceOf[step] });
  const addr = {
    swapSim: at("swapSim"),
    factory: chain.displayFactory ? at("factory") : ethers.ZeroAddress,
    community: at("community"),
    splitter: at("splitter"),
    vault: at("vault"),
    lock: at("lock"),
    launcher: at("launcher"),
    lens: at("lens"),
    escrow: at("escrow"),
    holder: at("holder"),
    airdrop: at("airdrop"),
  };
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const hookArt = C.link("MwzLaunchHook", { MwzSwapSim: addr.swapSim });
  const hookInit = ethers.concat([
    hookArt.bytecode,
    coder.encode(
      ["address", "address", "address", "address", "address"],
      [chain.poolManager, addr.launcher, SAFE, addr.splitter, addr.factory],
    ),
  ]);
  const mined = mineHook(ethers.keccak256(hookInit));
  addr.hook = mined.address;
  addr.hookSalt = mined.salt;

  const txs = [];
  const pushCreate = (label, step, contract, types, args, libs) => {
    const art = libs ? C.link(contract, libs) : C[contract];
    const data = ethers.concat([art.bytecode, types.length ? coder.encode(types, args) : "0x"]);
    txs.push({ label, nonce: nonceOf[step], to: null, data, expect: at(step) });
  };
  pushCreate("MwzSwapSim", "swapSim", "MwzSwapSim", [], []);
  if (chain.displayFactory) pushCreate("MwzDisplayPairFactory", "factory", "MwzDisplayPairFactory", ["address"], [chain.wrapped]);
  pushCreate("CommunityRewardsVault", "community", "CommunityRewardsVault", ["address", "address"], [SAFE, addr.splitter]);
  txs.push({
    label: "MwzLaunchHook CREATE2",
    nonce: nonceOf.hook,
    to: CREATE2_PROXY,
    data: ethers.concat([mined.salt, hookInit]),
    expect: mined.address,
  });
  if (chain.displayFactory) {
    txs.push({
      label: "MwzDisplayPairFactory.setHook",
      nonce: nonceOf.setHook,
      to: addr.factory,
      data: iface(C.MwzDisplayPairFactory.abi, "setHook", [mined.address]),
      expect: null,
    });
  }
  pushCreate(
    "MwzFeeSplitter",
    "splitter",
    "MwzFeeSplitter",
    ["address", "address", "address", "address", "address", "address", "address", "address"],
    [addr.hook, SAFE, chain.weekly, chain.monthly, chain.recruiter, addr.community, chain.protocol, ethers.ZeroAddress],
  );
  pushCreate(
    "MwzCreatorChoiceVault",
    "vault",
    "MwzCreatorChoiceVault",
    ["address", "address", "address", "uint256"],
    [SAFE, addr.hook, addr.launcher, HOLDER_BATCH_DELAY],
  );
  pushCreate("MwzReserveLock", "lock", "MwzReserveLock", ["address", "address", "address"], [addr.hook, addr.launcher, addr.vault]);
  pushCreate(
    "MwzV4Launcher",
    "launcher",
    "MwzV4Launcher",
    ["address", "address", "address", "address", "address", "address", "address", "uint256", "uint256"],
    [chain.poolManager, addr.hook, chain.oracle, addr.lock, addr.vault, SAFE, CREATE_SIGNER, MIN_NATIVE_USD, MAX_NATIVE_USD],
  );
  pushCreate("MwzLaunchLens", "lens", "MwzLaunchLens", ["address"], [addr.hook], { MwzSwapSim: addr.swapSim });
  pushCreate("MwzCreatorEscrow", "escrow", "MwzCreatorEscrow", ["address"], [addr.hook]);
  pushCreate("RewardDistributor holders", "holder", "RewardDistributor", ["address"], [SAFE]);
  pushCreate("RewardDistributor airdrop", "airdrop", "RewardDistributor", ["address"], [SAFE]);
  if (txs.length !== steps.length) throw new Error(`tx count ${txs.length} != steps ${steps.length}`);
  return { chain, deployer: from, nonce0, steps, addr, txs, endNonce: nonce0 + steps.length };
}

export function setupCalls(plan) {
  const c = plan.chain.caps;
  const calls = [
    { contract: "MwzCreatorChoiceVault", to: plan.addr.vault, fn: "setOperator", args: [VAULT_OPERATOR, false] },
    { contract: "MwzCreatorChoiceVault", to: plan.addr.vault, fn: "setCaps", args: [c.maxBuyPerTx, c.maxBuybackPerCoinWeek, c.minBuyInterval, c.maxImpactBps, c.maxHolderBatchPerWeek] },
    { contract: "MwzCreatorChoiceVault", to: plan.addr.vault, fn: "setHolderDistributorOnce", args: [plan.addr.holder] },
    { contract: "MwzFeeSplitter", to: plan.addr.splitter, fn: "setOperator", args: [VAULT_OPERATOR] },
    { contract: "CommunityRewardsVault", to: plan.addr.community, fn: "setRewardDistributor", args: [plan.addr.airdrop] },
    { contract: "CommunityRewardsVault", to: plan.addr.community, fn: "setAirdropOperator", args: [AIRDROP_OPERATOR] },
    { contract: "RewardDistributor", to: plan.addr.airdrop, fn: "setBatchOperator", args: [plan.addr.community] },
    { contract: "RewardDistributor", to: plan.addr.holder, fn: "setBatchOperator", args: [plan.addr.vault] },
  ];
  return calls;
}

export function openingCalls(plan) {
  return [
    { contract: "MwzV4Launcher", to: plan.addr.launcher, fn: "setCreatePaused", args: [false], note: "opens gen-8 creates" },
    { contract: "LaunchFactoryGen7", to: plan.chain.gen7Factory, fn: "setCreatePaused", args: [true], note: "pauses gen-7 creates; existing gen-7 coins keep trading" },
  ];
}

export function signerCalls(plan, nextSigner = CREATE_SIGNER) {
  return [
    { contract: "MwzV4Launcher", to: plan.addr.launcher, fn: "setCreateSigner", args: [ethers.getAddress(nextSigner)] },
  ];
}

const ABI = {
  MwzCreatorChoiceVault: [
    "function setOperator(address operator_, bool paused_)",
    "function setCaps(uint256 maxBuyPerTx_, uint256 maxBuybackPerCoinWeek_, uint256 minBuyInterval_, uint256 maxImpactBps_, uint256 maxHolderBatchPerWeek_)",
    "function setHolderDistributorOnce(address distributor)",
  ],
  MwzFeeSplitter: ["function setOperator(address next)"],
  CommunityRewardsVault: [
    "function setRewardDistributor(address newDistributor)",
    "function setAirdropOperator(address newOperator)",
  ],
  RewardDistributor: ["function setBatchOperator(address newOperator)"],
  MwzV4Launcher: [
    "function setCreatePaused(bool paused)",
    "function setCreateSigner(address next)",
  ],
  LaunchFactoryGen7: ["function setCreatePaused(bool paused)"],
};

function encodeCall(call) {
  const fragmentSrc = ABI[call.contract];
  if (!fragmentSrc) throw new Error(`no ABI for ${call.contract}`);
  const face = new ethers.Interface(fragmentSrc);
  const fragment = face.getFunction(call.fn);
  const data = face.encodeFunctionData(call.fn, call.args);
  const inputs = fragment.inputs.map((input) => ({
    internalType: input.type.startsWith("tuple") ? "tuple" : input.type,
    name: input.name,
    type: input.type,
    ...(input.components?.length
      ? { components: input.components.map((c) => ({ internalType: c.type, name: c.name, type: c.type })) }
      : {}),
  }));
  const contractInputsValues = {};
  const shown = (arg) => {
    if (typeof arg === "bigint") return arg.toString();
    if (Array.isArray(arg) || (arg && typeof arg === "object")) {
      return JSON.stringify(arg, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    }
    return String(arg);
  };
  fragment.inputs.forEach((input, i) => {
    contractInputsValues[input.name] = shown(call.args[i]);
  });
  // Bools are stored as "true"/"false", matching scripts/make-safe-batch.ts.
  fragment.inputs.forEach((input, i) => {
    if (input.type === "bool") contractInputsValues[input.name] = call.args[i] ? "true" : "false";
  });
  return {
    to: ethers.getAddress(call.to),
    value: "0",
    data,
    contractMethod: { inputs, name: fragment.name, payable: false },
    contractInputsValues,
  };
}

export function safeBatch(chainId, name, description, calls) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.16.5" },
    transactions: calls.map(encodeCall),
  };
}

export function decodeBatch(batch) {
  const lines = [
    `# ${batch.meta.name}`,
    batch.meta.description,
    `chain ${batch.chainId}`,
    "",
  ];
  batch.transactions.forEach((tx, i) => {
    const args = Object.entries(tx.contractInputsValues).map(([k, v]) => `${k}: ${v}`).join(", ");
    lines.push(`${i + 1}. ${tx.to} ${tx.contractMethod.name}(${args})`);
  });
  return lines.join("\n") + "\n";
}

const SIGNING_SLUGS = ["setup", "opening-day", "set-create-signer"];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RECORD_ADDRESS_KEYS = ["swapSim", "factory", "community", "hook", "splitter", "vault", "lock", "launcher", "lens", "escrow", "holder", "airdrop"];
const ROLES_LEFTOVERS = ["mainnet.gen8.payout-roles.json", "mainnet.gen8.roles.safe-batch.json", "mainnet.gen8.roles.txt"];

function capText(plan) {
  const c = plan.chain.caps;
  return `${ethers.formatEther(c.maxBuyPerTx)} / ${ethers.formatEther(c.maxBuybackPerCoinWeek)} / 6 h / 50 bps / ${ethers.formatEther(c.maxHolderBatchPerWeek)}`;
}

function batchSpecs(plan, { rehearsal }) {
  const banner = rehearsal
    ? "FORK REHEARSAL. These addresses belong to the anvil deployer, not the funded keystore. Do not sign."
    : "Unsigned. Built from this chain's mainnet.gen8.json after the deploy. Every address was checked against that record.";
  return {
    setup: {
      name: `Gen-8 setup (${plan.chain.name})`,
      description: `${banner} Creates stay paused. Caps copied from live gen-7: ${capText(plan)}. Vault operator ${VAULT_OPERATOR}. Airdrop operator ${AIRDROP_OPERATOR}.`,
      calls: setupCalls(plan),
    },
    "opening-day": {
      name: `Gen-8 opening day (${plan.chain.name})`,
      description: `${banner} DO NOT SIGN until the founder says go. Opens gen-8 creates and pauses gen-7 creates. Existing gen-7 coins keep trading.`,
      calls: openingCalls(plan),
    },
    "set-create-signer": {
      name: `Gen-8 spare create signer (${plan.chain.name})`,
      description: `${banner} Spare. The argument is the current signer ${CREATE_SIGNER}. Signing it unchanged sets the same signer again. A later rotation is a new batch, encoded on its own. Do not edit this checked file.`,
      calls: signerCalls(plan),
    },
  };
}

export function batchesFromPlan(plan, { rehearsal = false } = {}) {
  const specs = batchSpecs(plan, { rehearsal });
  const out = {};
  for (const slug of SIGNING_SLUGS) {
    const spec = specs[slug];
    out[slug] = safeBatch(plan.chain.id, spec.name, spec.description, spec.calls);
  }
  return out;
}

function removeRolesFiles(dir) {
  for (const name of ROLES_LEFTOVERS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function writeBatchFiles(dir, batches) {
  fs.mkdirSync(dir, { recursive: true });
  removeRolesFiles(dir);
  const written = [];
  for (const slug of SIGNING_SLUGS) {
    const batch = batches[slug];
    const jsonPath = path.join(dir, `mainnet.gen8.${slug}.safe-batch.json`);
    const textPath = path.join(dir, `mainnet.gen8.${slug}.txt`);
    fs.writeFileSync(jsonPath, JSON.stringify(batch, null, 2) + "\n");
    fs.writeFileSync(textPath, decodeBatch(batch));
    written.push(jsonPath, textPath);
  }
  return written;
}

function readBatchFiles(dir) {
  const batches = {};
  for (const slug of SIGNING_SLUGS) {
    batches[slug] = JSON.parse(fs.readFileSync(path.join(dir, `mainnet.gen8.${slug}.safe-batch.json`), "utf8"));
  }
  return batches;
}

/**
 * Fork rehearsal only. Signing files are writeSigningBatches, from the deploy record.
 * There is no Roles file. The Roles module has no code on 56 or 4663.
 */
export function writeBatchSet(dir, plan, { rehearsal = false } = {}) {
  if (!rehearsal) {
    throw new Error("signing batches are written only from deployments/<chain>/mainnet.gen8.json after the real deploy");
  }
  return writeBatchFiles(dir, batchesFromPlan(plan, { rehearsal: true }));
}

function takeAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new Error(`${label} is missing`);
  return ethers.getAddress(value);
}

/**
 * A plan whose addresses come from the deploy record, not from a predicted nonce.
 * Refuses a rehearsal file and any record that is not a paused mainnet deploy.
 */
export function planFromRecord(record) {
  if (!record || typeof record !== "object") throw new Error("deploy record required");
  if (record.rehearsal || record.doNotSign) {
    throw new Error("refusing a rehearsal record; signing batches come from mainnet.gen8.json after the real deploy");
  }
  if (record.kind !== "mainnet-gen8") throw new Error(`record kind ${record.kind} is not mainnet-gen8`);
  if (record.status !== "deployed-create-paused") {
    throw new Error(`record status ${record.status} is not deployed-create-paused`);
  }
  const chain = chainById(record.chainId);
  const deployer = takeAddress(record.deployer, "record.deployer");
  if (deployer === ethers.getAddress(FORBIDDEN_DEPLOYER)) throw new Error("refusing the old deployer");
  if (deployer === ethers.getAddress(SAFE) || deployer === ethers.getAddress(CREATE_SIGNER)) {
    throw new Error("record deployer must not be the Safe or the create signer");
  }
  if (takeAddress(record.admin, "record.admin") !== ethers.getAddress(SAFE)) throw new Error("record admin is not the Safe");
  if (takeAddress(record.createSigner, "record.createSigner") !== ethers.getAddress(CREATE_SIGNER)) {
    throw new Error("record create signer is not the production signer");
  }
  const src = record.addresses;
  if (!src || typeof src !== "object") throw new Error("record has no addresses");
  const addr = {};
  for (const key of RECORD_ADDRESS_KEYS) {
    if (key === "factory" && !chain.displayFactory) {
      const raw = src.factory;
      if (raw == null || raw === "" || takeAddress(raw, "record.addresses.factory") === ethers.ZeroAddress) {
        addr.factory = ethers.ZeroAddress;
        continue;
      }
      throw new Error("Robinhood record must not carry a display factory");
    }
    addr[key] = takeAddress(src[key], `record.addresses.${key}`);
    if (addr[key] === ethers.ZeroAddress) throw new Error(`record.addresses.${key} is the zero address`);
  }
  const seen = new Set();
  for (const key of RECORD_ADDRESS_KEYS) {
    if (addr[key] === ethers.ZeroAddress) continue;
    if (seen.has(addr[key])) throw new Error(`record address ${addr[key]} is used twice (${key})`);
    seen.add(addr[key]);
  }
  return { chain, deployer, addr, fromRecord: true };
}

function allowedBatchAddresses(plan) {
  const allowed = new Set();
  const add = (value) => {
    if (typeof value !== "string" || !ADDRESS_RE.test(value)) return;
    const addr = ethers.getAddress(value);
    if (addr === ethers.ZeroAddress) return;
    allowed.add(addr);
  };
  for (const value of Object.values(plan.addr)) add(value);
  add(plan.chain.gen7Factory);
  add(VAULT_OPERATOR);
  add(AIRDROP_OPERATOR);
  add(CREATE_SIGNER);
  add(SAFE);
  return allowed;
}

/**
 * Re-encodes every signing batch from the deploy record and refuses a difference
 * in chain id, call count, `to`, calldata, or any address argument.
 */
export function postflightBatches(record, batches) {
  const plan = planFromRecord(record);
  const expected = batchesFromPlan(plan, { rehearsal: false });
  const allowed = allowedBatchAddresses(plan);
  if (!batches || typeof batches !== "object") throw new Error("batches required");
  const gotSlugs = Object.keys(batches);
  if (gotSlugs.length !== SIGNING_SLUGS.length || SIGNING_SLUGS.some((slug) => !batches[slug])) {
    throw new Error(`batch set must be exactly ${SIGNING_SLUGS.join(", ")}`);
  }
  for (const slug of SIGNING_SLUGS) {
    const want = expected[slug];
    const got = batches[slug];
    if (String(got.chainId) !== String(want.chainId)) {
      throw new Error(`${slug} chainId ${got.chainId} is not ${want.chainId}`);
    }
    const gtx = got.transactions || [];
    const wtx = want.transactions;
    if (gtx.length !== wtx.length) throw new Error(`${slug} has ${gtx.length} calls, record encodes ${wtx.length}`);
    gtx.forEach((tx, i) => {
      const to = takeAddress(tx.to, `${slug} call ${i + 1} to`);
      if (to !== ethers.getAddress(wtx[i].to)) {
        throw new Error(`${slug} call ${i + 1} to ${to} is not the record address ${wtx[i].to}`);
      }
      if (String(tx.data).toLowerCase() !== String(wtx[i].data).toLowerCase()) {
        throw new Error(`${slug} call ${i + 1} data does not match the record`);
      }
      if (!allowed.has(to)) throw new Error(`${slug} call ${i + 1} to ${to} is not in this chain's deploy record`);
      const gotInputs = tx.contractInputsValues || {};
      const wantInputs = wtx[i].contractInputsValues || {};
      const names = new Set([...Object.keys(gotInputs), ...Object.keys(wantInputs)]);
      for (const name of names) {
        if (gotInputs[name] !== wantInputs[name]) {
          throw new Error(`${slug} call ${i + 1} ${name} differs from the record`);
        }
        const value = gotInputs[name];
        if (typeof value === "string" && ADDRESS_RE.test(value)) {
          const addr = ethers.getAddress(value);
          if (!allowed.has(addr)) throw new Error(`${slug} call ${i + 1} ${name} ${addr} is not in this chain's deploy record`);
        }
      }
    });
  }
  return { ok: true, chainId: plan.chain.id };
}

/** Write the three unsigned signing batches from a real deploy record. No network. No signature. */
export function writeSigningBatches(record, dir) {
  const plan = planFromRecord(record);
  const batches = batchesFromPlan(plan, { rehearsal: false });
  postflightBatches(record, batches);
  const written = writeBatchFiles(dir, batches);
  postflightBatches(record, readBatchFiles(dir));
  return written;
}

async function addrOf(provider, to, fn) {
  const data = ethers.id(`${fn}()`).slice(0, 10);
  const raw = await provider.call({ to, data });
  if (!raw || raw === "0x") return null;
  return ethers.getAddress(ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw)[0]);
}

async function uintOf(provider, to, fn) {
  const data = ethers.id(`${fn}()`).slice(0, 10);
  const raw = await provider.call({ to, data });
  return BigInt(raw);
}

export async function postflight(provider, plan, stage) {
  const { addr, deployer, chain } = plan;
  const problems = [];
  const eq = (label, got, want) => {
    const g = got == null ? null : ethers.getAddress(got);
    const w = ethers.getAddress(want);
    if (g !== w) problems.push(`${label} is ${g}, expected ${w}`);
  };
  eq("launcher.owner", await addrOf(provider, addr.launcher, "owner"), SAFE);
  eq("hook.owner", await addrOf(provider, addr.hook, "owner"), SAFE);
  eq("splitter.admin", await addrOf(provider, addr.splitter, "admin"), SAFE);
  eq("vault.admin", await addrOf(provider, addr.vault, "admin"), SAFE);
  eq("community.admin", await addrOf(provider, addr.community, "admin"), SAFE);
  eq("holder.owner", await addrOf(provider, addr.holder, "owner"), SAFE);
  eq("airdrop.owner", await addrOf(provider, addr.airdrop, "owner"), SAFE);
  eq("launcher.createSigner", await addrOf(provider, addr.launcher, "createSigner"), CREATE_SIGNER);
  eq("launcher.oracle", await addrOf(provider, addr.launcher, "oracle"), chain.oracle);
  eq("launcher.hook", await addrOf(provider, addr.launcher, "hook"), addr.hook);
  eq("hook.launcher", await addrOf(provider, addr.hook, "launcher"), addr.launcher);
  eq("hook.treasuryRouter", await addrOf(provider, addr.hook, "treasuryRouter"), addr.splitter);
  eq("lens.hook", await addrOf(provider, addr.lens, "hook"), addr.hook);
  const paused = await uintOf(provider, addr.launcher, "createPaused");
  if (paused !== 1n) problems.push(`createPaused is ${paused}, expected 1`);
  const roleSlots = [
    ["launcher.owner", await addrOf(provider, addr.launcher, "owner")],
    ["launcher.pendingOwner", await addrOf(provider, addr.launcher, "pendingOwner")],
    ["hook.owner", await addrOf(provider, addr.hook, "owner")],
    ["hook.pendingOwner", await addrOf(provider, addr.hook, "pendingOwner")],
    ["splitter.admin", await addrOf(provider, addr.splitter, "admin")],
    ["splitter.operator", await addrOf(provider, addr.splitter, "operator")],
    ["vault.admin", await addrOf(provider, addr.vault, "admin")],
    ["vault.operator", await addrOf(provider, addr.vault, "operator")],
    ["community.admin", await addrOf(provider, addr.community, "admin")],
    ["community.airdropOperator", await addrOf(provider, addr.community, "airdropOperator")],
    ["holder.owner", await addrOf(provider, addr.holder, "owner")],
    ["holder.batchOperator", await addrOf(provider, addr.holder, "batchOperator")],
    ["airdrop.owner", await addrOf(provider, addr.airdrop, "owner")],
    ["airdrop.batchOperator", await addrOf(provider, addr.airdrop, "batchOperator")],
    ["launcher.createSigner", await addrOf(provider, addr.launcher, "createSigner")],
  ];
  for (const [label, got] of roleSlots) {
    if (got && ethers.getAddress(got) === ethers.getAddress(deployer)) problems.push(`deployer still holds ${label}`);
  }
  if (chain.displayFactory) {
    eq("factory.hook", await addrOf(provider, addr.factory, "hook"), addr.hook);
    const factoryDeployer = await addrOf(provider, addr.factory, "deployer");
    if (ethers.getAddress(factoryDeployer) !== ethers.getAddress(deployer)) {
      problems.push(`factory.deployer is ${factoryDeployer}, expected the deploy key that already called setHook`);
    }
    try {
      await provider.call({ to: addr.factory, from: deployer, data: new ethers.Interface(["function setHook(address)"]).encodeFunctionData("setHook", [addr.hook]) });
      problems.push("factory.setHook did not revert; the one-time deployer slot is still live");
    } catch {
      // HookAlreadySet or NotDeployer. The slot cannot fire again.
    }
  }
  if (stage === "setup") {
    eq("vault.operator", await addrOf(provider, addr.vault, "operator"), VAULT_OPERATOR);
    eq("splitter.operator", await addrOf(provider, addr.splitter, "operator"), VAULT_OPERATOR);
    eq("vault.holderDistributor", await addrOf(provider, addr.vault, "holderDistributor"), addr.holder);
    eq("community.rewardDistributor", await addrOf(provider, addr.community, "rewardDistributor"), addr.airdrop);
    eq("community.airdropOperator", await addrOf(provider, addr.community, "airdropOperator"), AIRDROP_OPERATOR);
    eq("airdrop.batchOperator", await addrOf(provider, addr.airdrop, "batchOperator"), addr.community);
    eq("holder.batchOperator", await addrOf(provider, addr.holder, "batchOperator"), addr.vault);
    const caps = chain.caps;
    const seen = {
      maxBuyPerTx: await uintOf(provider, addr.vault, "maxBuyPerTx"),
      maxBuybackPerCoinWeek: await uintOf(provider, addr.vault, "maxBuybackPerCoinWeek"),
      minBuyInterval: await uintOf(provider, addr.vault, "minBuyInterval"),
      maxImpactBps: await uintOf(provider, addr.vault, "maxImpactBps"),
      maxHolderBatchPerWeek: await uintOf(provider, addr.vault, "maxHolderBatchPerWeek"),
    };
    for (const [k, v] of Object.entries(caps)) {
      if (seen[k] !== v) problems.push(`cap ${k} is ${seen[k]}, expected ${v}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
