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

function env(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function rpcUrl(chainId) {
  if (Number(chainId) === 101 || Number(chainId) === 102) {
    return env("SOLANA_RPC_URL", "VITE_SOLANA_RPC_URL", "VITE_SOLANA_MAINNET_RPC") || "https://api.mainnet-beta.solana.com";
  }
  if (Number(chainId) === 56) {
    return env("BSC_RPC_URL", "VITE_PUBLIC_RPC_56") || "https://bsc-dataseed.binance.org";
  }
  return env("BSC_TESTNET_RPC_URL", "VITE_PUBLIC_RPC_97") || "https://bsc-testnet-rpc.publicnode.com";
}

function topazAddresses(chainId) {
  const id = Number(chainId);
  return {
    factory: env(`TOPAZ_FACTORY_ADDRESS_${id}`, `VITE_TOPAZ_FACTORY_ADDRESS_${id}`, "VITE_TOPAZ_FACTORY_ADDRESS"),
    router: env(`TOPAZ_ROUTER_ADDRESS_${id}`, `VITE_TOPAZ_ROUTER_ADDRESS_${id}`, "VITE_TOPAZ_ROUTER_ADDRESS"),
    wbnb: env(`TOPAZ_WBNB_ADDRESS_${id}`, `VITE_TOPAZ_WBNB_ADDRESS_${id}`, "VITE_TOPAZ_WBNB_ADDRESS"),
  };
}

function decideStatus({ reasons, warnings }) {
  if (reasons.includes("not_a_contract") || reasons.includes("not_a_mint") || reasons.includes("honeypot_sell_failed") || reasons.includes("non_transferable")) {
    return "declined";
  }
  if (reasons.length || warnings.includes("owner_present") || warnings.includes("mint_authority_present") || warnings.includes("freeze_authority_present") || warnings.includes("no_topaz_pool") || warnings.includes("no_meteora_pool") || warnings.includes("transfer_fee")) {
    return "needs_review";
  }
  return "passed";
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
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl(chainId), Number(chainId));
    const code = await provider.getCode(token);
    if (!code || code === "0x") {
      return { status: "declined", name: null, symbol: null, scan: { ok: false, reasons: ["not_a_contract"] } };
    }
    const contract = new ethers.Contract(token, ERC20_ABI, provider);
    let name = null;
    let symbol = null;
    let decimals = null;
    let totalSupply = null;
    try {
      name = String(await contract.name());
    } catch {
      warnings.push("name_unreadable");
    }
    try {
      symbol = String(await contract.symbol());
    } catch {
      warnings.push("symbol_unreadable");
    }
    try {
      decimals = Number(await contract.decimals());
    } catch {
      warnings.push("decimals_unreadable");
    }
    try {
      totalSupply = (await contract.totalSupply()).toString();
    } catch {
      warnings.push("supply_unreadable");
    }
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

    const status = decideStatus({ reasons, warnings });
    return {
      status,
      name,
      symbol,
      scan: {
        ok: status === "passed",
        decimals,
        totalSupply,
        owner,
        pool: pool.pair || null,
        buyQuoteOk: Boolean(pool.buyQuoteOk),
        sellQuoteOk: Boolean(pool.sellQuoteOk),
        warnings,
        reasons,
      },
    };
  } catch (error) {
    return { status: "needs_review", name: null, symbol: null, scan: { ok: false, reasons: ["rpc_failed"], detail: String(error?.message || error) } };
  }
}

export async function scanSolana(token) {
  try {
    const connection = new Connection(rpcUrl(101), "confirmed");
    const pubkey = new PublicKey(token);
    const parsed = await connection.getParsedAccountInfo(pubkey);
    const data = parsed?.value?.data;
    const info = data && typeof data === "object" && "parsed" in data ? data.parsed?.info || {} : null;
    if (!info) {
      return { status: "declined", name: null, symbol: null, scan: { ok: false, reasons: ["not_a_mint"] } };
    }
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
      if (extType.includes("nontransferable") || extType.includes("defaultaccountstate")) {
        reasons.push("non_transferable");
      }
      if (extType.includes("permanentdelegate")) warnings.push("permanent_delegate");
    }
    const supply = info.supply != null ? String(info.supply) : null;
    const decimals = info.decimals != null ? Number(info.decimals) : null;
    if (decimals == null) reasons.push("mint_decimals_unreadable");
    warnings.push("no_meteora_pool");
    const status = decideStatus({ reasons, warnings });
    return {
      status,
      name: null,
      symbol: null,
      scan: {
        ok: status === "passed",
        decimals,
        totalSupply: supply,
        mintAuthority,
        freezeAuthority,
        warnings,
        reasons,
      },
    };
  } catch (error) {
    return { status: "needs_review", name: null, symbol: null, scan: { ok: false, reasons: ["solana_rpc_failed"], detail: String(error?.message || error) } };
  }
}
