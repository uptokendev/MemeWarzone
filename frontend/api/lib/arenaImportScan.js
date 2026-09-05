import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function paused() view returns (bool)",
];
const FACTORY_ABI = ["function getPool(address tokenA,address tokenB,bool stable) view returns (address pool)"];
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
];

const ZERO = ethers.ZeroAddress;

export const ARENA_IMPORT_SCAN_VERSION = "arena-import-scan-v2";
export const FINDING_AUTHORITY = Object.freeze({
  REVIEWABLE: "REVIEWABLE",
  NON_OVERRIDABLE: "NON_OVERRIDABLE",
});
export const IMPORT_SCAN_STATUS = Object.freeze({
  PASSED: "passed",
  NEEDS_REVIEW: "needs_review",
  HARD_FAILURE: "declined",
  STALE: "stale",
});

const NON_OVERRIDABLE_CODES = new Set([
  "not_a_contract",
  "not_a_mint",
  "honeypot_sell_failed",
  "non_transferable",
  "paused",
  "transfer_tax_too_high",
  "unsupported_chain",
]);

function env(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function importScannerChainFamily(chainId) {
  const id = Number(chainId);
  if (id === 56 || id === 97) return "evm";
  if (id === 101 || id === 102) return "solana";
  return null;
}

function rpcUrl(chainId) {
  const id = Number(chainId);
  if (id === 101) {
    return env("SOLANA_RPC_URL", "VITE_SOLANA_RPC_URL", "VITE_SOLANA_MAINNET_RPC") || "https://api.mainnet-beta.solana.com";
  }
  if (id === 102) {
    return env("SOLANA_DEVNET_RPC_URL", "VITE_SOLANA_DEVNET_RPC_URL") || "https://api.devnet.solana.com";
  }
  if (id === 56) {
    return env("BSC_RPC_URL", "VITE_PUBLIC_RPC_56") || "https://bsc-dataseed.binance.org";
  }
  if (id === 97) {
    return env("BSC_TESTNET_RPC_URL", "VITE_PUBLIC_RPC_97") || "https://bsc-testnet-rpc.publicnode.com";
  }
  return "";
}

function topazAddresses(chainId) {
  const id = Number(chainId);
  return {
    factory: env(`TOPAZ_FACTORY_ADDRESS_${id}`, `VITE_TOPAZ_FACTORY_ADDRESS_${id}`, "VITE_TOPAZ_FACTORY_ADDRESS"),
    router: env(`TOPAZ_ROUTER_ADDRESS_${id}`, `VITE_TOPAZ_ROUTER_ADDRESS_${id}`, "VITE_TOPAZ_ROUTER_ADDRESS"),
    wbnb: env(`TOPAZ_WBNB_ADDRESS_${id}`, `VITE_TOPAZ_WBNB_ADDRESS_${id}`, "VITE_TOPAZ_WBNB_ADDRESS"),
  };
}

export function classifyFinding(code, detail = null) {
  const normalized = String(code || "").trim();
  return {
    code: normalized,
    authority: NON_OVERRIDABLE_CODES.has(normalized)
      ? FINDING_AUTHORITY.NON_OVERRIDABLE
      : FINDING_AUTHORITY.REVIEWABLE,
    ...(detail ? { detail } : {}),
  };
}

export function classifyScan({ reasons = [], warnings = [] } = {}) {
  const findings = [...new Set(reasons)].map((code) => classifyFinding(code));
  const hardFindings = findings.filter((finding) => finding.authority === FINDING_AUTHORITY.NON_OVERRIDABLE);
  const reviewableFindings = findings.filter((finding) => finding.authority === FINDING_AUTHORITY.REVIEWABLE);
  const reviewWarnings = new Set([
    "owner_present",
    "mint_authority_present",
    "freeze_authority_present",
    "no_topaz_pool",
    "transfer_fee",
    "permanent_delegate",
    // A probe that did not run or did not produce a trustworthy trade result is
    // uncertainty, never evidence that an external EVM token is safe.
    "topaz_env_missing",
    "getPool_failed",
    "topaz_buy_quote_failed",
    "supply_unreadable",
    "zero_supply",
  ]);
  if (hardFindings.length) {
    return { status: IMPORT_SCAN_STATUS.HARD_FAILURE, findings, hardFindings, reviewableFindings };
  }
  if (reviewableFindings.length || warnings.some((warning) => reviewWarnings.has(warning))) {
    return { status: IMPORT_SCAN_STATUS.NEEDS_REVIEW, findings, hardFindings, reviewableFindings };
  }
  return { status: IMPORT_SCAN_STATUS.PASSED, findings, hardFindings, reviewableFindings };
}

function finalizeScan({ name = null, symbol = null, scan = {}, scannedAt = new Date().toISOString() }) {
  const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  const reasons = Array.isArray(scan.reasons) ? scan.reasons : [];
  const classification = classifyScan({ reasons, warnings });
  return {
    status: classification.status,
    name,
    symbol,
    scanVersion: ARENA_IMPORT_SCAN_VERSION,
    scannedAt,
    scan: {
      ...scan,
      ok: classification.status === IMPORT_SCAN_STATUS.PASSED,
      warnings,
      reasons,
      findings: classification.findings,
      hardFindings: classification.hardFindings,
      reviewableFindings: classification.reviewableFindings,
      scanVersion: ARENA_IMPORT_SCAN_VERSION,
      scannedAt,
    },
  };
}

async function probeOwner(contract) {
  for (const method of ["owner", "getOwner"]) {
    try {
      const owner = await contract[method]();
      if (owner && owner !== ZERO) return owner;
    } catch {
      // optional
    }
  }
  return null;
}

async function probeTopaz(provider, chainId, token) {
  const addrs = topazAddresses(chainId);
  if (!ethers.isAddress(addrs.factory) || !ethers.isAddress(addrs.wbnb) || !ethers.isAddress(addrs.router)) {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "topaz_env_missing" };
  }
  const factory = new ethers.Contract(addrs.factory, FACTORY_ABI, provider);
  let pair = ZERO;
  try {
    pair = await factory.getPool(token, addrs.wbnb, false);
  } catch {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "getPool_failed" };
  }
  if (!pair || pair === ZERO) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  const router = new ethers.Contract(addrs.router, ROUTER_ABI, provider);
  const buyRoute = [{ from: addrs.wbnb, to: token, stable: false, factory: addrs.factory }];
  const sellRoute = [{ from: token, to: addrs.wbnb, stable: false, factory: addrs.factory }];
  let buyQuoteOk = false;
  let sellQuoteOk = false;
  try {
    const amounts = await router.getAmountsOut(ethers.parseEther("0.01"), buyRoute);
    buyQuoteOk = BigInt(amounts?.[amounts.length - 1] ?? 0) > 0n;
  } catch {
    buyQuoteOk = false;
  }
  try {
    const amounts = await router.getAmountsOut(10n ** 15n, sellRoute);
    sellQuoteOk = BigInt(amounts?.[amounts.length - 1] ?? 0) > 0n;
  } catch {
    sellQuoteOk = false;
  }
  return { pair, buyQuoteOk, sellQuoteOk, factory: addrs.factory, router: addrs.router, wbnb: addrs.wbnb };
}

