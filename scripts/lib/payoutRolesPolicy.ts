/**
 * Permissions as code for the payout watchdog (founder, 2026-10-08: "Safe module: yes"). One Zodiac Roles v2.1.0
 * module per chain, owner = avatar = target = the treasury Safe, with ONE role, "payout-watchdog", that may make
 * exactly these calls in the Safe's name and nothing else:
 *
 *   CreatorRewardsVaultV2.approveHolderBatch(batchId, root, total)            on each listed vault (gen-6, gen-7)
 *     total <= the vault's weekly holder cap                                  (Roles: LessThan cap + 1)
 *   MwzCreatorChoiceVault.approveHolderBatch(batchId, root, total, claimDeadline)
 *                                                                              on each listed gen-8 vault only (selector 0xc62732bb;
 *                                                                              the 3-arg selector is never scoped on it)
 *     total <= that vault's cap; claimDeadline > 0 and <= a static bound      (the vault still binds the stored deadline)
 *   RewardDistributor.authorizeBatch on each listed gen-8 holder distributor  as for the gen-6 / gen-7 holder distributors
 *   RewardDistributor.authorizeBatch(batchId, maxAmount, publishAfter, publishDeadline)
 *                                                                             on each listed distributor (holder gen-6 /
 *                                                                             gen-7, airdrop main / gen-7)
 *     maxAmount <= that distributor's per-batch cap                           (Roles: LessThan cap + 1)
 *     the sum of maxAmount over time <= an allowance that refills one week    (Roles: WithinAllowance, own key per
 *     of authorizations per week and stops at maxWeeks weeks                   distributor)
 *   value 0 and call only (no delegatecall) on every one of them            (ExecutionOptions.None)
 *   every other target and every other function of a listed target          refused (scopeTarget = function clearance)
 *
 * What Roles cannot express and only the watchdog checks (docs/evm-launch/audit/PAYOUT_ROLES_MODULE.md):
 *   - that a batch id follows the deterministic formulas (keccak of a week string), and the publish window
 *     (publishDeadline - publishAfter = 6 days, publishAfter = the week's end): no arithmetic between parameters;
 *   - that a proposed holder root is the right one: the VAULT binds approval to the exact proposed root and total
 *     (approveHolderBatch reverts BadBatch otherwise), and the watchdog recomputes that root from chain data first.
 *
 * Pure: ethers only, no hardhat, so the policy table can be built and tested anywhere. The calls are PlannedCall
 * rows for scripts/lib/safeCallPlan.ts / scripts/make-safe-batch.ts, encoded from the compiled interfaces in
 * contracts/interfaces/zodiac/IZodiacRolesV2.sol.
 */
import { ethers } from "ethers";

export const PAYOUT_WATCHDOG_ROLE = "payout-watchdog";
/** Roles v2 role keys are bytes32; the SDK encodes a role name as a left-aligned UTF-8 string. */
export const PAYOUT_WATCHDOG_ROLE_KEY = ethers.encodeBytes32String(PAYOUT_WATCHDOG_ROLE);

/** Roles v2.1.0 contracts/Types.sol. */
export const ParamType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 } as const;
export const Operator = { Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualToAvatar: 15, EqualTo: 16, GreaterThan: 17, LessThan: 18, WithinAllowance: 28 } as const;
export const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 } as const;
/** Roles PermissionChecker.Status, for decoding ConditionViolation(status, info). */
export const ROLES_STATUS = [
  "Ok", "DelegateCallNotAllowed", "TargetAddressNotAllowed", "FunctionNotAllowed", "SendNotAllowed", "OrViolation", "NorViolation",
  "ParameterNotAllowed", "ParameterLessThanAllowed", "ParameterGreaterThanAllowed", "ParameterNotAMatch", "NotEveryArrayElementPasses",
  "NoArrayElementPasses", "ParameterNotSubsetOfAllowed", "BitmaskOverflow", "BitmaskNotAllowed", "CustomConditionViolation",
  "AllowanceExceeded", "CallAllowanceExceeded", "EtherAllowanceExceeded",
] as const;

