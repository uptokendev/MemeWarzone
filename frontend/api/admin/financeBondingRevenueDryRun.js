import { pool } from "../../server/db.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";
import { dryRunBnbBondingProtocolRevenueBackfill } from "../lib/financeBondingRevenueBackfillDryRun.js";

function requiredQuery(req, name) {
  const value = String(req.query?.[name] ?? "").trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function positiveLimit(value) {
  if (value == null || String(value).trim() === "") return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("limit must be numeric");
  return Math.max(1, Math.min(500, Math.trunc(parsed) || 100));
}

export function buildFinanceBondingRevenueDryRunOptions(req = {}) {
  const chainId = Number(req.query?.chainId);
  if (chainId !== 56 && chainId !== 97) {
    throw new TypeError("chainId must be BNB 56 or BSC Testnet 97");
  }

  return {
    chainId,
    networkKey: requiredQuery(req, "networkKey"),
    deploymentGeneration: requiredQuery(req, "deploymentGeneration"),
    expectedSourceContract: requiredQuery(req, "sourceContract"),
    decoderVersion: requiredQuery(req, "decoderVersion"),
    policyVersion: requiredQuery(req, "policyVersion"),
    finalizedAt: requiredQuery(req, "finalizedAt"),
    limit: positiveLimit(req.query?.limit),
  };
}

export default async function financeBondingRevenueDryRun(req, res) {
  const auth = await requireAdminOrOps(req, res, {
    routeLabel: "admin/finance/bonding-revenue-dry-run",
    allowOps: true,
  });
  if (!auth) return;

  if (String(req.method || "GET").toUpperCase() !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const options = buildFinanceBondingRevenueDryRunOptions(req);
    const report = await dryRunBnbBondingProtocolRevenueBackfill(pool, options);
    return res.status(200).json({
      ok: true,
      schemaVersion: "finance-bonding-revenue-dry-run-v1",
      generatedAt: new Date().toISOString(),
      source: "dashboard-api",
      report,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    console.error("[api/admin/finance/bonding-revenue-dry-run]", error);
    return res.status(500).json({ ok: false, error: "Finance bonding revenue dry run failed." });
  }
}
