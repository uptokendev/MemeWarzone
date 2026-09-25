import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

/**
 * Operator step: finalized Solana league epoch (weekly / monthly / quarterly)
 * -> on-chain set_league_epoch_root -> league_epoch_roots row.
 *
 *   npm run cron:publish-league-epoch-root
 *
 * Until this runs, claim_league fails with EpochNotSealed for the epoch and
 * the API keeps the prize as "root pending". Requires
 * SOLANA_REWARDS_TREASURY_PROGRAM_ID, SOLANA_RPC_URL (or
 * SOLANA_REWARDS_RPC_URL) and SOLANA_REWARD_POSTER_SECRET: the narrow reward
 * poster key (post_league_epoch_root), never the rewards authority, which can
 * also redirect the protocol route and the arena (founder, 2026-09-25).
 * Never overwrites a sealed epoch. Never publishes less than the winners are
 * owed: an epoch above the poster cap or above its vault is blocked and
 * reported, never shrunk. Weekly epochs pay from league_vault, monthly and
 * quarterly from monthly_league_vault.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { pool } from "../db.js";
import {
  buildMerkleRoot,
  deriveLeagueEpochPda,
  deriveLeaguePayoutVaultPda,
  deriveRewardPosterPda,
  deriveRewardsConfigPda,
  parseRewardPosterAccount,
  leagueLeaf,
  parseLeagueEpochAccount,
  periodCode,
  rootBytes,
  i64le,
  u64le,
} from "../rewards/solanaLeagueMerkle.js";

const MAINNET_CHAIN_ID = 101;
const PERIODS = ["weekly", "monthly", "quarterly"] as const;

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function posterKeypair(): Keypair {
  if (env("SOLANA_REWARDS_AUTHORITY_SECRET_KEY")) {
    console.warn("[publishLeagueEpochRoot] SOLANA_REWARDS_AUTHORITY_SECRET_KEY is set on this server and is IGNORED; remove it -- league roots use the reward poster");
  }
  const raw = env("SOLANA_REWARD_POSTER_SECRET");
  if (!raw) throw new Error("SOLANA_REWARD_POSTER_SECRET (the reward poster key) is required to publish a league epoch root");
  let bytes: Uint8Array;
  if (raw.startsWith("[")) bytes = Uint8Array.from(JSON.parse(raw).map(Number));
  else bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Solana reward poster key must decode to 32 or 64 bytes, got ${bytes.length}`);
}

function rpcUrl(chainId: number): string {
  return (
    env(`SOLANA_REWARDS_RPC_URL_${chainId}`) ||
    env(`SOLANA_RPC_URL_${chainId}`) ||
    env("SOLANA_REWARDS_RPC_URL") ||
    env("SOLANA_RPC_URL") ||
    env("SOLANA_RPC_HTTP")
  ).split(",").map((item) => item.trim()).find(Boolean) || "";
}

function programId(): PublicKey {
  const id = env("SOLANA_REWARDS_TREASURY_PROGRAM_ID");
  if (!id) throw new Error("SOLANA_REWARDS_TREASURY_PROGRAM_ID is required");
  return new PublicKey(id);
}

async function sendServerV0(connection: Connection, signer: Keypair, instruction: TransactionInstruction, label: string): Promise<string> {
  const compile = async () => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [instruction],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    return { transaction, latest };
  };
  const simulated = await compile();
  const simulation = await connection.simulateTransaction(simulated.transaction, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) {
    const logs = simulation.value.logs?.slice(-12).join("\n") || "";
    throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}${logs ? `\n${logs}` : ""}`);
  }
  const final = await compile();
  const signature = await connection.sendRawTransaction(final.transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...final.latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

type WinnerRow = { category: string; rank: number; recipient_address: string; amount_raw: string };

/** Same order the API uses when it builds claim proofs (frontend/api/league.js). */
async function winnersFor(chainId: number, period: string, epochStart: string): Promise<WinnerRow[]> {
  const { rows } = await pool.query(
    `select category, rank, recipient_address, amount_raw::text as amount_raw
       from public.league_epoch_winners
      where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz
      order by category asc, rank asc, recipient_address asc`,
    [chainId, period, epochStart],
  );
  return rows as WinnerRow[];
}

export function epochRootFor(epochStartSec: number, period: string, winners: WinnerRow[]) {
  let total = 0n;
  const leaves = winners.map((row) => {
    const amount = BigInt(String(row.amount_raw));
    total += amount;
    return leagueLeaf({
      epochStartSec,
      period,
      category: String(row.category || "").toLowerCase().trim(),
      rank: Number(row.rank),
      recipient: String(row.recipient_address || "").trim(),
      amountRaw: amount,
    });
  });
  return { root: buildMerkleRoot(leaves), total, leaves };
}

