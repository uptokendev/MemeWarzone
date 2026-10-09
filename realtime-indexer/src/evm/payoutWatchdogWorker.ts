/**
 * Payout watchdog loop (founder, 2026-10-08: "Safe module: yes"). Per enabled chain, every interval:
 *
 *   1. Health: the Roles module is the Safe's (owner = avatar = target = Safe), enabled on the Safe, and the watchdog
 *      holds the role (a probe eth_call). Critical alert otherwise; nothing is sent while any of it fails.
 *   2. Holder batches: every HolderBatchProposed on the listed vaults (gen-6, gen-7) not yet approved, vetoed or
 *      executed is recomputed from chain data (payoutWatchdog.ts verifyHolderProposal). Equal: approveHolderBatch
 *      through the module. Different: never approved, critical alert (the Safe signers verify and decide by hand).
 *   3. Authorizations: each listed distributor (holder gen-6 / gen-7, airdrop main / gen-7) keeps PAYOUT_WATCHDOG_WEEKS
 *      (12) weeks of its deterministic batch ids authorized at its cap; Roles' own allowance bounds how much per week.
 *   4. Heartbeat: public.payout_watchdog_state (the Finance alerts and the airdrop runner read it; a stale heartbeat is
 *      their "watchdog down" alert), alerts in public.reward_alerts (reward_type 'payout_watchdog').
 *
 * Dry run unless PAYOUT_WATCHDOG_SEND=true: every decision is logged and alerted, nothing is signed.
 *
 *   PAYOUT_WATCHDOG_ENABLED_<chainId>=true               56, 4663 (97, 46630 for testnets with a Safe)
 *   PAYOUT_WATCHDOG_SEND=true                            real sends
 *   PAYOUT_WATCHDOG_PK_<chainId>                         the watchdog's OWN key (refused: any other key in the env, the
 *                                                        operators, the deployer, the route authority, the Safe, its owners)
 *   PAYOUT_WATCHDOG_ROLES_<chainId>                      the Roles module (deployments/<chain>/mainnet.payout-roles.json)
 *   PAYOUT_WATCHDOG_SAFE_<chainId>                       default the treasury Safe 0x1edcEdf5…
 *   EVM_CREATOR_VAULT_V2_<chainId> / EVM_GEN7_CREATOR_VAULT_<chainId>   the vaults ("0xaddr@startBlock", the operator's own)
 *   PAYOUT_WATCHDOG_AIRDROP_DISTRIBUTOR_<chainId>        main airdrop distributor (default REWARD_DISTRIBUTOR_ADDRESS_<chainId>)
 *   PAYOUT_WATCHDOG_GEN7_AIRDROP_DISTRIBUTOR_<chainId>   gen-7 airdrop distributor (default REWARD_DISTRIBUTOR_ADDRESS_GEN7_<chainId>)
 *   PAYOUT_WATCHDOG_AIRDROP_CAP_WEI_<chainId>            per-id cap on the airdrop distributors (gen-7: _GEN7_ variant, default main)
 *   PAYOUT_WATCHDOG_HOLDER_CAP_WEI[_<chainId>]           per-id cap on the holder distributors (default: the vault's weekly cap)
 *   PAYOUT_WATCHDOG_WEEKS (12), PAYOUT_WATCHDOG_INTERVAL_MS (60000), PAYOUT_WATCHDOG_LOOKBACK_BLOCKS[_<id>] (200000),
 *   PAYOUT_WATCHDOG_LOG_CHUNK (5000), PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS[_<id>] (600), PAYOUT_WATCHDOG_SNAPSHOT_TOLERANCE_HOURS
 *   (12), PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS (2000), PAYOUT_WATCHDOG_MAX_TX_PER_TICK (6), PAYOUT_WATCHDOG_FORBIDDEN_ADDRESSES
 *   Shared with the creator-choice operator (same values): EVM_BUYBACK_SEED_SECRET, EVM_HOLDER_EXCLUDED_WALLETS[_<id>],
 *   EVM_HOLDER_MIN_PAYOUT_WEI[_<id>], EVM_HOLDER_CLAIM_WINDOW_DAYS. RPC: the keeper's (BSC_RPC_HTTP_56, ROBINHOOD_RPC_HTTP_4663).
 */