export const APPROVE_HOLDER_BATCH = "approveHolderBatch(bytes32,bytes32,uint256)";
/** Gen-8 MwzCreatorChoiceVault. The last argument is claimDeadline. Gen-6 and gen-7 stay on the 3-arg selector. */
export const GEN8_APPROVE_HOLDER_BATCH = "approveHolderBatch(bytes32,bytes32,uint256,uint64)";
export const GEN8_APPROVE_SELECTOR = "0xc62732bb";
export const AUTHORIZE_BATCH = "authorizeBatch(bytes32,uint256,uint64,uint64)";

function gen8ApproveSelector(): string {
  const selector = ethers.id(GEN8_APPROVE_HOLDER_BATCH).slice(0, 10);
  if (selector !== GEN8_APPROVE_SELECTOR) throw new Error(`gen-8 approve selector ${selector} is not ${GEN8_APPROVE_SELECTOR}`);
  return selector;
}

export const SELECTOR = {
  approveHolderBatch: ethers.id(APPROVE_HOLDER_BATCH).slice(0, 10),
  approveGen8HolderBatch: gen8ApproveSelector(),
  authorizeBatch: ethers.id(AUTHORIZE_BATCH).slice(0, 10),
} as const;

export const WEEK_SECONDS = 604_800;
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * Addresses that may never hold the watchdog role: every other key with a money role on these chains (a leak of
 * one key must never give both roles), the deployer and the route authority. The deploy script adds the Safe, its
 * owners, the vault operators and the community vaults' airdrop operators, read on chain at run time.
 */