export async function scanEvm(chainId, token) {
  const warnings = [];
  const reasons = [];
  if (importScannerChainFamily(chainId) !== "evm") {
    return finalizeScan({ scan: { reasons: ["unsupported_chain"], warnings } });
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl(chainId), Number(chainId));
    const code = await provider.getCode(token);
    if (!code || code === "0x") {
      return finalizeScan({ scan: { reasons: ["not_a_contract"], warnings } });
    }
    const contract = new ethers.Contract(token, ERC20_ABI, provider);
    let name = null;
    let symbol = null;
    let decimals = null;
    let totalSupply = null;
    try { name = String(await contract.name()); } catch { warnings.push("name_unreadable"); }
    try { symbol = String(await contract.symbol()); } catch { warnings.push("symbol_unreadable"); }
    try { decimals = Number(await contract.decimals()); } catch { warnings.push("decimals_unreadable"); }
    try { totalSupply = (await contract.totalSupply()).toString(); } catch { warnings.push("supply_unreadable"); }
    const owner = await probeOwner(contract);
    if (owner) warnings.push("owner_present");
    try {
      if (await contract.paused()) {
        reasons.push("paused");
        warnings.push("paused");
      }
    } catch {
      // no paused()
    }
    if (!symbol && !name) reasons.push("erc20_metadata_unreadable");
    if (totalSupply === "0") warnings.push("zero_supply");
    if (warnings.includes("decimals_unreadable")) reasons.push("decimals_unreadable");

    const pool = await probeTopaz(provider, chainId, token);
    if (pool.skipped) warnings.push(pool.skipped);
    else if (!pool.pair) warnings.push("no_topaz_pool");
    else {
      pool.pair = String(pool.pair);
      if (pool.buyQuoteOk && !pool.sellQuoteOk) reasons.push("honeypot_sell_failed");
      if (!pool.buyQuoteOk) warnings.push("topaz_buy_quote_failed");
    }

    return finalizeScan({
      name,
      symbol,
      scan: {
        decimals,
        totalSupply,
        owner,
        pool: pool.pair || null,
        buyQuoteOk: Boolean(pool.buyQuoteOk),
        sellQuoteOk: Boolean(pool.sellQuoteOk),
        warnings,
        reasons,
      },
    });
  } catch (error) {
    return finalizeScan({ scan: { reasons: ["rpc_failed"], warnings, detail: String(error?.message || error) } });
  }
}

