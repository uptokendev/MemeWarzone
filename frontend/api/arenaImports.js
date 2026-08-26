import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

import { pool } from "../server/db.js";
import {
  badMethod,
  getQuery,
  isAddress,
  isSolanaAddress,
  isSolanaChain,
  json,
  normalizeWalletFlexible,
  readJson,
} from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
];

function ident(value, chainId) {
  const raw = String(value || "").trim();
  if (isSolanaChain(chainId) || isSolanaAddress(raw)) return raw;
  return isAddress(raw) ? raw.toLowerCase() : "";
}

function rpcUrl(chainId) {
  if (isSolanaChain(chainId)) {
    return process.env.SOLANA_RPC_URL || process.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  }
  if (Number(chainId) === 56) {
    return process.env.BSC_RPC_URL || process.env.VITE_BSC_RPC_URL || "https://bsc-dataseed.binance.org";
  }
  return process.env.BSC_TESTNET_RPC_URL || process.env.VITE_BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
}

function mapImport(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    ownerWallet: String(row.owner_wallet),
    name: row.name || null,
    symbol: row.symbol || null,
    status: String(row.status),
    scan: row.scan_json && typeof row.scan_json === "object" ? row.scan_json : {},
    reviewRequestedAt: row.review_requested_at || null,
    reviewReason: row.review_reason || null,
    reviewer: row.reviewer || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function nativeExists(chainId, token) {
  const result = await pool.query(
    `select campaign_address from public.campaigns
      where chain_id = $1 and (lower(token_address::text) = lower($2) or lower(campaign_address::text) = lower($2))
      limit 1`,
    [chainId, token],
  );
  return Boolean(result.rows[0]);
}

async function scanEvm(chainId, token) {
  const warnings = [];
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
    try {
      const owner = await contract.owner();
      if (owner && owner !== ethers.ZeroAddress) warnings.push("owner_present");
    } catch {
      // no owner() is fine
    }
    if (!symbol && !name) {
      return { status: "needs_review", name, symbol, scan: { ok: false, reasons: ["erc20_metadata_unreadable"], warnings } };
    }
    if (totalSupply === "0") warnings.push("zero_supply");
    return {
      status: warnings.includes("decimals_unreadable") ? "needs_review" : "passed",
      name,
      symbol,
      scan: { ok: true, decimals, totalSupply, warnings, reasons: [] },
    };
  } catch (error) {
    return { status: "needs_review", name: null, symbol: null, scan: { ok: false, reasons: ["rpc_failed"], detail: String(error?.message || error) } };
  }
}

async function scanSolana(token) {
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
    if (info.mintAuthority) warnings.push("mint_authority_present");
    if (info.freezeAuthority) warnings.push("freeze_authority_present");
    const supply = info.supply != null ? String(info.supply) : null;
    const decimals = info.decimals != null ? Number(info.decimals) : null;
    if (decimals == null) {
      return { status: "needs_review", name: null, symbol: null, scan: { ok: false, reasons: ["mint_decimals_unreadable"], warnings } };
    }
    return {
      status: warnings.length ? "needs_review" : "passed",
      name: null,
      symbol: null,
      scan: { ok: true, decimals, totalSupply: supply, warnings, reasons: [] },
    };
  } catch (error) {
    return { status: "needs_review", name: null, symbol: null, scan: { ok: false, reasons: ["solana_rpc_failed"], detail: String(error?.message || error) } };
  }
}

async function scanToken(chainId, token) {
  return isSolanaChain(chainId) ? scanSolana(token) : scanEvm(chainId, token);
}

async function findById(id) {
  const result = await pool.query(`select * from public.arena_token_imports where id = $1::uuid limit 1`, [id]);
  return result.rows[0] || null;
}