export const KNOWN_FORBIDDEN_WATCHDOGS: ReadonlyArray<{ address: string; label: string }> = [
  { address: "0x20652bdb1d986220fEc30f4733587F279403E773", label: "creator-choice vault operator" },
  { address: "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50", label: "airdrop / payout operator" },
  { address: "0xCB83b1297E4198e37bBf050eE9Cb6E87E8252aD1", label: "import payout operator (56)" },
  { address: "0x03F9deC9961033c0CaA7a66373B004D36D375e83", label: "import payout operator (4663)" },
  { address: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714", label: "EVM deployer" },
  { address: "0x13ad79765e14927df2c554d9662bbe539e89c8e8", label: "testnet deployer" },
  { address: "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA", label: "route authority" },
];

export type ConditionFlat = { parent: number; paramType: number; operator: number; compValue: string };

export type PolicyVault = { label: string; address: string; /** approveHolderBatch total cap (the vault's weekly holder cap). */ maxTotalWei: bigint };
/** Gen-8 only. maxTotalWei caps the third argument. claimDeadlineMax is a static Roles bound; the vault still requires the stored deadline. */
export type PolicyGen8Vault = { label: string; address: string; maxTotalWei: bigint; claimDeadlineMax: bigint };
export type PolicyDistributor = {
  label: string;
  kind: "holders" | "airdrop";
  address: string;
  /** authorizeBatch maxAmount cap per batch id. */
  capWei: bigint;
  /** Batch ids per week on this distributor (holders: 1; airdrop: 2, trader + creator). */
  idsPerWeek: number;
  /** The deterministic id scheme the watchdog follows on this distributor (documentation; not enforceable on chain). */
  scheme: string;
  /** Holder distributors: the batch-id program ("airdrop_holders", "airdrop_holders_gen7", "airdrop_holders_gen8"). */
  program?: string;
};
export type AllowancePlan = { maxWeeks: number; initialWeeks: number; periodSeconds?: number };
export type PayoutRolesPolicyInput = {
  chainId: number;
  safe: string;
  roles: string;
  watchdog: string;
  vaults: PolicyVault[];
  /** Optional. Scoped with selector 0xc62732bb. Omitted means the batch is the gen-6 / gen-7 batch exactly. */
  gen8Vaults?: PolicyGen8Vault[];
  distributors: PolicyDistributor[];
  allowance: AllowancePlan;
  /** Extra refused watchdog addresses (on-chain operators, Safe owners, the deploying key). */
  forbidden?: Array<{ address: string; label: string }>;
};
export type PlannedCall = { contract: string; to: string; fn: string; args: unknown[]; note?: string };
export type AllowanceRow = { distributor: string; label: string; key: string; balance: bigint; maxRefill: bigint; refill: bigint; period: number };
export type PermissionRow = { target: string; label: string; fn: string; selector: string; onChain: string[]; watchdogOnly: string[] };

const uint256Word = (v: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [v]);

function lessThanOrEqual(cap: bigint): string {
  if (cap <= 0n) throw new Error("a cap must be positive");
  if (cap >= 1n << 255n) throw new Error("a cap must be below 2^255");
  return uint256Word(cap + 1n); // Roles LessThan is strict: value < compValue
}

/** approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total): total <= maxTotal; id and root free (the vault binds them). */
export function approveHolderBatchConditions(maxTotalWei: bigint): ConditionFlat[] {
  return [
    { parent: 0, paramType: ParamType.Calldata, operator: Operator.Matches, compValue: "0x" },
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // batchId
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // root
    { parent: 0, paramType: ParamType.Static, operator: Operator.LessThan, compValue: lessThanOrEqual(maxTotalWei) }, // total
  ];
}

/**
 * Gen-8 approveHolderBatch(bytes32,bytes32,uint256,uint64). Roles cannot compare two calldata arguments, so the
 * deadline is only bounded: greater than 0 and at most claimDeadlineMax. The vault still reverts BadBatch unless
 * the deadline equals the one stored at propose.
 * Children of the And sit after the parameter siblings (parent index 4).
 */
export function approveGen8HolderBatchConditions(maxTotalWei: bigint, claimDeadlineMax: bigint): ConditionFlat[] {
  if (claimDeadlineMax <= 0n) throw new Error("claim deadline bound must be positive");
  if (claimDeadlineMax >= 1n << 64n) throw new Error("claim deadline bound must fit uint64");
  return [
    { parent: 0, paramType: ParamType.Calldata, operator: Operator.Matches, compValue: "0x" },
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // batchId
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // root
    { parent: 0, paramType: ParamType.Static, operator: Operator.LessThan, compValue: lessThanOrEqual(maxTotalWei) }, // total
    { parent: 0, paramType: ParamType.None, operator: Operator.And, compValue: "0x" }, // claimDeadline
    { parent: 4, paramType: ParamType.Static, operator: Operator.GreaterThan, compValue: uint256Word(0n) },
    { parent: 4, paramType: ParamType.Static, operator: Operator.LessThan, compValue: lessThanOrEqual(claimDeadlineMax) },
  ];
}

/**
 * authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline):
 * maxAmount <= cap AND maxAmount within the distributor's allowance. Breadth-first: 1..4 are the parameters,
 * 5..6 the two children of the And on maxAmount.
 */
export function authorizeBatchConditions(capWei: bigint, allowanceKey: string): ConditionFlat[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(allowanceKey)) throw new Error("allowance key must be bytes32");
  return [
    { parent: 0, paramType: ParamType.Calldata, operator: Operator.Matches, compValue: "0x" },
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // batchId
    { parent: 0, paramType: ParamType.None, operator: Operator.And, compValue: "0x" }, // maxAmount
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // publishAfter
    { parent: 0, paramType: ParamType.Static, operator: Operator.Pass, compValue: "0x" }, // publishDeadline
    { parent: 2, paramType: ParamType.Static, operator: Operator.LessThan, compValue: lessThanOrEqual(capWei) },
    { parent: 2, paramType: ParamType.Static, operator: Operator.WithinAllowance, compValue: allowanceKey.toLowerCase() },
  ];
}

/** One allowance per distributor, so a leak drains at most that distributor's own allowance. */
export function allowanceKeyFor(chainId: number, distributor: string): string {
  return ethers.id(`mwz-payout-watchdog:authorizeBatch:${Number(chainId)}:${ethers.getAddress(distributor).toLowerCase()}`);
}

