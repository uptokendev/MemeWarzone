from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected pattern in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_all(path: str, old: str, new: str, minimum: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count < minimum:
        raise SystemExit(f"expected >= {minimum} occurrences in {path}, found {count}: {old!r}")
    p.write_text(text.replace(old, new))


# Robinhood must never inherit a generic/BSC distributor address.
replace_once(
    "frontend/api/dev-fix/reward-claim-intent.js",
    '''    chain === 56 ? process.env.REWARD_DISTRIBUTOR_ADDRESS_BNB : null,\n    process.env.REWARD_DISTRIBUTOR_ADDRESS,\n    process.env.VITE_REWARD_DISTRIBUTOR_ADDRESS,\n''',
    '''    chain === 56 ? process.env.REWARD_DISTRIBUTOR_ADDRESS_BNB : null,\n    chain === 56 || chain === 97 ? process.env.REWARD_DISTRIBUTOR_ADDRESS : null,\n    chain === 56 || chain === 97 ? process.env.VITE_REWARD_DISTRIBUTOR_ADDRESS : null,\n''',
)

# Solana accounting only advances from finalized V0-compatible evidence.
for file in [
    "frontend/api/lib/solanaRewardClaim.js",
    "frontend/api/lib/solanaLeagueClaimVerification.js",
    "frontend/api/lib/rewardClaimVerification.js",
]:
    replace_all(file, 'commitment: "confirmed"', 'commitment: "finalized"')

# Reward Claim Center reconciliation applies to every Solana reward type that has a
# deterministic on-chain receipt, not a UI-maintained allowlist. Unsupported lanes
# remain disabled by the server-side builder and therefore never create a tx.
replace_once(
    "frontend/src/lib/rewardProgramsApi.ts",
    '''  const stale = initial.filter((item) =>\n    (item.status === "claim_pending" || item.status === "failed") &&\n    (item.rewardType === "airdrop" || item.rewardType === "squad")\n  );\n''',
    '''  const stale = initial.filter((item) =>\n    item.status === "claim_pending" || item.status === "failed"\n  );\n''',
)

# Add EVM lost-response recovery beside the existing Solana receipt reconciler.
replace_once(
    "frontend/api/rewards.js",
    'import { discoverSolanaRewardClaim } from "./lib/solanaRewardReconciliation.js";\n\nconst SOLANA_CHAINS = new Set([101, 102]);\n',
    'import { discoverSolanaRewardClaim } from "./lib/solanaRewardReconciliation.js";\nimport { discoverEvmRewardClaim } from "./lib/rewardClaimVerification.js";\n\nconst SOLANA_CHAINS = new Set([101, 102]);\nconst EVM_CHAINS = new Set([56, 97, 4663, 46630]);\n',
)

insert_marker = '''async function reconcileSolanaClaims(req, res) {\n'''
evm_helpers = r'''function rewardMetadata(row) {
  const raw = row?.metadata;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function evmRewardDistributor(row, chainId) {
  const chain = Number(chainId);
  const meta = rewardMetadata(row);
  const fromMeta = firstText(meta, [
    "distributorAddress",
    "rewardDistributorAddress",
    "claimContractAddress",
    "contractAddress",
  ]);
  if (/^0x[a-fA-F0-9]{40}$/.test(fromMeta)) return fromMeta;
  const chainSpecific = String(
    process.env[`REWARD_DISTRIBUTOR_ADDRESS_${chain}`] ||
    process.env[`VITE_REWARD_DISTRIBUTOR_ADDRESS_${chain}`] ||
    (chain === 97 ? process.env.BNB_TESTNET_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    (chain === 56 ? process.env.BNB_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    (chain === 56 ? process.env.REWARD_DISTRIBUTOR_ADDRESS_BNB : "") ||
    ((chain === 56 || chain === 97) ? process.env.REWARD_DISTRIBUTOR_ADDRESS : "") ||
    ((chain === 56 || chain === 97) ? process.env.VITE_REWARD_DISTRIBUTOR_ADDRESS : "") ||
    "",
  ).trim();
  return /^0x[a-fA-F0-9]{40}$/.test(chainSpecific) ? chainSpecific : "";
}

function evmRewardBatchId(row) {
  const meta = rewardMetadata(row);
  const value = firstText(meta, [
    "contractBatchId",
    "merkleBatchId",
    "batchIdBytes32",
    "rewardBatchBytes32",
    "claimBatchBytes32",
  ]);
  return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : "";
}

async function reconcileEvmClaims(req, res, body) {
  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });
  const chainId = Number(body?.chainId);
  const walletAddress = normalizeWalletFlexible(body?.walletAddress || body?.address);
  const rawIds = Array.isArray(body?.rewardLedgerIds) ? body.rewardLedgerIds : [];
  const rewardLedgerIds = Array.from(new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean)));

  if (!EVM_CHAINS.has(chainId)) return json(res, 400, { error: "Reconciliation is only available for EVM reward chains" });
  if (!walletAddress || !isAddress(walletAddress)) return json(res, 400, { error: "Invalid EVM wallet address" });
  if (!rewardLedgerIds.length) return json(res, 200, { reconciledCount: 0, items: [], unresolved: [] });
  if (rewardLedgerIds.length > 10) return json(res, 400, { error: "At most 10 reward claims can be reconciled per request" });
  if (rewardLedgerIds.some((id) => !UUID_RE.test(id))) return json(res, 400, { error: "Invalid reward ledger id" });

  try {
    const { rows } = await pool.query(
      `select *
         from public.reward_ledger
        where id = any($1::uuid[])
          and lower(wallet_address) = lower($2)
          and chain::text = $3::text
          and status = any($4::text[])
        order by created_at asc`,
      [rewardLedgerIds, walletAddress, String(chainId), Array.from(RECOVERABLE_STATUSES)],
    );

    const items = [];
    const unresolved = [];
    for (const row of rows) {
      try {
        const distributorAddress = evmRewardDistributor(row, chainId);
        const batchId = evmRewardBatchId(row);
        if (!distributorAddress || !batchId) {
          unresolved.push({ rewardLedgerId: String(row.id), reason: "claim_metadata_missing", code: "EVM_CLAIM_METADATA_MISSING" });
          continue;
        }
        const verification = await discoverEvmRewardClaim({
          chainId,
          walletAddress,
          distributorAddress,
          batchId,
          amount: String(row.amount || "0"),
          minConfirmations: Number(process.env[`REWARD_CLAIM_MIN_CONFIRMATIONS_${chainId}`] || process.env.REWARD_CLAIM_MIN_CONFIRMATIONS || 1),
        });
        if (!verification) {
          unresolved.push({ rewardLedgerId: String(row.id), reason: "not_claimed_onchain", code: "EVM_CLAIM_NOT_FOUND" });
          continue;
        }
        items.push(await finalizeRecoveredClaim(row, verification));
      } catch (error) {
        console.warn(`[api/rewards] EVM reconciliation deferred for ${row.id}:`, error?.code || error?.message || error);
        unresolved.push({
          rewardLedgerId: String(row.id),
          reason: "verification_pending",
          code: error?.code || "EVM_CLAIM_RECONCILE_PENDING",
        });
      }
    }

    return json(res, 200, {
      walletAddress,
      chainId,
      requestedCount: rewardLedgerIds.length,
      checkedCount: rows.length,
      reconciledCount: items.filter((item) => item.status === "reconciled").length,
      items,
      unresolved,
      reconciledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[api/rewards:reconcile-evm]", error);
    if (error?.code === "42P01" || error?.code === "42703") {
      return json(res, 503, { error: "Reward reconciliation schema is not installed", code: "REWARD_SCHEMA_MISSING" });
    }
    return json(res, 500, { error: "Server error", code: error?.code || "REWARD_RECONCILE_FAILED" });
  }
}

'''
replace_once("frontend/api/rewards.js", insert_marker, evm_helpers + insert_marker)

# Let reconciliation receive a parsed body once so both action families are safe.
replace_once(
    "frontend/api/rewards.js",
    '''async function reconcileSolanaClaims(req, res) {\n  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });\n  const body = await readJson(req);\n  if (String(body?.action || "") !== "reconcile-solana-claims") {\n    return json(res, 400, { error: "Unsupported rewards action" });\n  }\n''',
    '''async function reconcileSolanaClaims(req, res, body) {\n  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });\n''',
)
replace_once(
    "frontend/api/rewards.js",
    '''export default async function handler(req, res) {\n  if (req.method === "POST") return reconcileSolanaClaims(req, res);\n  if (req.method !== "GET") return badMethod(res);\n''',
    '''export default async function handler(req, res) {\n  if (req.method === "POST") {\n    const body = await readJson(req);\n    const action = String(body?.action || "");\n    if (action === "reconcile-solana-claims") return reconcileSolanaClaims(req, res, body);\n    if (action === "reconcile-evm-claims") return reconcileEvmClaims(req, res, body);\n    return json(res, 400, { error: "Unsupported rewards action" });\n  }\n  if (req.method !== "GET") return badMethod(res);\n''',
)

# Claim Center triggers recovery for both EVM and Solana stale rows on reload.
replace_once(
    "frontend/src/lib/rewardProgramsApi.ts",
    '''export async function reconcileSolanaRewardClaims(params: {\n''',
    '''export async function reconcileEvmRewardClaims(params: {\n  walletAddress: string;\n  chainId: number;\n  rewardLedgerIds: string[];\n}): Promise<SolanaRewardReconciliationResult> {\n  const res = await fetch(buildRealtimeApiUrl("/api/rewards"), {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({\n      action: "reconcile-evm-claims",\n      walletAddress: params.walletAddress,\n      chainId: params.chainId,\n      rewardLedgerIds: params.rewardLedgerIds,\n    }),\n  });\n  return parseJson(res) as Promise<SolanaRewardReconciliationResult>;\n}\n\nexport async function reconcileSolanaRewardClaims(params: {\n''',
)
replace_once(
    "frontend/src/lib/rewardProgramsApi.ts",
    '''  const initial = await fetchRewardClaimsRaw(params);\n  const chainId = Number(params.chainId || 0);\n  if (![101, 102].includes(chainId)) return initial;\n\n  const stale = initial.filter((item) =>\n    item.status === "claim_pending" || item.status === "failed"\n  );\n  if (!stale.length) return initial;\n\n  try {\n    const reconciliation = await reconcileSolanaRewardClaims({\n''',
    '''  const initial = await fetchRewardClaimsRaw(params);\n  const chainId = Number(params.chainId || 0);\n  const isSolana = [101, 102].includes(chainId);\n  const isEvm = [56, 97, 4663, 46630].includes(chainId);\n  if (!isSolana && !isEvm) return initial;\n\n  const stale = initial.filter((item) =>\n    item.status === "claim_pending" || item.status === "failed"\n  );\n  if (!stale.length) return initial;\n\n  try {\n    const reconcile = isSolana ? reconcileSolanaRewardClaims : reconcileEvmRewardClaims;\n    const reconciliation = await reconcile({\n''',
)
replace_once(
    "frontend/src/lib/rewardProgramsApi.ts",
    '''  } catch (error) {\n    console.warn("[rewardProgramsApi] Solana claim reconciliation deferred:", error);\n  }\n''',
    '''  } catch (error) {\n    console.warn(`[rewardProgramsApi] ${isSolana ? "Solana" : "EVM"} claim reconciliation deferred:`, error);\n  }\n''',
)

# Add an exact-source certification guard. It deliberately asserts unsupported lanes
# stay unavailable rather than pretending three-chain feature parity.
test = r'''import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) { return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }

const intent = read("api/dev-fix/reward-claim-intent.js");
assert.match(intent, /chain === 56 \|\| chain === 97 \? process\.env\.REWARD_DISTRIBUTOR_ADDRESS : null/);
assert.doesNotMatch(intent, /\n\s*process\.env\.REWARD_DISTRIBUTOR_ADDRESS,\n\s*process\.env\.VITE_REWARD_DISTRIBUTOR_ADDRESS,/);
assert.match(intent, /for update/);
assert.match(intent, /CLAIM_TX_ALREADY_USED/);
assert.match(intent, /CLAIM_ALREADY_RECORDED/);

const rewardVerify = read("api/lib/rewardClaimVerification.js");
assert.match(rewardVerify, /hasClaimed/);
assert.match(rewardVerify, /RewardClaimed/);
assert.match(rewardVerify, /discoverEvmRewardClaim/);

const rewardSol = read("api/lib/solanaRewardClaim.js");
assert.match(rewardSol, /maxSupportedTransactionVersion:\s*0/);
assert.match(rewardSol, /commitment:\s*"finalized"/);
assert.match(rewardSol, /if \(rewardType === "squad"\)/);
assert.match(rewardSol, /if \(rewardType !== "airdrop"\) return unavailableCall/);

const leagueSol = read("api/lib/solanaLeagueClaimVerification.js");
assert.match(leagueSol, /maxSupportedTransactionVersion:\s*0/);
assert.match(leagueSol, /commitment:\s*"finalized"/);
assert.match(leagueSol, /claimReceipt/);

const router = read("api/leagueRouter.js");
assert.match(router, /verifySolanaLeagueClaimTransaction/);
assert.match(router, /verifyEvmLeagueClaimTransaction/);
assert.match(router, /discoverEvmLeagueClaimTransaction/);
assert.match(router, /pg_advisory_xact_lock/);

const rewards = read("api/rewards.js");
assert.match(rewards, /reconcile-evm-claims/);
assert.match(rewards, /reconcile-solana-claims/);
assert.match(rewards, /discoverEvmRewardClaim/);
assert.match(rewards, /discoverSolanaRewardClaim/);
assert.match(rewards, /for update/);

const client = read("src/lib/rewardProgramsApi.ts");
assert.match(client, /reconcileEvmRewardClaims/);
assert.match(client, /reconcileSolanaRewardClaims/);
assert.match(client, /claim_pending/);

const lp = read("src/lib/lpFeeHarvest.ts");
assert.match(lp, /Wrong wallet network/);
assert.match(lp, /registered/);
assert.match(lp, /lockedLiquidity/);
assert.match(lp, /await tx\.wait\(\)/);

const recruiter = read("src/components/command-center/RecruiterNativePayoutsPanel.tsx");
assert.match(recruiter, /type NativeChain = "bnb" \| "solana"/);
assert.doesNotMatch(recruiter, /type NativeChain = .*robinhood/);

console.log("Agent 6 three-chain claim safety source matrix: PASS");
'''
Path("frontend/scripts/agent6-all-claims-three-chain.test.mjs").write_text(test)

cert = r'''# Agent 6 — Every Claim, Three Chains

Authority audited: `build/cross-chain-stabilization-rh-base` at `2f895b707260309ffa941fca55b0e408b597ab80`.

This certification is fail-closed: an absent entitlement or absent chain-native settlement lane is **NOT IMPLEMENTED / NOT CLAIMABLE**, never silently mapped to another chain or currency.

## Settlement rails

| Surface | BNB | Solana | Robinhood |
|---|---|---|---|
| Generic reward ledger (`battle`, `tournament`, `creator`, `sponsor`, `other`) | RewardDistributor when materialized | only types with a native rewards-program instruction are claimable; unsupported types fail closed | chain-specific RewardDistributor only; native value is ETH |
| Airdrop | RewardDistributor | rewards treasury + deterministic claim receipt | RewardDistributor only when chain-specific entitlement/config exists; ETH |
| Squad | RewardDistributor | rewards treasury `claim_squad` + deterministic claim receipt | RewardDistributor only when materialized/configured; ETH |
| Recruiter native portal | BNB native portal | SOL native portal | NOT IMPLEMENTED in current recruiter-native UI; no false BNB fallback |
| MWL / League | TreasuryVaultV2 Merkle claim | Solana rewards treasury League claim receipt | TreasuryVaultV2 only with chain-specific vault/RPC; ETH |
| Quarterly Championship | separate championship runtime; certify only where its final payout materializes through an audited claim rail | same rule | same rule; no claim is synthesized from League metadata |
| LP fees | PermanentLpLocker harvest | backend Solana LP collection path | PermanentV3PositionLocker harvest; registered locked position required |

## Cross-cutting proof

- Chain: every record/reconciliation path binds the entitlement chain; Robinhood cannot inherit generic BNB RewardDistributor or TreasuryVault addresses.
- Recipient and amount: EVM record/recovery decodes exact calls/events; Solana verifies deterministic program accounts/receipt data.
- Authorization/signature: user claim intent/record requires signed wallet action auth; League claim message binds chain, recipient, epoch, category, rank and nonce.
- Builder/wallet: EVM waits mined wallet transactions; Solana verification accepts Versioned Transaction V0 (`maxSupportedTransactionVersion: 0`).
- Confirmation: Solana reconciliation requires `finalized`; EVM requires successful receipt plus configured confirmation depth.
- State/accounting: database transitions are locked and occur only after chain verification. Replay of a tx against another entitlement is rejected.
- Reload/lost HTTP response: stale `claim_pending`/`failed` generic reward rows are reconciled from authoritative EVM events or finalized Solana receipt PDAs. EVM League has event/state discovery and locked repair.
- Double-click/concurrency: UI pending action guards reduce duplicate submits; database row locks/advisory locks serialize record/reconciliation; on-chain distributors/vault receipt state provides the payment-level exactly-once boundary.
- Failed transaction retry: reverted/missing/unfinalized transactions do not advance `claimed`; stale rows remain recoverable.

## Deliberately unsupported / blocked

Do not label a cell PASS merely because another chain has a similarly named button. Current repository evidence does **not** establish a Robinhood recruiter-native portal lane, and Solana generic reward types other than the explicitly wired rewards-program instructions remain fail-closed. Quarterly Championship uses its own championship runtime; it is not converted into an MWL payout by this certification.
'''
Path("docs/launch-control/AGENT6_ALL_LAUNCH_CLAIMS_THREE_CHAIN.md").parent.mkdir(parents=True, exist_ok=True)
Path("docs/launch-control/AGENT6_ALL_LAUNCH_CLAIMS_THREE_CHAIN.md").write_text(cert)

print("Agent 6 claim matrix remediation applied")
