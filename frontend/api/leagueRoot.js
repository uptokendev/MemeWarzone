import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, isAddress, json, readJson } from "../server/http.js";

// POST /api/leagueRoot
// Admin-only helper to publish a weekly epoch root or seal a monthly league root.
//
// Body:
// {
//   chainId: 56|97,
//   period: "weekly"|"monthly",
//   epochStart: "<ISO>"
// }
//
// Headers:
// - x-admin-key: must equal process.env.ADMIN_API_KEY
export default async function handler(req, res) {
  if (req.method !== "POST") return badMethod(res);

  try {
    const adminKey = String(req.headers["x-admin-key"] ?? "");
    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return json(res, 401, { error: "Unauthorized" });
    }

    const b = await readJson(req);
    const chainId = Number(b.chainId);
    const period = String(b.period ?? "").toLowerCase().trim();
    const epochStart = String(b.epochStart ?? "").trim();

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!(period === "weekly" || period === "monthly")) return json(res, 400, { error: "Invalid period" });
    if (!epochStart) return json(res, 400, { error: "epochStart missing" });
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    const epochDate = new Date(epochStart);
    if (Number.isNaN(epochDate.getTime())) return json(res, 400, { error: "Invalid epochStart" });

    const rpc = rpcForChain(chainId);
    if (!rpc) return json(res, 500, { error: "Server misconfigured: missing RPC url" });

    const pk = process.env.LEAGUE_ROOT_POSTER_PK;
    if (!pk) return json(res, 500, { error: "Server misconfigured: missing LEAGUE_ROOT_POSTER_PK" });

    const claimId = period === "monthly"
      ? monthIdFromDate(epochDate)
      : computeEpochId(chainId, period, Math.floor(epochDate.getTime() / 1000));

    // Load all winners for the period and compute the exact leaves expected by
    // TreasuryVaultV2 (weekly) or MonthlyLeagueTreasury (monthly).
    const { rows } = await pool.query(
      `SELECT category, rank, recipient_address AS "recipientAddress", amount_raw AS "amountRaw"
         FROM league_epoch_winners
        WHERE chain_id = $1 AND period = $2 AND epoch_start = $3::timestamptz
        ORDER BY category ASC, rank ASC, recipient_address ASC`,
      [chainId, period, epochStart]
    );

    if (!rows?.length) return json(res, 404, { error: "No winners for epoch" });

    const leaves = [];
    let winnerTotal = 0n;
    for (const r of rows) {
      const category = String(r.category || "").toLowerCase().trim();
      const rank = Number(r.rank);
      const recipient = String(r.recipientAddress || "").toLowerCase();
      const amount = BigInt(String(r.amountRaw));

      if (!category) return json(res, 400, { error: "Winner category missing" });
      if (!Number.isInteger(rank) || rank < 0 || rank > 255) return json(res, 400, { error: "Winner rank outside uint8 range" });
      if (!isAddress(recipient)) return json(res, 400, { error: "Winner recipient is invalid" });
      if (amount <= 0n) return json(res, 400, { error: "Winner amount must be positive" });

      winnerTotal += amount;
      leaves.push(
        leafHash({
          claimId,
          categoryHash: categoryHashFromString(category),
          rank,
          recipient,
          amountRaw: amount,
        })
      );
    }

    const root = buildMerkleRoot(leaves);
    const network = ethers.Network.from(Number(chainId));
    const provider = new ethers.JsonRpcProvider(rpc, network, {
      staticNetwork: network,
      batchMaxCount: 1,
      batchStallTime: 0,
    });
    const wallet = new ethers.Wallet(pk, provider);

    if (period === "monthly") {
      return publishMonthlyRoot({ res, chainId, claimId, root, winnerTotal, wallet });
    }

    return publishWeeklyRoot({ res, chainId, claimId, root, winnerTotal, wallet });
  } catch (e) {
    console.error("[api/leagueRoot]", e);
    return json(res, 500, { error: "Server error" });
  }
}

async function publishWeeklyRoot({ res, chainId, claimId, root, winnerTotal, wallet }) {
  const vaultAddress = chainScopedEnv("TREASURY_VAULT_V2_ADDRESS", chainId);
  if (!isAddress(vaultAddress)) {
    return json(res, 500, { error: "Server misconfigured: bad TreasuryVaultV2 address" });
  }

  const abi = ["function setEpochRoot(uint256 epochId, bytes32 root, uint256 epochTotal) external"];
  const vault = new ethers.Contract(vaultAddress, abi, wallet);
  const tx = await vault.setEpochRoot(claimId, root, winnerTotal);

  return json(res, 200, {
    ok: true,
    chainId,
    period: "weekly",
    epochId: claimId.toString(),
    root,
    winnerTotal: winnerTotal.toString(),
    txHash: tx.hash,
    contractAddress: vaultAddress,
  });
}

async function publishMonthlyRoot({ res, chainId, claimId, root, winnerTotal, wallet }) {
  const treasuryAddress = chainScopedEnv("MONTHLY_LEAGUE_TREASURY_ADDRESS", chainId);
  if (!isAddress(treasuryAddress)) {
    return json(res, 500, { error: "Server misconfigured: bad MonthlyLeagueTreasury address" });
  }

  const abi = [
    "function sealMonth(uint256 monthId, bytes32 winnersRoot, uint256 winnerTotal) external",
    "function monthSeal(uint256 monthId) view returns (bool isSealed, bytes32 winnersRoot, uint256 oraclePrice, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow, uint256 sealedAt)",
  ];
  const treasury = new ethers.Contract(treasuryAddress, abi, wallet);
  const existing = await treasury.monthSeal(claimId);

  if (existing.isSealed) {
    return json(res, 409, {
      error: "Month already sealed",
      chainId,
      period: "monthly",
      monthId: claimId.toString(),
      root: existing.winnersRoot,
      contractAddress: treasuryAddress,
    });
  }

  const tx = await treasury.sealMonth(claimId, root, winnerTotal);

  return json(res, 200, {
    ok: true,
    chainId,
    period: "monthly",
    monthId: claimId.toString(),
    root,
    winnerTotal: winnerTotal.toString(),
    txHash: tx.hash,
    contractAddress: treasuryAddress,
  });
}

function chainScopedEnv(prefix, chainId) {
  return String(process.env[`${prefix}_${chainId}`] || process.env[prefix] || "").trim();
}

function rpcForChain(chainId) {
  return chainScopedEnv("BSC_RPC_HTTP", chainId);
}

export function monthIdFromDate(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return BigInt(year * 100 + month);
}

function periodCode(period) {
  return period === "weekly" ? 1 : 2;
}

export function computeEpochId(chainId, period, epochStartSec) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const enc = coder.encode(["uint32", "uint8", "uint64"], [chainId, periodCode(period), BigInt(epochStartSec)]);
  const h = ethers.keccak256(enc);
  return BigInt(h);
}

export function categoryHashFromString(category) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(category)));
}

export function leafHash({ claimId, categoryHash, rank, recipient, amountRaw }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const enc = coder.encode(
    ["uint256", "bytes32", "uint8", "address", "uint256"],
    [claimId, categoryHash, rank, recipient, BigInt(amountRaw)]
  );
  return ethers.keccak256(enc);
}

function hashPair(a, b) {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  const [x, y] = aa <= bb ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

export function buildMerkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) return ethers.ZeroHash;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return layer[0];
}