/** Tuple rows for the ABI encoder and the Transaction Builder (ConditionFlat as [parent, paramType, operator, compValue]). */
export function conditionTuples(conditions: ConditionFlat[]): Array<[number, number, number, string]> {
  return conditions.map((c) => [c.parent, c.paramType, c.operator, c.compValue]);
}

export function allowancePlanFor(d: PolicyDistributor, plan: AllowancePlan, chainId: number): AllowanceRow {
  const maxWeeks = Math.floor(Number(plan.maxWeeks));
  const initialWeeks = Math.floor(Number(plan.initialWeeks));
  if (!(maxWeeks >= 1 && maxWeeks <= 26)) throw new Error("allowance maxWeeks must be 1..26");
  if (!(initialWeeks >= 0 && initialWeeks <= 26)) throw new Error("allowance initialWeeks must be 0..26");
  if (!Number.isInteger(d.idsPerWeek) || d.idsPerWeek < 1 || d.idsPerWeek > 4) throw new Error(`${d.label}: idsPerWeek must be 1..4`);
  const weekly = d.capWei * BigInt(d.idsPerWeek);
  const row: AllowanceRow = {
    distributor: ethers.getAddress(d.address),
    label: d.label,
    key: allowanceKeyFor(chainId, d.address),
    balance: weekly * BigInt(initialWeeks),
    maxRefill: weekly * BigInt(maxWeeks),
    refill: weekly,
    period: plan.periodSeconds ?? WEEK_SECONDS,
  };
  for (const v of [row.balance, row.maxRefill, row.refill]) if (v > MAX_UINT128) throw new Error(`${d.label}: allowance above uint128`);
  if (row.period <= 0) throw new Error("allowance period must be positive");
  return row;
}

/** Throws when `watchdog` is any refused address. */
export function assertWatchdogAllowed(watchdog: string, forbidden: Array<{ address: string; label: string }>): void {
  const w = ethers.getAddress(watchdog);
  if (w === ethers.ZeroAddress) throw new Error("watchdog address is zero");
  for (const f of forbidden) {
    if (ethers.getAddress(f.address) === w) throw new Error(`REFUSED: watchdog ${w} is the ${f.label}; the watchdog needs its own new key`);
  }
}

function permissionRows(input: PayoutRolesPolicyInput, allowances: AllowanceRow[]): PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const v of input.vaults) {
    rows.push({
      target: ethers.getAddress(v.address),
      label: `${v.label} CreatorRewardsVaultV2`,
      fn: APPROVE_HOLDER_BATCH,
      selector: SELECTOR.approveHolderBatch,
      onChain: [
        `total <= ${v.maxTotalWei} wei (Roles LessThan)`,
        "value 0, call only (Roles ExecutionOptions.None)",
        "batchId/root/total must equal a proposed, unvetoed, unexecuted batch exactly (vault: BadBatch)",
        "the Safe can still veto until execution (24 h window)",
      ],
      watchdogOnly: ["root and per-campaign amounts recomputed from chain data (census, allocation, merkle) before approving"],
    });
  }
  for (const v of input.gen8Vaults ?? []) {
    rows.push({
      target: ethers.getAddress(v.address),
      label: `${v.label} MwzCreatorChoiceVault`,
      fn: GEN8_APPROVE_HOLDER_BATCH,
      selector: SELECTOR.approveGen8HolderBatch,
      onChain: [
        `total <= ${v.maxTotalWei} wei (Roles LessThan)`,
        `claimDeadline > 0 and claimDeadline <= ${v.claimDeadlineMax} (Roles And)`,
        "value 0, call only (Roles ExecutionOptions.None)",
        "batchId, root, total and claimDeadline must equal the proposed batch exactly (vault: BadBatch)",
        "the 3-arg approveHolderBatch selector is not allowed on this vault",
      ],
      watchdogOnly: [
        "root, total, claim deadline and per-pool amounts recomputed from chain data with the shared hold-through rule (realtime-indexer payoutWatchdogGen8.ts verifyGen8HolderProposal: 4 secret checks, lowest balance, 0.01% at every check, census exclusions, merkle) before approving",
        "the batch id is holderBatchId(chain, last week, airdrop_holders_gen8) and the claim deadline is the configured window after executableAt",
      ],
    });
  }
  for (const d of input.distributors) {
    const a = allowances.find((x) => x.distributor === ethers.getAddress(d.address))!;
    rows.push({
      target: ethers.getAddress(d.address),
      label: `${d.label} RewardDistributor`,
      fn: AUTHORIZE_BATCH,
      selector: SELECTOR.authorizeBatch,
      onChain: [
        `maxAmount <= ${d.capWei} wei (Roles LessThan)`,
        `sum of maxAmount <= allowance ${a.key}: refill ${a.refill} wei per ${a.period} s, at most ${a.maxRefill} wei, starting at ${a.balance} wei (Roles WithinAllowance)`,
        "value 0, call only (Roles ExecutionOptions.None)",
        "consumed or already-created ids refused (distributor: BatchAuthConsumed / BatchExists)",
      ],
      watchdogOnly: [
        `batch id follows ${d.scheme}`,
        "publishAfter = the week's end, publishDeadline = publishAfter + 6 days",
        "never re-authorizes an id the Safe revoked, an authorized id, or a past week",
      ],
    });
  }
  return rows;
}

