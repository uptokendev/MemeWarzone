import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, isAddress, json } from "../server/http.js";
import { MonthlyLeagueTreasuryConfigError, monthlyLeagueTreasuryForMonth } from "./lib/evmMonthlyLeagueTreasury.js";

const MONTHLY_TREASURY_ABI = [
  "function monthSeal(uint256 monthId) view returns (bool isSealed, bytes32 winnersRoot, uint256 oraclePrice, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow, uint256 sealedAt)",
  "function monthClaimedTotal(uint256 monthId) view returns (uint256)",
  "function monthOutstandingClaims(uint256 monthId) view returns (uint256)",
  "function monthLeafClaimed(uint256 monthId, bytes32 leaf) view returns (bool)",
  "function totalOutstandingClaims() view returns (uint256)",
  "function unallocatedBalance() view returns (uint256)",
  "function claim(uint256 monthId, bytes32 category, uint8 rank, address recipient, uint256 amount, bytes32[] proof)",
];

const treasuryInterface = new ethers.Interface(MONTHLY_TREASURY_ABI);

// GET /api/league/month/:monthId?chainId=56
// GET /api/league/month/:monthId/claimable/:wallet?chainId=56
export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    const route = parseRoute(req);
    if (!route) return json(res, 404, { error: "Unknown monthly league route" });

    const chainId = readChainId(req);
    if (!Number.isInteger(chainId) || chainId <= 0) return json(res, 400, { error: "Invalid chainId" });

    const monthId = parseMonthId(route.monthId);
    if (!monthId) return json(res, 400, { error: "monthId must use YYYYMM format" });

    if (route.wallet && !isAddress(route.wallet)) {
      return json(res, 400, { error: "Invalid wallet" });
    }

    const rpc = chainScopedEnv("BSC_RPC_HTTP", chainId);
    if (!rpc) return json(res, 500, { error: "Server misconfigured: missing RPC url" });

    const network = ethers.Network.from(Number(chainId));
    const provider = new ethers.JsonRpcProvider(rpc, network, {
      staticNetwork: network,
      batchMaxCount: 1,
      batchStallTime: 0,
    });

    // lib/evmMonthlyLeagueTreasury.js: the current vault, or a superseded one only if this month was
    // sealed there. A missing, superseded or non-canonical config fails closed (no claim transaction).
    let contractAddress;
    try {
      contractAddress = await monthlyLeagueTreasuryForMonth(provider, chainId, monthId);
    } catch (error) {
      if (error instanceof MonthlyLeagueTreasuryConfigError) {
        console.error("[api/monthlyLeagueTreasury] misconfigured", { chainId, code: error.code, message: error.message });
        return json(res, 500, { error: "Server misconfigured: bad MonthlyLeagueTreasury address", code: error.code });
      }
      throw error;
    }
    if (!isAddress(contractAddress)) {
      return json(res, 500, { error: "Server misconfigured: bad MonthlyLeagueTreasury address" });
    }

    const epochStart = epochStartFromMonthId(monthId);
    const winners = await loadWinners(chainId, epochStart);
    const tree = buildWinnerTree(monthId, winners);

    const treasury = new ethers.Contract(contractAddress, MONTHLY_TREASURY_ABI, provider);
    const [seal, claimedTotal, outstandingClaims, totalOutstandingClaims, unallocatedBalance] = await Promise.all([
      treasury.monthSeal(monthId),
      treasury.monthClaimedTotal(monthId),
      treasury.monthOutstandingClaims(monthId),
      treasury.totalOutstandingClaims(),
      treasury.unallocatedBalance(),
    ]);

    const state = serializeState({
      chainId,
      monthId,
      epochStart,
      contractAddress,
      seal,
      claimedTotal,
      outstandingClaims,
      totalOutstandingClaims,
      unallocatedBalance,
      databaseRoot: tree.root,
      databaseWinnerTotal: tree.winnerTotal,
      databaseWinnerCount: winners.length,
    });

    if (!route.wallet) return json(res, 200, { ok: true, ...state });

    const wallet = route.wallet.toLowerCase();
    const rewards = [];
    for (let index = 0; index < winners.length; index += 1) {
      const winner = winners[index];
      if (winner.recipient !== wallet) continue;

      const proof = buildMerkleProof(tree.leaves, index);
      const claimed = await treasury.monthLeafClaimed(monthId, tree.leaves[index]);
      const args = [monthId, winner.categoryHash, winner.rank, winner.recipient, winner.amountRaw, proof];

      rewards.push({
        category: winner.category,
        categoryHash: winner.categoryHash,
        rank: winner.rank,
        recipient: winner.recipient,
        amountRaw: winner.amountRaw.toString(),
        leaf: tree.leaves[index],
        proof,
        claimed,
        claimable: Boolean(seal.isSealed) && !claimed && seal.winnersRoot.toLowerCase() === tree.root.toLowerCase(),
        transaction: {
          to: contractAddress,
          value: "0",
          data: treasuryInterface.encodeFunctionData("claim", args),
          functionName: "claim",
          args: {
            monthId: monthId.toString(),
            category: winner.categoryHash,
            rank: winner.rank,
            recipient: winner.recipient,
            amount: winner.amountRaw.toString(),
            proof,
          },
        },
      });
    }

    return json(res, 200, {
      ok: true,
      ...state,
      wallet,
      eligible: rewards.length > 0,
      claimableCount: rewards.filter((reward) => reward.claimable).length,
      claimableAmountRaw: rewards
        .filter((reward) => reward.claimable)
        .reduce((sum, reward) => sum + BigInt(reward.amountRaw), 0n)
        .toString(),
      rewards,
    });
  } catch (error) {
    console.error("[api/monthlyLeagueTreasury]", error);
    return json(res, 500, { error: "Server error" });
  }
}