import { ethers } from "ethers";
import type { LeafFile } from "./evmCreatorChoice.js";
import { riskExcludedWallets, type Queryable } from "./evmCreatorChoicePass.js";
import {
  airdropAuthTargets,
  authorizationPlan,
  coveredWeeks,
  holderAuthTargets,
  probeVerdict,
  verifyHolderProposal,
  type AuthTarget,
  type VerifyConfig,
} from "./payoutWatchdog.js";
import { DISTRIBUTOR_IFACE, WATCHDOG_VAULT_IFACE, type WatchdogChain, type WatchdogSender } from "./payoutWatchdogChain.js";
import { assertWatchdogKeyAllowed, type WatchdogConfig } from "./payoutWatchdogConfig.js";

export const ALERT_REWARD_TYPE = "payout_watchdog";

export type PendingBatch = { vault: string; program: string; batchId: string; blockNumber: number; txHash: string; args: { root: string; total: string; executableAt: string; claimDeadline: string }; firstSeenAt: number };
export type WatchdogMemory = {
  cursors: Record<string, number>;
  pending: Record<string, PendingBatch>;
  verdicts: Record<string, { kind: string; reasons: string[]; at: number; txHash: string; root?: string; total?: string }>;
};

export function emptyMemory(): WatchdogMemory {
  return { cursors: {}, pending: {}, verdicts: {} };
}

export type WatchdogAction = { kind: "approve" | "authorize"; target: string; subject: string; decision: "sent" | "dry-run" | "refused" | "mismatch" | "missing" | "skip" | "failed"; reason?: string; txHash?: string };
export type TickReport = {
  chainId: number;
  send: boolean;
  moduleEnabled: boolean;
  roleOk: boolean;
  wiringOk: boolean;
  actions: WatchdogAction[];
  coverage: Array<{ distributor: string; label: string; coveredWeeks: number; toAuthorize: number; revoked: number }>;
  alerts: Array<{ severity: string; kind: string; title: string }>;
  error?: string;
};

// ------------------------------------------------------------------------------------ database (all tolerant)

async function safeQuery(db: Queryable | null, sql: string, params: unknown[] = []) {
  if (!db) return { rows: [] as any[] };
  try {
    return await db.query(sql, params);
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") return { rows: [] as any[] };
    throw error;
  }
}

/** One open alert per (kind, chain, subject): a repeat while it is open writes nothing. */
export async function raiseAlert(db: Queryable | null, a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string; extra?: Record<string, unknown> }) {
  if (!db) return false;
  const subject = a.subject ?? "";
  const open = await safeQuery(
    db,
    `select id from public.reward_alerts where status = 'open' and reward_type = $1 and metadata->>'kind' = $2 and metadata->>'chainId' = $3 and coalesce(metadata->>'subject','') = $4 limit 1`,
    [ALERT_REWARD_TYPE, a.kind, String(a.chainId), subject],
  );
  if (open.rows.length) return false;
  await safeQuery(
    db,
    `insert into public.reward_alerts (severity, reward_type, title, message, status, metadata) values ($1, $2, $3, $4, 'open', $5::jsonb)`,
    [a.severity, ALERT_REWARD_TYPE, a.title, a.message, JSON.stringify({ kind: a.kind, chainId: a.chainId, subject, ...(a.extra || {}) })],
  );
  return true;
}

