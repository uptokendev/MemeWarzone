/**
 * Route claimed DBC collector slices to the rewards treasury vaults.
 * One System-transfer transaction per run. Creator-pool amounts stay on the collector.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

export const TREASURY_PROGRAM_ID = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export function deriveRewardVault(seed: string, programId = TREASURY_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(programId))[0];
}

export function rewardVaults(programId = TREASURY_PROGRAM_ID) {
  return {
    leagueWeekly: deriveRewardVault("league_vault", programId),
    leagueMonthly: deriveRewardVault("monthly_league_vault", programId),
    recruiter: deriveRewardVault("recruiter_vault", programId),
    squad: deriveRewardVault("squad_vault", programId),
    airdrop: deriveRewardVault("airdrop_vault", programId),
    protocol: deriveRewardVault("protocol_vault", programId),
  };
}

export type RouteTotals = {
  leagueWeekly: bigint;
  leagueMonthly: bigint;
  recruiter: bigint;
  squad: bigint;
  airdrop: bigint;
  protocol: bigint;
  creatorPool: bigint;
  routed: bigint;
};

export function sumClaimedSlices(rows: Array<Record<string, unknown>>): RouteTotals {
  const read = (row: Record<string, unknown>, key: string) => BigInt(String(row[key] ?? 0));
  const totals: RouteTotals = {
    leagueWeekly: 0n, leagueMonthly: 0n, recruiter: 0n, squad: 0n, airdrop: 0n, protocol: 0n, creatorPool: 0n, routed: 0n,
  };
  for (const row of rows) {
    totals.leagueWeekly += read(row, "league_weekly");
    totals.leagueMonthly += read(row, "league_monthly");
    totals.recruiter += read(row, "recruiter");
    totals.squad += read(row, "squad");
    totals.airdrop += read(row, "airdrop");
    totals.protocol += read(row, "protocol");
    totals.creatorPool += read(row, "creator_pool");
  }
  totals.routed =
    totals.leagueWeekly + totals.leagueMonthly + totals.recruiter + totals.squad + totals.airdrop + totals.protocol;
  return totals;
}

export function buildRouteTransfers(input: {
  collector: PublicKey;
  totals: RouteTotals;
  vaults?: ReturnType<typeof rewardVaults>;
}): { instructions: ReturnType<typeof SystemProgram.transfer>[]; destinations: Array<{ seed: string; lamports: bigint; to: string }> } {
  const vaults = input.vaults || rewardVaults();
  const plan: Array<{ seed: string; lamports: bigint; to: PublicKey }> = [
    { seed: "league_vault", lamports: input.totals.leagueWeekly, to: vaults.leagueWeekly },
    { seed: "monthly_league_vault", lamports: input.totals.leagueMonthly, to: vaults.leagueMonthly },
    { seed: "recruiter_vault", lamports: input.totals.recruiter, to: vaults.recruiter },
    { seed: "squad_vault", lamports: input.totals.squad, to: vaults.squad },
    { seed: "airdrop_vault", lamports: input.totals.airdrop, to: vaults.airdrop },
    { seed: "protocol_vault", lamports: input.totals.protocol, to: vaults.protocol },
  ];
  const live = plan.filter((item) => item.lamports > 0n);
  return {
    instructions: live.map((item) => SystemProgram.transfer({
      fromPubkey: input.collector,
      toPubkey: item.to,
      lamports: Number(item.lamports),
    })),
    destinations: live.map((item) => ({ seed: item.seed, lamports: item.lamports, to: item.to.toBase58() })),
  };
}

export class CollectorShortError extends Error {
  constructor(public have: bigint, public need: bigint) {
    super(`DBC collector is short: have ${have.toString()} need ${need.toString()}`);
    this.name = "CollectorShortError";
  }
}

async function getTx(connection: Connection, signature: string) {
  for (let i = 0; i < 20; i += 1) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

export function nativeDelta(tx: any, pubkey: string): bigint {
  const message = tx?.transaction?.message;
  let keys: any[] = [];
  if (message && typeof message.getAccountKeys === "function") {
    try {
      keys = message.getAccountKeys().staticAccountKeys || [];
    } catch {
      keys = [];
    }
  }
  if (!keys.length) keys = message?.staticAccountKeys || message?.accountKeys || [];
  const keyStr = (entry: any) => (typeof entry === "string" ? entry : String(entry?.pubkey || entry?.toBase58?.() || ""));
  const want = typeof pubkey === "string" ? pubkey : String((pubkey as { toBase58?: () => string })?.toBase58?.() || pubkey);
  const index = keys.findIndex((entry: any) => keyStr(entry) === want);
  if (index < 0) return 0n;
  return BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
}

export async function routeClaimedAccruals(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  send: boolean;
  treasuryProgram?: string;
}): Promise<{ totals: RouteTotals; signature: string | null; destinations: Array<{ seed: string; lamports: bigint; to: string }>; skipped: string | null }> {
  const blocked = await input.db.query(
    `select 1 from public.dbc_fee_accruals where status = 'blocked' limit 1`,
  );
  if ((blocked.rowCount ?? blocked.rows.length) > 0) {
    return { totals: sumClaimedSlices([]), signature: null, destinations: [], skipped: "blocked-pool" };
  }
  const rows = await input.db.query(
    `select league_weekly, league_monthly, recruiter, squad, airdrop, protocol, creator_pool
       from public.dbc_fee_accruals where status = 'claimed'`,
  );
  const totals = sumClaimedSlices(rows.rows);
  if (totals.routed <= 0n) {
    return { totals, signature: null, destinations: [], skipped: "nothing-to-route" };
  }
  const vaults = rewardVaults(input.treasuryProgram);
  const built = buildRouteTransfers({ collector: input.collector.publicKey, totals, vaults });
  const have = BigInt(await input.connection.getBalance(input.collector.publicKey, "confirmed"));
  const rent = BigInt(await input.connection.getMinimumBalanceForRentExemption(0));
  if (have < totals.routed + rent) {
    throw new CollectorShortError(have, totals.routed + rent);
  }
  if (!input.send) {
    return { totals, signature: null, destinations: built.destinations, skipped: "dry-run" };
  }
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  for (const ix of built.instructions) tx.add(ix);
  tx.sign(input.collector);
  const signature = await input.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await getTx(input.connection, signature);
  if (!confirmed) {
    throw new Error(`DBC route transaction not readable: ${signature}`);
  }
  await input.db.query(
    `update public.dbc_fee_accruals set status = 'routed', route_signature = $1 where status = 'claimed'`,
    [signature],
  );
  return { totals, signature, destinations: built.destinations, skipped: null };
}