function parseRoute(req) {
  const path = String(req.path || new URL(req.originalUrl || req.url || "", "http://localhost").pathname)
    .replace(/^\/api/, "")
    .replace(/\/+$/, "");
  const match = path.match(/^\/league\/month\/(\d{6})(?:\/claimable\/(0x[a-fA-F0-9]{40}))?$/);
  if (!match) return null;
  return { monthId: match[1], wallet: match[2] || null };
}

function readChainId(req) {
  const url = new URL(req.originalUrl || req.url || "", "http://localhost");
  return Number(url.searchParams.get("chainId") || 56);
}

function parseMonthId(value) {
  if (!/^\d{6}$/.test(String(value))) return null;
  const n = Number(value);
  const year = Math.trunc(n / 100);
  const month = n % 100;
  if (year < 2000 || year > 9999 || month < 1 || month > 12) return null;
  return BigInt(n);
}

function epochStartFromMonthId(monthId) {
  const n = Number(monthId);
  const year = Math.trunc(n / 100);
  const month = n % 100;
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)).toISOString();
}

function chainScopedEnv(prefix, chainId) {
  return String(process.env[`${prefix}_${chainId}`] || process.env[prefix] || "").trim();
}

async function loadWinners(chainId, epochStart) {
  const { rows } = await pool.query(
    `SELECT category, rank, recipient_address AS "recipientAddress", amount_raw AS "amountRaw"
       FROM public.league_epoch_winners
      WHERE chain_id = $1 AND period = 'monthly' AND epoch_start = $2::timestamptz
      ORDER BY category ASC, rank ASC, recipient_address ASC`,
    [chainId, epochStart]
  );

  return rows.map((row) => {
    const category = String(row.category || "").toLowerCase().trim();
    const rank = Number(row.rank);
    const recipient = String(row.recipientAddress || "").toLowerCase();
    const amountRaw = BigInt(String(row.amountRaw));

    if (!category) throw new Error("Winner category missing");
    if (!Number.isInteger(rank) || rank < 0 || rank > 255) throw new Error("Winner rank outside uint8 range");
    if (!isAddress(recipient)) throw new Error("Winner recipient is invalid");
    if (amountRaw <= 0n) throw new Error("Winner amount must be positive");

    return {
      category,
      categoryHash: ethers.keccak256(ethers.toUtf8Bytes(category)),
      rank,
      recipient,
      amountRaw,
    };
  });
}

function buildWinnerTree(monthId, winners) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const leaves = winners.map((winner) => ethers.keccak256(coder.encode(
    ["uint256", "bytes32", "uint8", "address", "uint256"],
    [monthId, winner.categoryHash, winner.rank, winner.recipient, winner.amountRaw]
  )));

  return {
    leaves,
    root: buildMerkleRoot(leaves),
    winnerTotal: winners.reduce((sum, winner) => sum + winner.amountRaw, 0n),
  };
}

function hashPair(a, b) {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

function buildMerkleRoot(leaves) {
  if (!leaves.length) return ethers.ZeroHash;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) {
      next.push(hashPair(layer[index], layer[index + 1] || layer[index]));
    }
    layer = next;
  }
  return layer[0];
}

function buildMerkleProof(leaves, leafIndex) {
  if (!leaves.length) return [];
  let index = leafIndex;
  let layer = leaves.slice();
  const proof = [];

  while (layer.length > 1) {
    const siblingIndex = index % 2 === 1 ? index - 1 : index + 1;
    proof.push(layer[siblingIndex] || layer[index]);

    const next = [];
    for (let cursor = 0; cursor < layer.length; cursor += 2) {
      next.push(hashPair(layer[cursor], layer[cursor + 1] || layer[cursor]));
    }
    layer = next;
    index = Math.floor(index / 2);
  }

  return proof;
}

function serializeState({
  chainId,
  monthId,
  epochStart,
  contractAddress,
  seal,
  claimedTotal,
  outstandingClaims,
  totalOutstandingClaims,
  unallocatedBalance,
  databaseRoot,
  databaseWinnerTotal,
  databaseWinnerCount,
}) {
  const isSealed = Boolean(seal.isSealed);
  const onchainRoot = seal.winnersRoot;
  const rootMatches = isSealed && onchainRoot.toLowerCase() === databaseRoot.toLowerCase();
  const totalMatches = isSealed && BigInt(seal.winnerTotal) === databaseWinnerTotal;

  return {
    chainId,
    period: "monthly",
    monthId: monthId.toString(),
    epochStart,
    contractAddress,
    status: isSealed ? "sealed" : "pending",
    isSealed,
    winnersRoot: onchainRoot,
    oraclePriceRaw: seal.oraclePrice.toString(),
    capUsdRaw: seal.capUsd.toString(),
    capNativeRaw: seal.capNative.toString(),
    playerPoolRaw: seal.playerPool.toString(),
    winnerTotalRaw: seal.winnerTotal.toString(),
    overflowRaw: seal.overflow.toString(),
    sealedAt: seal.sealedAt > 0n ? new Date(Number(seal.sealedAt) * 1000).toISOString() : null,
    claimedTotalRaw: claimedTotal.toString(),
    outstandingClaimsRaw: outstandingClaims.toString(),
    totalOutstandingClaimsRaw: totalOutstandingClaims.toString(),
    unallocatedBalanceRaw: unallocatedBalance.toString(),
    database: {
      winnersRoot: databaseRoot,
      winnerTotalRaw: databaseWinnerTotal.toString(),
      winnerCount: databaseWinnerCount,
    },
    reconciliation: {
      rootMatches,
      winnerTotalMatches: totalMatches,
      readyForClaims: isSealed && rootMatches && totalMatches,
    },
  };
}