export async function resolveAlerts(db: Queryable | null, kind: string, chainId: number, subject?: string) {
  await safeQuery(
    db,
    `update public.reward_alerts set status = 'resolved', resolved_at = now(), resolved_by = 'payout_watchdog'
      where status = 'open' and reward_type = $1 and metadata->>'kind' = $2 and metadata->>'chainId' = $3 ${subject == null ? "" : "and coalesce(metadata->>'subject','') = $4"}`,
    subject == null ? [ALERT_REWARD_TYPE, kind, String(chainId)] : [ALERT_REWARD_TYPE, kind, String(chainId), subject],
  );
}

export async function loadMemory(db: Queryable | null, chainId: number): Promise<WatchdogMemory> {
  const { rows } = await safeQuery(db, `select status from public.payout_watchdog_state where chain_id = $1`, [chainId]);
  const s = rows[0]?.status || {};
  return { cursors: s.cursors || {}, pending: s.pending || {}, verdicts: s.verdicts || {} };
}

export async function saveState(db: Queryable | null, input: { cfg: WatchdogConfig; watchdog: string; report: TickReport; memory: WatchdogMemory; error?: string | null }) {
  const ok = input.report.moduleEnabled && input.report.roleOk && input.report.wiringOk && !input.error;
  await safeQuery(
    db,
    `insert into public.payout_watchdog_state (chain_id, watchdog_address, roles_address, safe_address, send, module_enabled, role_ok, last_tick_at, last_ok_at, last_error, status, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now(), case when $8 then now() else null end, $9, $10::jsonb, now())
     on conflict (chain_id) do update set watchdog_address = excluded.watchdog_address, roles_address = excluded.roles_address,
       safe_address = excluded.safe_address, send = excluded.send, module_enabled = excluded.module_enabled, role_ok = excluded.role_ok,
       last_tick_at = now(), last_ok_at = case when $8 then now() else public.payout_watchdog_state.last_ok_at end,
       last_error = excluded.last_error, status = excluded.status, updated_at = now()`,
    [
      input.cfg.chainId, input.watchdog.toLowerCase(), input.cfg.roles?.toLowerCase() ?? null, input.cfg.safe.toLowerCase(), input.cfg.send,
      input.report.moduleEnabled, input.report.roleOk, ok, input.error ?? null,
      JSON.stringify({ ...input.memory, coverage: input.report.coverage, weeks: input.cfg.weeks, actions: input.report.actions.slice(-20) }),
    ],
  );
}

/** The operator's published leaf file of a batch: a hint, verified in full before anything is approved. */
export async function leafFileFor(db: Queryable | null, chainId: number, vault: string, batchId: string): Promise<LeafFile | null> {
  const { rows } = await safeQuery(
    db,
    `select leaf_file from public.evm_holder_batches where chain_id = $1 and lower(vault_address) = $2 and lower(batch_id) = $3 and leaf_file is not null limit 1`,
    [chainId, vault.toLowerCase(), batchId.toLowerCase()],
  );
  return (rows[0]?.leaf_file as LeafFile) ?? null;
}

// ------------------------------------------------------------------------------------ one tick

export type TickDeps = {
  db: Queryable | null;
  cfg: WatchdogConfig;
  chain: WatchdogChain;
  sender: WatchdogSender;
  memory: WatchdogMemory;
  riskExcluded?: () => Promise<Set<string>>;
  leafFile?: (vault: string, batchId: string) => Promise<LeafFile | null>;
  log?: (line: string, extra?: unknown) => void;
};

/** On-chain addresses the watchdog key must not be: Safe owners, vault operators, airdrop operators. */
export async function onChainRefusals(chain: WatchdogChain, cfg: WatchdogConfig): Promise<Array<{ address: string; label: string }>> {
  const out: Array<{ address: string; label: string }> = [];
  for (const o of await chain.safeOwners(cfg.safe)) out.push({ address: o.toLowerCase(), label: "Safe owner" });
  for (const v of cfg.vaults) {
    const op = await chain.vaultOperator(v.vault);
    if (op !== ethers.ZeroAddress) out.push({ address: op.toLowerCase(), label: `${v.label} vault operator` });
  }
  for (const a of cfg.airdrops) {
    if (!a.address) continue;
    const op = await chain.communityAirdropOperator(a.address);
    if (op && op !== ethers.ZeroAddress) out.push({ address: op.toLowerCase(), label: `${a.label} airdrop operator` });
  }
  return out;
}

