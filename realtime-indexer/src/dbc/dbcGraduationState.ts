/**
 * DBC graduation keeper state machine. On-chain is the source of truth for
 * locker/migrate/withdraw. A pool Meteora already migrated skips those steps.
 */
export const VIRTUAL_POOL_DISCRIMINATOR = Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]);
export const CREATOR_WITHDRAW_BIT = 0b010;
export const PARTNER_WITHDRAW_BIT = 0b100;

export type GraduationStep =
  | "not_complete"
  | "locker"
  | "migrate"
  | "mark"
  | "withdraw"
  | "compensate"
  | "route"
  | "done";

export type PoolSnapshot = {
  isMigrated: number;
  migrationProgress: number;
  migrationFeeWithdrawStatus: number;
  quoteReserve: bigint;
  protocolMigrationQuoteFeeAmount: bigint;
  protocolMigrationBaseFeeAmount: bigint;
  creator: string;
  baseMint: string;
  config: string;
  quoteVault: string;
  baseVault: string;
};

export type ConfigSnapshot = {
  migrationQuoteThreshold: bigint;
  lockedVestingAmount: bigint;
  quoteMint: string;
};

export type JobSnapshot = {
  partnerFee: bigint | null;
  compensationPaid: boolean;
  routed: boolean;
  marked: boolean;
};

export function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (value == null) return 0n;
  if (typeof value === "object" && value && "toString" in value) return BigInt(String((value as { toString(): string }).toString()));
  return BigInt(String(value));
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    try {
      return Number((value as { toNumber(): number }).toNumber());
    } catch {
      return Number(String(value));
    }
  }
  return Number(value ?? 0);
}

function key(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: () => string }).toBase58 === "function") {
    return (value as { toBase58: () => string }).toBase58();
  }
  return String(value);
}

export function readPoolSnapshot(pool: Record<string, unknown> | null | undefined): PoolSnapshot | null {
  if (!pool) return null;
  const inner = (pool.poolState && typeof pool.poolState === "object" ? pool.poolState : pool) as Record<string, unknown>;
  return {
    isMigrated: num(inner.isMigrated ?? inner.is_migrated),
    migrationProgress: num(inner.migrationProgress ?? inner.migration_progress),
    migrationFeeWithdrawStatus: num(inner.migrationFeeWithdrawStatus ?? inner.migration_fee_withdraw_status),
    quoteReserve: big(inner.quoteReserve ?? inner.quote_reserve),
    protocolMigrationQuoteFeeAmount: big(inner.protocolMigrationQuoteFeeAmount ?? inner.protocol_migration_quote_fee_amount),
    protocolMigrationBaseFeeAmount: big(inner.protocolMigrationBaseFeeAmount ?? inner.protocol_migration_base_fee_amount),
    creator: key(inner.creator),
    baseMint: key(inner.baseMint ?? inner.base_mint),
    config: key(inner.config),
    quoteVault: key(inner.quoteVault ?? inner.quote_vault),
    baseVault: key(inner.baseVault ?? inner.base_vault),
  };
}

export function readConfigSnapshot(config: Record<string, unknown> | null | undefined): ConfigSnapshot | null {
  if (!config) return null;
  const inner = (config.poolConfig && typeof config.poolConfig === "object" ? config.poolConfig : config) as Record<string, unknown>;
  const vesting = (inner.lockedVestingConfig || inner.locked_vesting_config || {}) as Record<string, unknown>;
  // The pool config stores the schedule, not a total: amount_per_period x number_of_period +
  // cliff_unlock_amount (read from a devnet config 2026-09-29: 1,000,000 + 19,999,999,000,000 =
  // the 20M-token creator reserve). Reading a total field that does not exist gave 0, so the keeper
  // skipped createLocker and Meteora refused the migration (NotPermitToDoThisAction).
  const lockedVestingAmount =
    big(vesting.amountPerPeriod ?? vesting.amount_per_period) * big(vesting.numberOfPeriod ?? vesting.number_of_period)
    + big(vesting.cliffUnlockAmount ?? vesting.cliff_unlock_amount);
  return {
    migrationQuoteThreshold: big(inner.migrationQuoteThreshold ?? inner.migration_quote_threshold),
    lockedVestingAmount,
    quoteMint: key(inner.quoteMint ?? inner.quote_mint),
  };
}

export function curveComplete(pool: PoolSnapshot, config: ConfigSnapshot): boolean {
  return pool.isMigrated === 1 || pool.quoteReserve >= config.migrationQuoteThreshold;
}

export function partnerWithdrawn(pool: PoolSnapshot): boolean {
  return (pool.migrationFeeWithdrawStatus & PARTNER_WITHDRAW_BIT) !== 0;
}

export function creatorWithdrawn(pool: PoolSnapshot): boolean {
  return (pool.migrationFeeWithdrawStatus & CREATOR_WITHDRAW_BIT) !== 0;
}

export function lockerNeeded(pool: PoolSnapshot, config: ConfigSnapshot): boolean {
  return pool.isMigrated !== 1 && pool.migrationProgress === 1 && config.lockedVestingAmount > 0n;
}

/**
 * Next keeper action. Meteora-first (isMigrated) never asks for locker or migrate.
 * Mark as soon as the pool is migrated so the token page and DAMM indexer can
 * trade; money steps (withdraw / compensate / route) follow.
 */
export function nextGraduationStep(pool: PoolSnapshot, config: ConfigSnapshot, job: JobSnapshot): GraduationStep {
  if (!curveComplete(pool, config)) return "not_complete";
  if (pool.isMigrated !== 1) {
    if (lockerNeeded(pool, config)) return "locker";
    return "migrate";
  }
  if (!job.marked) return "mark";
  if (!partnerWithdrawn(pool)) return "withdraw";
  if (!job.compensationPaid) return "compensate";
  if (!job.routed) return "route";
  return "done";
}

export function solanaGraduationMeta(input: {
  dammPool: string;
  slot: number | string;
  quoteMint?: string;
  locker?: string | null;
  firstPositionNft?: string | null;
  secondPositionNft?: string | null;
}) {
  const slot = String(input.slot);
  const pool = String(input.dammPool);
  return {
    solanaGraduation: {
      dex: "meteora-damm-v2",
      pool,
      slot,
      quoteMint: input.quoteMint || "So11111111111111111111111111111111111111112",
    },
    dbcMigration: {
      pool,
      slot,
      positions: {
        creator: input.firstPositionNft || null,
        partner: input.secondPositionNft || null,
      },
      locker: input.locker || null,
    },
  };
}

export function jobFromRow(row: Record<string, unknown> | null | undefined): JobSnapshot {
  if (!row) {
    return { partnerFee: null, compensationPaid: false, routed: false, marked: false };
  }
  const step = String(row.step || "");
  const partnerFee = row.partner_fee == null ? null : big(row.partner_fee);
  return {
    partnerFee,
    compensationPaid: ["route", "done"].includes(step),
    routed: step === "done",
    marked: ["withdraw", "compensate", "route", "done"].includes(step),
  };
}