/**
 * The whole Safe batch for one chain, in order: scope each vault's approveHolderBatch, then per distributor its
 * allowance and authorizeBatch scope, then the role to the watchdog, then Safe.enableModule(roles) last (the module
 * can do nothing until every scope is in place, and nothing at all until this last call).
 */
export function buildPayoutRolesPolicy(input: PayoutRolesPolicyInput): {
  roleKey: string;
  calls: PlannedCall[];
  allowances: AllowanceRow[];
  table: PermissionRow[];
} {
  const safe = ethers.getAddress(input.safe);
  const roles = ethers.getAddress(input.roles);
  const watchdog = ethers.getAddress(input.watchdog);
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw new Error("chainId required");
  if (!input.vaults.length && !(input.gen8Vaults ?? []).length && !input.distributors.length) throw new Error("no targets");
  assertWatchdogAllowed(watchdog, [
    ...KNOWN_FORBIDDEN_WATCHDOGS,
    ...(input.forbidden ?? []),
    { address: safe, label: "Safe" },
    { address: roles, label: "Roles module" },
  ]);
  const seen = new Set<string>([safe, roles, watchdog].map((a) => a.toLowerCase()));
  const take = (address: string, label: string) => {
    const a = ethers.getAddress(address);
    if (a === ethers.ZeroAddress) throw new Error(`${label}: zero address`);
    if (seen.has(a.toLowerCase())) throw new Error(`${label} ${a} is listed twice or is the Safe / module / watchdog`);
    seen.add(a.toLowerCase());
    return a;
  };
  const calls: PlannedCall[] = [];
  for (const v of input.vaults) {
    const to = take(v.address, v.label);
    calls.push({ contract: "IZodiacRolesV2", to: roles, fn: "scopeTarget", args: [PAYOUT_WATCHDOG_ROLE_KEY, to], note: `${v.label} vault: function-level clearance` });
    calls.push({
      contract: "IZodiacRolesV2",
      to: roles,
      fn: "scopeFunction",
      args: [PAYOUT_WATCHDOG_ROLE_KEY, to, SELECTOR.approveHolderBatch, conditionTuples(approveHolderBatchConditions(v.maxTotalWei)), ExecutionOptions.None],
      note: `${v.label} vault: approveHolderBatch, total <= ${ethers.formatEther(v.maxTotalWei)}`,
    });
  }
  for (const v of input.gen8Vaults ?? []) {
    const to = take(v.address, v.label);
    if (v.maxTotalWei <= 0n) throw new Error(`${v.label}: cap must be positive`);
    calls.push({ contract: "IZodiacRolesV2", to: roles, fn: "scopeTarget", args: [PAYOUT_WATCHDOG_ROLE_KEY, to], note: `${v.label} vault: function-level clearance` });
    calls.push({
      contract: "IZodiacRolesV2",
      to: roles,
      fn: "scopeFunction",
      args: [PAYOUT_WATCHDOG_ROLE_KEY, to, SELECTOR.approveGen8HolderBatch, conditionTuples(approveGen8HolderBatchConditions(v.maxTotalWei, v.claimDeadlineMax)), ExecutionOptions.None],
      note: `${v.label} vault: approveHolderBatch(bytes32,bytes32,uint256,uint64) selector ${SELECTOR.approveGen8HolderBatch}, total <= ${ethers.formatEther(v.maxTotalWei)}, claimDeadline <= ${v.claimDeadlineMax}`,
    });
  }
  const allowances: AllowanceRow[] = [];
  for (const d of input.distributors) {
    const to = take(d.address, d.label);
    if (d.capWei <= 0n) throw new Error(`${d.label}: cap must be positive`);
    const a = allowancePlanFor(d, input.allowance, input.chainId);
    allowances.push(a);
    calls.push({ contract: "IZodiacRolesV2", to: roles, fn: "scopeTarget", args: [PAYOUT_WATCHDOG_ROLE_KEY, to], note: `${d.label} distributor: function-level clearance` });
    calls.push({
      contract: "IZodiacRolesV2",
      to: roles,
      fn: "setAllowance",
      args: [a.key, a.balance.toString(), a.maxRefill.toString(), a.refill.toString(), String(a.period), "0"],
      note: `${d.label} distributor allowance: ${ethers.formatEther(a.refill)} per week, max ${ethers.formatEther(a.maxRefill)}, start ${ethers.formatEther(a.balance)}`,
    });
    calls.push({
      contract: "IZodiacRolesV2",
      to: roles,
      fn: "scopeFunction",
      args: [PAYOUT_WATCHDOG_ROLE_KEY, to, SELECTOR.authorizeBatch, conditionTuples(authorizeBatchConditions(d.capWei, a.key)), ExecutionOptions.None],
      note: `${d.label} distributor: authorizeBatch, maxAmount <= ${ethers.formatEther(d.capWei)} within the allowance`,
    });
  }
  calls.push({ contract: "IZodiacRolesV2", to: roles, fn: "assignRoles", args: [watchdog, [PAYOUT_WATCHDOG_ROLE_KEY], [true]], note: `role ${PAYOUT_WATCHDOG_ROLE} to the watchdog` });
  calls.push({ contract: "ISafeModuleManager", to: safe, fn: "enableModule", args: [roles], note: "the Safe enables the Roles module (last)" });
  return { roleKey: PAYOUT_WATCHDOG_ROLE_KEY, calls, allowances, table: permissionRows(input, allowances) };
}