export async function runWatchdogTick(deps: TickDeps): Promise<TickReport> {
  const { db, cfg, chain, sender, memory } = deps;
  const log = deps.log ?? ((line: string, extra?: unknown) => console.log(`[payout-watchdog] ${line}`, extra ?? ""));
  const report: TickReport = { chainId: cfg.chainId, send: cfg.send, moduleEnabled: false, roleOk: false, wiringOk: false, actions: [], coverage: [], alerts: [] };
  const alert = async (a: Parameters<typeof raiseAlert>[1]) => {
    report.alerts.push({ severity: a.severity, kind: a.kind, title: a.title });
    log(`${a.severity.toUpperCase()} ${a.title}`, a.message);
    await raiseAlert(db, a);
  };
  const id = cfg.chainId;
  if (!cfg.roles) {
    await alert({ severity: "critical", kind: "payout_watchdog_config", chainId: id, title: `Payout watchdog on chain ${id}: no Roles module configured`, message: `Set PAYOUT_WATCHDOG_ROLES_${id} (deployments/<chain>/mainnet.payout-roles.json). Until then holder approvals and authorizations need the Safe signers.` });
    return report;
  }
  await resolveAlerts(db, "payout_watchdog_config", id);

  // 1. Health.
  const wiring = await chain.rolesWiring(cfg.roles);
  report.wiringOk = [wiring.owner, wiring.avatar, wiring.target].every((a) => a.toLowerCase() === cfg.safe.toLowerCase());
  report.moduleEnabled = await chain.isModuleEnabled(cfg.safe, cfg.roles);
  const probeTarget = cfg.vaults[0]?.vault ?? cfg.airdrops.find((a) => a.address)?.address ?? null;
  let probe: string | null = "no target to probe";
  if (probeTarget) {
    const data = cfg.vaults[0]
      ? WATCHDOG_VAULT_IFACE.encodeFunctionData("approveHolderBatch", [ethers.ZeroHash, ethers.ZeroHash, 0n])
      : DISTRIBUTOR_IFACE.encodeFunctionData("authorizeBatch", [ethers.id("payout-watchdog-probe"), 1n, 0n, 1n]);
    probe = await chain.simulate(cfg.roles, sender.address, probeTarget, data, false);
  }
  const verdict = probeVerdict(probe);
  report.roleOk = verdict === "ok";
  if (!report.wiringOk) {
    await alert({ severity: "critical", kind: "payout_watchdog_module", chainId: id, title: `Payout watchdog on chain ${id}: the Roles module ${cfg.roles} is not the Safe's`, message: `owner ${wiring.owner}, avatar ${wiring.avatar}, target ${wiring.target}; expected ${cfg.safe} for all three. Nothing is sent.` });
  } else if (!report.moduleEnabled) {
    await alert({ severity: "critical", kind: "payout_watchdog_module", chainId: id, title: `Payout watchdog on chain ${id}: the Roles module is not enabled on the Safe`, message: `Safe ${cfg.safe} does not have ${cfg.roles} enabled (missing, or disabled by the signers). Holder approvals and distributor authorizations need the Safe signers by hand until it is enabled again.` });
  } else {
    await resolveAlerts(db, "payout_watchdog_module", id);
  }
  if (report.moduleEnabled && report.wiringOk && !report.roleOk) {
    await alert({ severity: "critical", kind: "payout_watchdog_role", chainId: id, title: `Payout watchdog on chain ${id}: the watchdog does not hold the role`, message: `A probe through ${cfg.roles} from ${sender.address} answered ${probe} (${verdict}). Check assignRoles / the scoping batch.` });
  } else if (report.roleOk) {
    await resolveAlerts(db, "payout_watchdog_role", id);
  }
  const healthy = report.wiringOk && report.moduleEnabled && report.roleOk;
  if (!healthy) return report;

  const latest = await chain.latestBlock();
  const nowSec = latest.timestamp;
  let budget = cfg.maxTxPerTick;
  const exec = async (to: string, data: string): Promise<{ hash: string } | { error: string }> => {
    try {
      const rc = await sender.exec(cfg.roles!, to, data);
      if (rc.status !== 1) return { error: `transaction ${rc.hash} reverted` };
      return { hash: rc.hash };
    } catch (error) {
      return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  };

  // 2. Holder batches.
  let risk: Set<string> | null = null;
  for (const lane of cfg.vaults) {
    const vault = lane.vault;
    if (!lane.startBlock) {
      // The census starts at the vault's deploy block; without it a scan from block 0 would never finish.
      await alert({ severity: "warning", kind: "payout_watchdog_config", chainId: id, subject: vault.toLowerCase(), title: `Payout watchdog on chain ${id}: the ${lane.label} vault has no start block`, message: `Set its variable as "0xaddr@deployBlock" (EVM_CREATOR_VAULT_V2_${id} / EVM_GEN7_CREATOR_VAULT_${id}). Holder batches of this vault are left to the Safe signers until then.` });
      continue;
    }
    const cursor = memory.cursors[vault.toLowerCase()] ?? Math.max(lane.startBlock || 0, latest.number - cfg.lookbackBlocks);
    const events = await chain.scanVault(vault, cursor, latest.number);
    for (const e of events) {
      if (e.name === "HolderBatchProposed") {
        memory.pending[e.batchId] ??= {
          vault: vault.toLowerCase(), program: lane.program, batchId: e.batchId, blockNumber: e.blockNumber, txHash: e.txHash,
          args: { root: String(e.args.root), total: String(e.args.total), executableAt: String(e.args.executableAt), claimDeadline: String(e.args.claimDeadline) },
          firstSeenAt: nowSec,
        };
      } else {
        delete memory.pending[e.batchId];
        delete memory.verdicts[e.batchId];
      }
    }
    memory.cursors[vault.toLowerCase()] = latest.number + 1;

    for (const pend of Object.values(memory.pending).filter((p) => p.vault === vault.toLowerCase())) {
      if (budget <= 0) break;
      const cached = memory.verdicts[pend.batchId];
      if (cached && cached.kind === "mismatch" && cached.txHash === pend.txHash) {
        report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "mismatch", reason: cached.reasons[0] });
        continue;
      }
      const proposal = await chain.proposal({ chainId: id, vault, program: lane.program, event: { name: "HolderBatchProposed", batchId: pend.batchId, blockNumber: pend.blockNumber, txHash: pend.txHash, args: pend.args } });
      const file = deps.leafFile ? await deps.leafFile(vault, pend.batchId) : await leafFileFor(db, id, vault, pend.batchId);
      risk ??= deps.riskExcluded ? await deps.riskExcluded() : db ? await riskExcludedWallets(db) : new Set<string>();
      const vcfg: VerifyConfig = {
        minPayoutWei: cfg.minPayoutWei, claimWindowDays: cfg.claimWindowDays, excluded: cfg.excluded, riskExcluded: risk, masterSecret: cfg.masterSecret,
        snapshotToleranceSec: cfg.snapshotToleranceSec, censusLagBlocks: cfg.censusLagBlocks, maxExcludedBps: cfg.maxExcludedBps,
      };
      let result: Awaited<ReturnType<typeof verifyHolderProposal>>;
      try {
        // A batch already found equal (dry run, or a send that failed) is not recomputed every tick.
        result = cached?.kind === "ok" && cached.txHash === pend.txHash && cached.root && cached.total
          ? { ok: true, weekId: "", root: cached.root, total: BigInt(cached.total), leaves: 0, campaigns: 0, blocks: {} }
          : await verifyHolderProposal(proposal, file, chain.verifyDeps(vault, lane.startBlock || 0), vcfg);
      } catch (error) {
        result = { ok: false as const, kind: "missing" as const, reasons: [`verification could not read the chain: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`] };
      }
      if (!result.ok) {
        memory.verdicts[pend.batchId] = { kind: result.kind, reasons: result.reasons, at: nowSec, txHash: pend.txHash };
        report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: result.kind, reason: result.reasons[0] });
        if (result.kind === "mismatch") {
          await alert({ severity: "critical", kind: "payout_watchdog_mismatch", chainId: id, subject: pend.batchId, title: `Payout watchdog on chain ${id}: holder batch ${pend.batchId.slice(0, 10)}… on the ${lane.label} vault does NOT match the chain; not approved`, message: `${result.reasons.join("; ")}. The watchdog will not approve it. Safe signers: verify with scripts/evm-holder-batch-verify.mjs and veto or approve by hand.`, extra: { vault, batchId: pend.batchId, txHash: pend.txHash } });
        } else if (nowSec - pend.firstSeenAt > 2 * 3600) {
          await alert({ severity: "warning", kind: "payout_watchdog_missing_data", chainId: id, subject: pend.batchId, title: `Payout watchdog on chain ${id}: holder batch ${pend.batchId.slice(0, 10)}… on the ${lane.label} vault cannot be checked yet`, message: `${result.reasons.join("; ")}. It is retried every tick; until it is checked the Safe signers can approve it by hand.`, extra: { vault, batchId: pend.batchId } });
        }
        continue;
      }
      memory.verdicts[pend.batchId] = { kind: "ok", reasons: [], at: nowSec, txHash: pend.txHash, root: result.root, total: result.total.toString() };
      await resolveAlerts(db, "payout_watchdog_missing_data", id, pend.batchId);
      const data = WATCHDOG_VAULT_IFACE.encodeFunctionData("approveHolderBatch", [pend.batchId, result.root, result.total]);
      const sim = await chain.simulate(cfg.roles, sender.address, vault, data, true);
      if (sim) {
        if (sim === "ModuleTransactionFailed") {
          // Roles allowed it; the vault refused (vetoed / executed meanwhile): nothing to approve.
          delete memory.pending[pend.batchId];
          report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "skip", reason: "the vault refuses (vetoed or executed)" });
        } else {
          report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "refused", reason: sim });
          await alert({ severity: "critical", kind: "payout_watchdog_refused", chainId: id, subject: `approve:${pend.batchId}`, title: `Payout watchdog on chain ${id}: the Roles module refused approveHolderBatch on the ${lane.label} vault`, message: `${sim}. The batch matched the chain but the module's scope does not allow it (cap?). Safe signers approve by hand.` });
        }
        continue;
      }
      if (!cfg.send) {
        report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "dry-run", reason: `matches the chain: ${result.leaves} leaves, ${result.total} wei, root ${result.root}` });
        continue;
      }
      budget -= 1;
      const sent = await exec(vault, data);
      if ("hash" in sent) {
        delete memory.pending[pend.batchId];
        delete memory.verdicts[pend.batchId];
        report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "sent", txHash: sent.hash, reason: `${result.total} wei to ${result.leaves} holders` });
      } else {
        report.actions.push({ kind: "approve", target: vault, subject: pend.batchId, decision: "failed", reason: sent.error });
      }
    }
  }

  // 3. Authorizations.
  const lanes: Array<{ label: string; address: string; targets: AuthTarget[] }> = [];
  for (const v of cfg.vaults) {
    const dist = await chain.vaultHolderDistributor(v.vault);
    if (dist === ethers.ZeroAddress) continue;
    const cap = v.holderCapWei ?? (await chain.vaultHolderCap(v.vault));
    if (cap <= 0n) continue;
    lanes.push({ label: `${v.label} holder`, address: dist, targets: holderAuthTargets({ chainId: id, program: v.program, capWei: cap, nowSec, weeks: cfg.weeks }) });
  }
  for (const a of cfg.airdrops) {
    if (!a.address) continue;
    if (a.capWei == null || a.capWei <= 0n) {
      await alert({ severity: "warning", kind: "payout_watchdog_config", chainId: id, subject: a.address, title: `Payout watchdog on chain ${id}: no cap for the ${a.label} distributor`, message: `Set ${a.pot === "main" ? "PAYOUT_WATCHDOG_AIRDROP_CAP_WEI" : "PAYOUT_WATCHDOG_GEN7_AIRDROP_CAP_WEI"}_${id} to the cap in deployments/<chain>/mainnet.payout-roles.json.` });
      continue;
    }
    lanes.push({ label: a.label, address: a.address, targets: airdropAuthTargets({ chainId: id, pot: a.pot ?? "main", capWei: a.capWei, nowSec, weeks: cfg.weeks }) });
  }
  for (const lane of lanes) {
    const states = await chain.authStates(lane.address, lane.targets.map((t) => t.batchId));
    const plan = authorizationPlan(lane.targets, states, nowSec);
    const revoked = plan.skipped.filter((s) => s.reason === "revoked");
    for (const r of revoked) report.actions.push({ kind: "authorize", target: lane.address, subject: r.target.batchId, decision: "skip", reason: `${r.target.label}: revoked by the Safe, left alone` });
    let stop = false;
    for (const t of plan.toAuthorize) {
      if (stop || budget <= 0) break;
      const data = DISTRIBUTOR_IFACE.encodeFunctionData("authorizeBatch", [t.batchId, t.maxAmount, t.publishAfter, t.publishDeadline]);
      const sim = await chain.simulate(cfg.roles, sender.address, lane.address, data, true);
      if (sim) {
        stop = true;
        report.actions.push({ kind: "authorize", target: lane.address, subject: t.batchId, decision: "refused", reason: `${t.label}: ${sim}` });
        if (/AllowanceExceeded/.test(sim)) {
          await alert({ severity: "warning", kind: "payout_watchdog_allowance", chainId: id, subject: lane.address, title: `Payout watchdog on chain ${id}: the ${lane.label} distributor's Roles allowance is used up`, message: `authorizeBatch(${t.label}) is over the module's allowance; it refills one week of authorizations per week. If the runway is short, the Safe signers authorize by hand (scripts/make-*-calls.mjs).` });
        } else {
          await alert({ severity: "critical", kind: "payout_watchdog_refused", chainId: id, subject: `authorize:${lane.address}`, title: `Payout watchdog on chain ${id}: the Roles module refused authorizeBatch on the ${lane.label} distributor`, message: `${t.label}: ${sim}. Check the cap in the watchdog env against the module's scope.` });
        }
        break;
      }
      if (!cfg.send) {
        report.actions.push({ kind: "authorize", target: lane.address, subject: t.batchId, decision: "dry-run", reason: t.label });
        continue;
      }
      budget -= 1;
      const sent = await exec(lane.address, data);
      if ("hash" in sent) {
        states.set(t.batchId.toLowerCase(), { maxAmount: t.maxAmount, publishAfter: t.publishAfter, publishDeadline: t.publishDeadline, authorized: true, consumed: false, exists: false });
        report.actions.push({ kind: "authorize", target: lane.address, subject: t.batchId, decision: "sent", txHash: sent.hash, reason: t.label });
      } else {
        stop = true;
        report.actions.push({ kind: "authorize", target: lane.address, subject: t.batchId, decision: "failed", reason: `${t.label}: ${sent.error}` });
      }
    }
    if (!stop) {
      await resolveAlerts(db, "payout_watchdog_allowance", id, lane.address);
      await resolveAlerts(db, "payout_watchdog_refused", id, `authorize:${lane.address}`);
    }
    report.coverage.push({ distributor: lane.address, label: lane.label, coveredWeeks: coveredWeeks(lane.targets, states, nowSec), toAuthorize: plan.toAuthorize.length, revoked: revoked.length });
  }
  return report;
}