async function handleList(req, res) {
  const query = getQuery(req);
  const wallet = normalizeWalletFlexible(query.wallet || query.owner || "");
  const chainId = Number(query.chainId);
  const values = [];
  const where = [];
  if (wallet) {
    values.push(wallet);
    where.push(`lower(owner_wallet) = lower($${values.length})`);
  }
  if (Number.isFinite(chainId) && chainId > 0) {
    values.push(chainId);
    where.push(`chain_id = $${values.length}`);
  }
  const sql = `select * from public.arena_token_imports ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit 100`;
  const result = await pool.query(sql, values);
  return json(res, 200, { items: result.rows.map(mapImport), updatedAt: new Date().toISOString() });
}

async function handleLookup(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId || 56);
  const token = ident(query.token || query.tokenAddress || query.address, chainId);
  if (!token) return json(res, 400, { error: "token is required" });
  const result = await pool.query(
    `select * from public.arena_token_imports where chain_id = $1 and lower(token_address) = lower($2) and status = 'passed' limit 1`,
    [chainId, token],
  );
  const item = mapImport(result.rows[0]);
  return item ? json(res, 200, { item }) : json(res, 404, { error: "Import not found" });
}

async function handleCreate(req, res) {
  const body = await readJson(req);
  const chainId = Number(body.chainId || 56);
  const token = ident(body.tokenAddress || body.tokenId || body.token, chainId);
  const owner = normalizeWalletFlexible(body.walletAddress || body.auth?.walletAddress || body.auth?.address || "");
  if (!token) return json(res, 400, { ok: false, error: "tokenAddress is required" });
  if (!owner) return json(res, 400, { ok: false, error: "wallet is required" });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: owner,
    chainId,
    action: "arena_import_token",
    routeLabel: "arena/imports",
    extraLines: [`Token: ${token}`],
  });
  if (!verified) return;

  if (await nativeExists(chainId, token)) {
    return json(res, 409, { ok: false, error: "This token already launched on MemeWarzone.", reason: "already_native" });
  }

  const existing = await pool.query(
    `select * from public.arena_token_imports where chain_id = $1 and lower(token_address) = lower($2) limit 1`,
    [chainId, token],
  );
  if (existing.rows[0]) {
    return json(res, 200, { ok: true, item: mapImport(existing.rows[0]), existing: true });
  }

  const scan = await scanToken(chainId, token);
  const inserted = await pool.query(
    `insert into public.arena_token_imports (chain_id, token_address, owner_wallet, name, symbol, status, scan_json)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)
     returning *`,
    [chainId, token, owner, scan.name, scan.symbol, scan.status, JSON.stringify(scan.scan || {})],
  );
  return json(res, 200, { ok: true, item: mapImport(inserted.rows[0]) });
}

async function handleRequestReview(req, res, id) {
  const body = await readJson(req);
  const row = await findById(id);
  if (!row) return json(res, 404, { ok: false, error: "Import not found" });
  const owner = normalizeWalletFlexible(row.owner_wallet);
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: owner,
    chainId: Number(row.chain_id),
    action: "arena_import_request_review",
    routeLabel: "arena/imports/request-review",
    extraLines: [`Import: ${id}`],
  });
  if (!verified) return;
  if (row.status !== "declined" && row.status !== "needs_review") {
    return json(res, 409, { ok: false, error: "Only declined or review-needed imports can request manual review." });
  }
  const updated = await pool.query(
    `update public.arena_token_imports
        set review_requested_at = now(), review_reason = coalesce($2, review_reason), updated_at = now()
      where id = $1::uuid
      returning *`,
    [id, String(body.reason || "").trim().slice(0, 500) || null],
  );
  return json(res, 200, { ok: true, item: mapImport(updated.rows[0]) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/imports") return handleList(req, res);
    if (method === "GET" && path === "/arena/imports/lookup") return handleLookup(req, res);
    if (method === "POST" && path === "/arena/imports") return handleCreate(req, res);
    const review = path.match(/^\/arena\/imports\/([^/]+)\/request-review$/);
    if (review) return method === "POST" ? handleRequestReview(req, res, decodeURIComponent(review[1])) : badMethod(res);
    return json(res, 404, { error: `Unknown arena imports route: ${path}` });
  } catch (error) {
    console.error("[api/arenaImports]", error);
    return json(res, 503, { ok: false, error: "Import storage is unavailable", detail: String(error?.message || error) });
  }
}