export async function scanSolana(chainId, token) {
  if (importScannerChainFamily(chainId) !== "solana") {
    return finalizeScan({ scan: { reasons: ["unsupported_chain"], warnings: [] } });
  }
  try {
    const connection = new Connection(rpcUrl(chainId), "confirmed");
    const pubkey = new PublicKey(token);
    const parsed = await connection.getParsedAccountInfo(pubkey);
    const data = parsed?.value?.data;
    const info = data && typeof data === "object" && "parsed" in data ? data.parsed?.info || {} : null;
    if (!info) return finalizeScan({ scan: { reasons: ["not_a_mint"], warnings: [] } });

    const warnings = [];
    const reasons = [];
    const mintAuthority = info.mintAuthority ? String(info.mintAuthority) : null;
    const freezeAuthority = info.freezeAuthority ? String(info.freezeAuthority) : null;
    if (mintAuthority) warnings.push("mint_authority_present");
    if (freezeAuthority) warnings.push("freeze_authority_present");
    const extensions = Array.isArray(info.extensions) ? info.extensions : [];
    for (const ext of extensions) {
      const extType = String(ext?.extension || ext?.type || "").toLowerCase();
      if (extType.includes("transferfee")) {
        warnings.push("transfer_fee");
        const bps = Number(ext?.state?.newerTransferFee?.transferFeeBasisPoints ?? ext?.state?.transferFeeBasisPoints ?? 0);
        if (bps > 1000) reasons.push("transfer_tax_too_high");
      }
      if (extType.includes("nontransferable") || extType.includes("defaultaccountstate")) reasons.push("non_transferable");
      if (extType.includes("permanentdelegate")) warnings.push("permanent_delegate");
    }
    const supply = info.supply != null ? String(info.supply) : null;
    const decimals = info.decimals != null ? Number(info.decimals) : null;
    if (decimals == null) reasons.push("mint_decimals_unreadable");

    // External Arena imports are not required to have graduated through MemeWarzone
    // or to have a Meteora graduation pool. Pool provenance is intentionally not an
    // eligibility finding; genuine mint/token safety findings above remain authoritative.
    return finalizeScan({
      scan: {
        decimals,
        totalSupply: supply,
        mintAuthority,
        freezeAuthority,
        warnings,
        reasons,
        poolProvenance: "external_not_required",
      },
    });
  } catch (error) {
    return finalizeScan({ scan: { reasons: ["solana_rpc_failed"], warnings: [], detail: String(error?.message || error) } });
  }
}