// ------------------------------------------------------------------------------------ the loop

let started = false;

export async function startPayoutWatchdogWorker() {
  if (started) return;
  started = true;
  const { enabledWatchdogChains, watchdogConfig, watchdogWallet } = await import("./payoutWatchdogConfig.js");
  const chains = enabledWatchdogChains();
  if (!chains.length) {
    console.log("[payout-watchdog] disabled (set PAYOUT_WATCHDOG_ENABLED_<chainId>=true)");
    return;
  }
  const { pool } = await import("../db.js");
  const { ENV } = await import("../env.js");
  const { createStaticJsonRpcProvider } = await import("../rpcProvider.js");
  const { keeperRpc } = await import("./evmGraduationKeeperWorker.js");
  const { createEthersWatchdogChain, createEthersWatchdogSender } = await import("./payoutWatchdogChain.js");
  for (const chainId of chains) {
    const cfg = watchdogConfig(chainId);
    let wallet: ethers.Wallet | null = null;
    try {
      wallet = watchdogWallet(chainId);
    } catch (error) {
      console.error("[payout-watchdog] key refused; the watchdog does not start on this chain", { chainId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const url = keeperRpc(chainId);
    if (!wallet || !url) {
      console.warn("[payout-watchdog] chain skipped (needs PAYOUT_WATCHDOG_PK_<id> and the chain RPC)", { chainId });
      continue;
    }
    const provider = createStaticJsonRpcProvider(url, chainId, { timeoutMs: ENV.RPC_REQUEST_TIMEOUT_MS });
    const chain = createEthersWatchdogChain(provider, { logChunk: cfg.logChunk });
    try {
      assertWatchdogKeyAllowed(wallet.address, process.env, await onChainRefusals(chain, cfg));
    } catch (error) {
      console.error("[payout-watchdog] key refused; the watchdog does not start on this chain", { chainId, error: error instanceof Error ? error.message : String(error) });
      await raiseAlert(pool, { severity: "critical", kind: "payout_watchdog_key", chainId, title: `Payout watchdog on chain ${chainId}: key refused`, message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      continue;
    }
    const sender = createEthersWatchdogSender(provider, wallet);
    const memory = await loadMemory(pool, chainId).catch(() => emptyMemory());
    console.log("[payout-watchdog] enabled", { chainId, send: cfg.send, roles: cfg.roles, safe: cfg.safe, watchdog: wallet.address, vaults: cfg.vaults.map((v) => `${v.label} ${v.vault}`), airdrops: cfg.airdrops.map((a) => `${a.label} ${a.address}`) });
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      let report: TickReport | null = null;
      let error: string | null = null;
      try {
        report = await runWatchdogTick({ db: pool, cfg, chain, sender, memory });
        const acted = report.actions.filter((a) => a.decision !== "skip");
        if (acted.length || report.alerts.length) console.log("[payout-watchdog] tick", JSON.stringify({ chainId, send: cfg.send, actions: acted, alerts: report.alerts, coverage: report.coverage }));
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 500) : String(e);
        console.error("[payout-watchdog] tick failed", { chainId, error });
      } finally {
        try {
          await saveState(pool, {
            cfg, watchdog: wallet!.address, memory, error,
            report: report ?? { chainId, send: cfg.send, moduleEnabled: false, roleOk: false, wiringOk: false, actions: [], coverage: [], alerts: [], error: error ?? undefined },
          });
        } catch (e) {
          console.error("[payout-watchdog] heartbeat write failed", { chainId, error: e instanceof Error ? e.message : String(e) });
        }
        running = false;
      }
    };
    const first = setTimeout(() => void tick(), 25_000);
    first.unref?.();
    const timer = setInterval(() => void tick(), cfg.intervalMs);
    timer.unref?.();
  }
}