async function readEpochAccount(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address, "confirmed");
  return info ? parseLeagueEpochAccount(info.data) : null;
}

async function recordRoot(input: {
  chainId: number; period: string; epochStart: string; root: string; total: bigint; winners: number;
  epochAddress: string; txHash: string | null; metadata: Record<string, unknown>;
}) {
  await pool.query(
    `insert into public.league_epoch_roots
       (chain_id, period, epoch_start, root, total_lamports, winners, epoch_address, tx_hash, published_at, metadata)
     values ($1,$2,$3::timestamptz,$4,$5::numeric,$6,$7,$8,now(),$9::jsonb)
     on conflict (chain_id, period, epoch_start) do update
       set root=excluded.root, total_lamports=excluded.total_lamports, winners=excluded.winners,
           epoch_address=excluded.epoch_address, tx_hash=coalesce(excluded.tx_hash, public.league_epoch_roots.tx_hash),
           metadata=public.league_epoch_roots.metadata || excluded.metadata`,
    [input.chainId, input.period, input.epochStart, input.root, input.total.toString(), input.winners, input.epochAddress, input.txHash, JSON.stringify(input.metadata)],
  );
}

async function main() {
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  const limit = Math.max(1, Math.min(20, Number(process.env.PUBLISH_LEAGUE_ROOT_LIMIT || "5") || 5));
  console.log(`[publishLeagueEpochRoot] BUILD_SHA=${sha} chain=${MAINNET_CHAIN_ID} limit=${limit}`);

  // Finalized epochs (winners written, epoch over) without a published root.
  const { rows: candidates } = await pool.query(
    `select w.period, w.epoch_start, min(w.epoch_end) as epoch_end, count(*)::int as winners,
            coalesce(sum(w.amount_raw),0)::numeric(78,0)::text as total
       from public.league_epoch_winners w
       left join public.league_epoch_roots r
         on r.chain_id=w.chain_id and r.period=w.period and r.epoch_start=w.epoch_start
      where w.chain_id=$1
        and w.period = any($2::text[])
        and w.epoch_end <= now()
        and r.chain_id is null
      group by w.period, w.epoch_start
      order by w.epoch_start asc, w.period asc
      limit $3`,
    [MAINNET_CHAIN_ID, [...PERIODS], limit],
  );
  if (!candidates.length) {
    console.log(JSON.stringify({ ok: true, published: 0, note: "No finalized Solana league epoch without a root." }, null, 2));
    return;
  }

  const url = rpcUrl(MAINNET_CHAIN_ID);
  if (!url) throw new Error(`Solana RPC is not configured for chain ${MAINNET_CHAIN_ID}`);
  const connection = new Connection(url, { commitment: "confirmed", confirmTransactionInitialTimeout: 60_000 });
  const pid = programId();
  const signer = posterKeypair();
  const configAddress = deriveRewardsConfigPda(pid);
  const posterAddress = deriveRewardPosterPda(pid);
  const posterInfo = await connection.getAccountInfo(posterAddress, "confirmed");
  const posterState = posterInfo ? parseRewardPosterAccount(Buffer.from(posterInfo.data)) : null;
  if (!posterState) throw new Error(`reward poster ${posterAddress.toBase58()} is not initialized (scripts/solana/set-reward-poster.mjs)`);
  if (posterState.poster !== signer.publicKey.toBase58()) {
    throw new Error(`SOLANA_REWARD_POSTER_SECRET is ${signer.publicKey.toBase58()}, but the on-chain reward poster is ${posterState.poster}`);
  }
  const reports: Record<string, unknown>[] = [];
  const postedThisRun = new Set<string>();

  for (const candidate of candidates) {
    const period = String(candidate.period);
    const epochStartIso = new Date(candidate.epoch_start).toISOString();
    const epochStartSec = Math.floor(new Date(candidate.epoch_start).getTime() / 1000);
    const winners = await winnersFor(MAINNET_CHAIN_ID, period, epochStartIso);
    if (!winners.length) continue;
    const { root, total } = epochRootFor(epochStartSec, period, winners);
    const epochAddress = deriveLeagueEpochPda(pid, period, epochStartSec);
    const label = `${period} league epoch ${epochStartIso}`;

    if (total <= 0n) {
      reports.push({ period, epochStart: epochStartIso, status: "skipped", reason: "zero-total" });
      continue;
    }

    const existing = await readEpochAccount(connection, epochAddress);
    if (existing?.sealed) {
      if (existing.root.toLowerCase() !== root.toLowerCase() || existing.totalLamports !== total || existing.period !== periodCode(period)) {
        reports.push({
          period, epochStart: epochStartIso, status: "blocked", reason: "onchain-root-mismatch",
          onchain: { root: existing.root, total: existing.totalLamports.toString() }, computed: { root, total: total.toString() },
        });
        continue;
      }
      await recordRoot({
        chainId: MAINNET_CHAIN_ID, period, epochStart: epochStartIso, root, total, winners: winners.length,
        epochAddress: epochAddress.toBase58(), txHash: null, metadata: { source: "onchain-preexisting", recordedAt: new Date().toISOString() },
      });
      reports.push({ period, epochStart: epochStartIso, status: "recorded", reason: "already-sealed-on-chain", root, total: total.toString() });
      continue;
    }

    // Never publish less than the winners are owed: block and report instead of shrinking.
    if (total > posterState.maxLeagueLamports) {
      reports.push({
        period, epochStart: epochStartIso, status: "blocked", reason: "above-poster-cap",
        total: total.toString(), cap: posterState.maxLeagueLamports.toString(),
        action: "raise the league cap: node scripts/solana/set-reward-poster.mjs --league-cap-sol <n> --execute, then re-run",
      });
      continue;
    }
    // The poster may only post epochs that started within 120 days (program rule); older backlog is
    // reported for the authority to post by hand, never dropped.
    if (epochStartSec < Math.floor(Date.now() / 1000) - 120 * 86_400) {
      reports.push({ period, epochStart: epochStartIso, status: "blocked", reason: "older-than-120-days-needs-authority", total: total.toString() });
      continue;
    }
    // One root per period per run: the program enforces the rhythm (weekly 6d, monthly 25d, quarterly 80d).
    if (postedThisRun.has(period)) {
      reports.push({ period, epochStart: epochStartIso, status: "waiting", reason: "one-root-per-period-per-run" });
      continue;
    }
    const vaultAddress = deriveLeaguePayoutVaultPda(pid, period);
    const vaultInfo = await connection.getAccountInfo(vaultAddress, "confirmed");
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(vaultInfo?.data.length ?? 9));
    const vaultLamports = BigInt(vaultInfo?.lamports ?? 0);
    const spendable = vaultLamports > rent ? vaultLamports - rent : 0n;
    if (spendable < total) {
      reports.push({
        period, epochStart: epochStartIso, status: "blocked", reason: "league-vault-underfunded",
        vault: vaultAddress.toBase58(), spendable: spendable.toString(), total: total.toString(),
      });
      continue;
    }

    const instruction = new TransactionInstruction({
      programId: pid,
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configAddress, isSigner: false, isWritable: false },
        { pubkey: posterAddress, isSigner: false, isWritable: true },
        { pubkey: vaultAddress, isSigner: false, isWritable: false },
        { pubkey: epochAddress, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator("post_league_epoch_root"),
        Buffer.from([periodCode(period)]),
        i64le(epochStartSec),
        rootBytes(root),
        u64le(total),
      ]),
    });
    const txHash = await sendServerV0(connection, signer, instruction, `${label} root publication`);
    const confirmed = await readEpochAccount(connection, epochAddress);
    if (!confirmed?.sealed || confirmed.root.toLowerCase() !== root.toLowerCase() || confirmed.totalLamports !== total) {
      throw new Error(`${label} root publication confirmed but did not reconcile on-chain`);
    }
    await recordRoot({
      chainId: MAINNET_CHAIN_ID, period, epochStart: epochStartIso, root, total, winners: winners.length,
      epochAddress: epochAddress.toBase58(), txHash, metadata: { publishedAt: new Date().toISOString(), txHash },
    });
    postedThisRun.add(period);
    reports.push({ period, epochStart: epochStartIso, status: "published", root, total: total.toString(), winners: winners.length, txHash });
  }

  console.log(JSON.stringify({ ok: true, published: reports.filter((r) => r.status === "published").length, epochs: reports }, null, 2));
  if (reports.some((r) => r.status === "blocked")) process.exitCode = 2;
}

const diagnosticTimeoutMs = Math.max(60_000, Number(process.env.PUBLISH_LEAGUE_ROOT_TIMEOUT_MS || 180_000) || 180_000);
const watchdog = setTimeout(() => {
  console.error(`[publishLeagueEpochRoot] diagnostic timeout after ${diagnosticTimeoutMs}ms`);
  process.exit(1);
}, diagnosticTimeoutMs);

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error("[publishLeagueEpochRoot] failed", error);
    process.exit(1);
  });