export const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001";

/** The Safe's disableModule(prevModule, module) call for `roles`, from the Safe's current module list (linked list order). */
export function disableModuleCall(safe: string, modules: string[], roles: string): PlannedCall {
  const list = modules.map((m) => ethers.getAddress(m));
  const i = list.indexOf(ethers.getAddress(roles));
  if (i < 0) throw new Error(`${roles} is not an enabled module of ${safe}`);
  const prev = i === 0 ? SENTINEL_MODULES : list[i - 1];
  return { contract: "ISafeModuleManager", to: ethers.getAddress(safe), fn: "disableModule", args: [prev, ethers.getAddress(roles)], note: "the Safe disables the payout watchdog's Roles module" };
}

/** Roles.setUp initializer and the ModuleProxyFactory CREATE2 address of the proxy it deploys. */
export function rolesProxyPlan(input: { factory: string; mastercopy: string; safe: string; saltNonce: bigint }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const safe = ethers.getAddress(input.safe);
  const initParams = coder.encode(["address", "address", "address"], [safe, safe, safe]);
  const initializer = new ethers.Interface(["function setUp(bytes initParams)"]).encodeFunctionData("setUp", [initParams]);
  const salt = ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [ethers.keccak256(initializer), input.saltNonce]));
  const deployment = ethers.concat(["0x602d8060093d393df3363d3d373d3d3d363d73", ethers.getAddress(input.mastercopy), "0x5af43d82803e903d91602b57fd5bf3"]);
  const proxy = ethers.getCreate2Address(ethers.getAddress(input.factory), salt, ethers.keccak256(deployment));
  return { initializer, salt, proxy, proxyRuntime: ethers.hexlify(ethers.getBytes(deployment).slice(9)) };
}

