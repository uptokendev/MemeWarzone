/**
 * Read-only mainnet preflight for a paused gen-8 deploy. No transactions.
 *
 *   node scripts/gen8/deploy/preflight-gen8-mainnet.mjs
 *   node scripts/gen8/deploy/preflight-gen8-mainnet.mjs --deployer 0xYourFreshAddress
 *
 * The balance check waits for the fresh keystore address. It refuses
 * 0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714.
 */
import { ethers } from "ethers";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
// The old testnet deployer. It is not the mainnet deployer. A fresh keystore is.
const FORBIDDEN_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const SIGNER = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const MAX_ORACLE_AGE = 2 * 24 * 3600;
const deployerArg = process.argv.find((a, i) => process.argv[i - 1] === "--deployer") || "";

const CHAINS = [
  {
    id: 56,
    name: "BNB",
    rpc: "https://bsc-dataseed.bnbchain.org",
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    router: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f",
    routerRuntime: 24380,
    wrapped: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    wrappedSymbol: "WBNB",
    oracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    factory: "0x948463E91d63a7A51cEeC0342735D1B738044aea",
    choiceVault: "0xaD9e687D0a83eb1a49A7C6419c8d44aad34fabE9",
    vaults: {
      weekly: "0xC9286EE3390A4dC642340bd703396E6B7b2521d5",
      monthly: "0x42D254A7451808Bb01df879d71BcAfDC5D605A38",
      recruiter: "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78",
      protocol: "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D",
    },
  },
  {
    id: 4663,
    name: "Robinhood",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    router: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    routerRuntime: 24380,
    routerAlso: "0x8876789976decbfcbbbe364623c63652db8c0904",
    wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    wrappedSymbol: "WETH",
    oracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
    factory: "0x399E529c0C6888543E6501FD137ac49CA3E1Df58",
    choiceVault: "0x0bB4afbCb13489FD178EBb4DCF7CFA060be0A81a",
    vaults: {
      weekly: "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e",
      monthly: "0x576c1d6Ba6975020702Aa13dE0899D8CD92ECD1A",
      recruiter: "0xBd7EB35d62B0AB69B1BB1d756BbDBcC6D31D86C7",
      protocol: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
    },
  },
];

function providerFor(chain) {
  return new ethers.JsonRpcProvider(chain.rpc, chain.id, { staticNetwork: ethers.Network.from(chain.id) });
}

async function codeSize(provider, addr) {
  const code = await provider.getCode(addr);
  return !code || code === "0x" ? 0 : (code.length - 2) / 2;
}