/** Robinhood testnet gen-8 choice vault. The Roles file below is for the founder. Nothing in this repo sends it. */
export const RH_TESTNET_GEN8_CHOICE_VAULT = "0x13537C6273dF312067cE775AAf9635c217A931fd";
/** Weekly holder cap set on that vault (deployments/robinhood/testnet.gen8.json on build/evm-gen8). */
export const RH_TESTNET_GEN8_HOLDER_CAP_WEI = 9_300_000_000_000_000_000n;
/** Every uint64. Roles rejects 0. The vault still enforces the 7-day minimum and the 365-day maximum. */
export const GEN8_CLAIM_DEADLINE_ROLES_MAX = (1n << 64n) - 1n;

/**
 * The Safe Roles scope for one gen-8 vault. `applied` is false: the founder sends scopeTarget and scopeFunction.
 * `to` is null until PAYOUT_WATCHDOG_ROLES_<chainId> exists. The 3-arg selector is not in this file.
 */
export function gen8RolesPolicyFile(input: {
  chainId: number;
  vault: string;
  maxTotalWei: bigint;
  claimDeadlineMax?: bigint;
}): {
  applied: false;
  executes: false;
  chainId: number;
  vault: string;
  signature: string;
  selector: string;
  maxTotalWei: string;
  claimDeadlineMax: string;
  conditions: ConditionFlat[];
  calls: Array<{ contract: string; to: null; fn: string; args: unknown[]; note: string }>;
  note: string;
} {
  const claimDeadlineMax = input.claimDeadlineMax ?? GEN8_CLAIM_DEADLINE_ROLES_MAX;
  const vault = ethers.getAddress(input.vault);
  const conditions = approveGen8HolderBatchConditions(input.maxTotalWei, claimDeadlineMax);
  const note = "Founder applies these two calls on the chain Roles module (PAYOUT_WATCHDOG_ROLES_<chainId> is the `to`). Do not send this file from a worker. Gen-6 and gen-7 keep approveHolderBatch(bytes32,bytes32,uint256). The vault still requires the stored claim deadline.";
  return {
    applied: false,
    executes: false,
    chainId: input.chainId,
    vault,
    signature: GEN8_APPROVE_HOLDER_BATCH,
    selector: SELECTOR.approveGen8HolderBatch,
    maxTotalWei: input.maxTotalWei.toString(),
    claimDeadlineMax: claimDeadlineMax.toString(),
    conditions,
    calls: [
      {
        contract: "IZodiacRolesV2",
        to: null,
        fn: "scopeTarget",
        args: [PAYOUT_WATCHDOG_ROLE_KEY, vault],
        note: "function-level clearance on the gen-8 choice vault",
      },
      {
        contract: "IZodiacRolesV2",
        to: null,
        fn: "scopeFunction",
        args: [PAYOUT_WATCHDOG_ROLE_KEY, vault, SELECTOR.approveGen8HolderBatch, conditionTuples(conditions), ExecutionOptions.None],
        note: `selector ${SELECTOR.approveGen8HolderBatch}; total <= ${input.maxTotalWei}; claimDeadline > 0 and <= ${claimDeadlineMax}; value 0; call only`,
      },
    ],
    note,
  };
}

/** Decodes a Roles revert (ConditionViolation status name, NoMembership, ...) for logs and alerts. */
export function rolesRevertName(data: string | null | undefined, rolesAbi: ethers.InterfaceAbi): string | null {
  if (!data || typeof data !== "string" || data.length < 10) return null;
  try {
    const parsed = new ethers.Interface(rolesAbi).parseError(data);
    if (!parsed) return null;
    if (parsed.name === "ConditionViolation") return `ConditionViolation(${ROLES_STATUS[Number(parsed.args[0])] ?? parsed.args[0]})`;
    return parsed.name;
  } catch {
    return null;
  }
}