async function one(chain) {
  const provider = providerFor(chain);
  const net = Number((await provider.getNetwork()).chainId);
  const block = await provider.getBlock("latest");
  const out = { chain: chain.name, chainId: net, block: block.number, time: block.timestamp, checks: [] };
  const check = (name, ok, detail) => out.checks.push({ name, ok, detail });
  check("chain id", net === chain.id, String(net));
  const gas = await provider.getFeeData();
  const price = gas.gasPrice ?? 0n;
  const rough = price * 20_000_000n;
  out.gasPriceWei = price.toString();
  out.rough20M = ethers.formatEther(rough);
  if (!deployerArg) {
    check("fresh deployer balance", false, "pass --deployer. Do not fund 0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714");
  } else if (ethers.getAddress(deployerArg) === ethers.getAddress(FORBIDDEN_DEPLOYER)) {
    check("fresh deployer balance", false, "refusing the old deployer");
  } else {
    const bal = await provider.getBalance(deployerArg);
    check("fresh deployer balance covers a 20M gas deploy twice", bal > rough * 2n, `${ethers.getAddress(deployerArg)} holds ${ethers.formatEther(bal)}; 20M gas ~= ${ethers.formatEther(rough)}`);
  }
  check("Safe has code", (await codeSize(provider, SAFE)) > 0, SAFE);
  check("PoolManager has code", (await codeSize(provider, chain.poolManager)) > 1000, chain.poolManager);
  check("V4Quoter has code", (await codeSize(provider, chain.quoter)) > 1000, chain.quoter);
  const routerSize = await codeSize(provider, chain.router);
  check("UniversalRouter runtime", routerSize === chain.routerRuntime, `${chain.router} ${routerSize} bytes`);
  if (chain.routerAlso) {
    const also = await codeSize(provider, chain.routerAlso);
    check("docs-main router also has code", also > 1000, `${chain.routerAlso} ${also} bytes`);
  }
  const wrapped = new ethers.Contract(chain.wrapped, ["function symbol() view returns (string)"], provider);
  let symbol = "";
  try { symbol = await wrapped.symbol(); } catch { symbol = "unreadable"; }
  check("wrapped symbol", symbol === chain.wrappedSymbol, symbol);
  const oracle = new ethers.Contract(chain.oracle, [
    "function maxPriceAge() view returns (uint256)",
    "function nativeUsdPrice() view returns (uint256)",
  ], provider);
  let age = 0n;
  let priceUsd = null;
  let priceErr = null;
  try { age = await oracle.maxPriceAge(); } catch (e) { priceErr = e.shortMessage || e.message; }
  check("oracle age fits launcher 2 day cap", age > 0n && age <= BigInt(MAX_ORACLE_AGE), priceErr || `${age} seconds`);
  try { priceUsd = ethers.formatEther(await oracle.nativeUsdPrice()); } catch (e) { priceErr = e.shortMessage || e.message; }
  check("oracle price reads", priceUsd != null, priceErr || priceUsd);
  const factory = new ethers.Contract(chain.factory, ["function createPaused() view returns (bool)", "function owner() view returns (address)"], provider);
  let paused = null;
  let owner = null;
  try { paused = await factory.createPaused(); owner = await factory.owner(); } catch (e) { paused = e.shortMessage || e.message; }
  check("gen-7 factory readable", typeof paused === "boolean", `createPaused=${paused} owner=${owner}`);
  const vault = new ethers.Contract(chain.choiceVault, [
    "function limits() view returns (bool paused, uint256 buyPerTx, uint256 buybackPerCampaignWeek, uint256 buyInterval, uint256 impactBps, uint256 holderBatchPerWeek)",
  ], provider);
  try {
    const lim = await vault.limits();
    out.caps = {
      operatorPaused: Boolean(lim.paused),
      maxBuyPerTx: lim.buyPerTx.toString(),
      maxBuybackPerCampaignWeek: lim.buybackPerCampaignWeek.toString(),
      minBuyInterval: lim.buyInterval.toString(),
      maxImpactBps: lim.impactBps.toString(),
      maxHolderBatchPerWeek: lim.holderBatchPerWeek.toString(),
    };
    check("gen-7 choice vault caps", true, "read");
  } catch (e) {
    check("gen-7 choice vault caps", false, e.shortMessage || e.message);
  }
  for (const [label, addr] of Object.entries(chain.vaults)) {
    const size = await codeSize(provider, addr);
    let accepts = false;
    let why = "";
    try {
      await provider.call({ to: addr, from: SAFE, value: 1n });
      accepts = true;
    } catch (e) {
      why = e.shortMessage || e.message;
    }
    check(`${label} vault accepts native`, size > 0 && accepts, accepts ? addr : `${addr} ${why}`);
  }
  out.signer = SIGNER;
  return out;
}

const rows = [];
for (const chain of CHAINS) rows.push(await one(chain));
console.log(JSON.stringify(rows, null, 2));
const failed = rows.flatMap((row) => row.checks.filter((item) => !item.ok).map((item) => `${row.chain}: ${item.name}`));
if (failed.length) {
  console.error(`[gen8-preflight] ${failed.length} check(s) failed: ${failed.join("; ")}`);
  process.exit(1);
}
