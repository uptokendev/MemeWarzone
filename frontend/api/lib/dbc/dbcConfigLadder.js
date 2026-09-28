/**
 * Create a DBC launch config on chain (or return the active row) for one ladder key.
 */
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC_QUOTE_MINT } from "../../../shared/dbcEconomics.mjs";
import { SOLANA_GENESIS } from "../../../src/lib/solanaArenaLayout.mjs";
import { buildLaunchConfigParams } from "./dbcLaunchConfigParams.mjs";

const NATIVE_MINT = new PublicKey(DBC_QUOTE_MINT);

export function parseInlineKeypair(raw, name) {
  const text = String(raw || "").trim();
  if (!text) throw Object.assign(new Error(`${name} is required`), { code: "DBC_PAYER_MISSING" });
  const parsed = JSON.parse(text);
  const bytes = Uint8Array.from(parsed);
  if (bytes.length !== 64) throw Object.assign(new Error(`${name} must be a 64-byte JSON keypair`), { code: "DBC_PAYER_BAD" });
  return Keypair.fromSecretKey(bytes);
}

export function requiredCluster(env = process.env) {
  const cluster = String(env.SOLANA_CLUSTER || "").trim();
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw Object.assign(new Error("SOLANA_CLUSTER must be devnet or mainnet-beta"), { code: "DBC_CLUSTER_UNCONFIGURED" });
  }
  return cluster;
}

export async function assertRpcCluster({ connection, cluster }) {
  const genesis = await connection.getGenesisHash();
  const expected = SOLANA_GENESIS[cluster];
  if (genesis !== expected) {
    throw Object.assign(
      new Error(`RPC genesis ${genesis} does not match SOLANA_CLUSTER=${cluster}`),
      { code: "DBC_CLUSTER_MISMATCH", genesis, cluster },
    );
  }
  return genesis;
}

function lockKey({ cluster, quoteMint, targetUsdMicros, stepIndex, creatorFeeMode, paramsHash }) {
  return `dbc-launch-config:${cluster}:${quoteMint}:${targetUsdMicros}:${stepIndex}:${creatorFeeMode}:${paramsHash}`;
}

function bnish(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value.toString === "function") return value.toString();
  return String(value);
}

function pub(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  return String(value);
}

function curvePoints(curve) {
  return (curve || []).map((pt) => ({
    sqrtPrice: bnish(pt.sqrtPrice),
    liquidity: bnish(pt.liquidity),
  }));
}

export function expectedOnChainFields(configParams, { feeClaimer, leftoverReceiver, quoteMint } = {}) {
  const fee = configParams.poolFees.baseFee;
  return {
    quoteMint: pub(quoteMint || NATIVE_MINT),
    feeClaimer: pub(feeClaimer),
    leftoverReceiver: pub(leftoverReceiver),
    collectFeeMode: Number(configParams.collectFeeMode),
    migrationOption: Number(configParams.migrationOption),
    activationType: Number(configParams.activationType),
    tokenDecimal: Number(configParams.tokenDecimal),
    tokenType: Number(configParams.tokenType),
    partnerPermanentLockedLiquidityPercentage: Number(configParams.partnerPermanentLockedLiquidityPercentage),
    partnerLiquidityPercentage: Number(configParams.partnerLiquidityPercentage),
    creatorPermanentLockedLiquidityPercentage: Number(configParams.creatorPermanentLockedLiquidityPercentage),
    creatorLiquidityPercentage: Number(configParams.creatorLiquidityPercentage),
    creatorTradingFeePercentage: Number(configParams.creatorTradingFeePercentage),
    tokenUpdateAuthority: Number(configParams.tokenUpdateAuthority),
    migrationFeePercentage: Number(configParams.migrationFee.feePercentage),
    creatorMigrationFeePercentage: Number(configParams.migrationFee.creatorFeePercentage),
    migrationQuoteThreshold: bnish(configParams.migrationQuoteThreshold),
    sqrtStartPrice: bnish(configParams.sqrtStartPrice),
    preMigrationTokenSupply: bnish(configParams.tokenSupply.preMigrationTokenSupply),
    postMigrationTokenSupply: bnish(configParams.tokenSupply.postMigrationTokenSupply),
    migratedCollectFeeMode: Number(configParams.migratedPoolFee.collectFeeMode),
    migratedDynamicFee: Number(configParams.migratedPoolFee.dynamicFee),
    migratedPoolFeeBps: Number(configParams.migratedPoolFee.poolFeeBps),
    enableFirstSwapWithMinFee: Number(configParams.enableFirstSwapWithMinFee) ? 1 : 0,
    poolCreationFee: bnish(configParams.poolCreationFee),
    cliffFeeNumerator: bnish(fee.cliffFeeNumerator),
    firstFactor: Number(fee.firstFactor),
    secondFactor: bnish(fee.secondFactor),
    thirdFactor: bnish(fee.thirdFactor),
    baseFeeMode: Number(fee.baseFeeMode),
    lockedVesting: {
      amountPerPeriod: bnish(configParams.lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: bnish(configParams.lockedVesting.cliffDurationFromMigrationTime),
      frequency: bnish(configParams.lockedVesting.frequency),
      numberOfPeriod: bnish(configParams.lockedVesting.numberOfPeriod),
      cliffUnlockAmount: bnish(configParams.lockedVesting.cliffUnlockAmount),
    },
    curve: curvePoints(configParams.curve),
  };
}

export function readOnChainFields(onChain) {
  const fee = onChain.poolFees?.baseFee || {};
  const vesting = onChain.lockedVestingConfig || onChain.lockedVesting || {};
  return {
    quoteMint: pub(onChain.quoteMint),
    feeClaimer: pub(onChain.feeClaimer),
    leftoverReceiver: pub(onChain.leftoverReceiver),
    collectFeeMode: Number(onChain.collectFeeMode),
    migrationOption: Number(onChain.migrationOption),
    activationType: Number(onChain.activationType),
    tokenDecimal: Number(onChain.tokenDecimal),
    tokenType: Number(onChain.tokenType),
    partnerPermanentLockedLiquidityPercentage: Number(onChain.partnerPermanentLockedLiquidityPercentage),
    partnerLiquidityPercentage: Number(onChain.partnerLiquidityPercentage),
    creatorPermanentLockedLiquidityPercentage: Number(onChain.creatorPermanentLockedLiquidityPercentage),
    creatorLiquidityPercentage: Number(onChain.creatorLiquidityPercentage),
    creatorTradingFeePercentage: Number(onChain.creatorTradingFeePercentage),
    tokenUpdateAuthority: Number(onChain.tokenUpdateAuthority),
    migrationFeePercentage: Number(onChain.migrationFeePercentage),
    creatorMigrationFeePercentage: Number(onChain.creatorMigrationFeePercentage),
    migrationQuoteThreshold: bnish(onChain.migrationQuoteThreshold),
    sqrtStartPrice: bnish(onChain.sqrtStartPrice),
    preMigrationTokenSupply: bnish(onChain.preMigrationTokenSupply),
    postMigrationTokenSupply: bnish(onChain.postMigrationTokenSupply),
    migratedCollectFeeMode: Number(onChain.migratedCollectFeeMode ?? onChain.migratedPoolFee?.collectFeeMode),
    migratedDynamicFee: Number(onChain.migratedDynamicFee ?? onChain.migratedPoolFee?.dynamicFee),
    migratedPoolFeeBps: Number(onChain.migratedPoolFeeBps ?? onChain.migratedPoolFee?.poolFeeBps),
    enableFirstSwapWithMinFee: Number(onChain.enableFirstSwapWithMinFee) ? 1 : 0,
    poolCreationFee: bnish(onChain.poolCreationFee),
    cliffFeeNumerator: bnish(fee.cliffFeeNumerator),
    firstFactor: Number(fee.firstFactor),
    secondFactor: bnish(fee.secondFactor),
    thirdFactor: bnish(fee.thirdFactor),
    baseFeeMode: Number(fee.baseFeeMode),
    lockedVesting: {
      amountPerPeriod: bnish(vesting.amountPerPeriod),
      cliffDurationFromMigrationTime: bnish(vesting.cliffDurationFromMigrationTime),
      frequency: bnish(vesting.frequency),
      numberOfPeriod: bnish(vesting.numberOfPeriod),
      cliffUnlockAmount: bnish(vesting.cliffUnlockAmount),
    },
    curve: curvePoints(onChain.curve),
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every((key) => deepEqual(a[key], b[key]));
  }
  return String(a) === String(b);
}

export function diffOnChainConfig(onChain, configParams, extra) {
  const got = readOnChainFields(onChain);
  const want = expectedOnChainFields(configParams, extra);
  const mismatches = [];
  function walk(path, a, b) {
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) walk(path ? `${path}.${key}` : key, a[key], b[key]);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        mismatches.push({ path, got: `len ${a.length}`, want: `len ${b.length}` });
        return;
      }
      a.forEach((item, i) => walk(`${path}[${i}]`, item, b[i]));
      return;
    }
    if (!deepEqual(a, b)) mismatches.push({ path, got: a, want: b });
  }
  walk("", got, want);
  return mismatches;
}

function defaultSendTransaction(connection, tx, signers) {
  return connection.sendTransaction(tx, signers, { skipPreflight: false });
}

export function createDbcConfigLadder(deps = {}) {
  const {
    db,
    connection: givenConnection,
    rpcUrl,
    payer: givenPayer,
    feeClaimer: givenFeeClaimer,
    cluster: givenCluster,
    client: givenClient,
    sendTransaction = defaultSendTransaction,
    confirmTransaction,
    now = () => new Date(),
    env = process.env,
  } = deps;

  function cluster() {
    return givenCluster || requiredCluster(env);
  }

  function connection() {
    if (givenConnection) return givenConnection;
    const url = rpcUrl || env.SOLANA_RPC_URL || env.SOLANA_RPC_HTTP;
    if (!url) throw Object.assign(new Error("SOLANA_RPC_URL is required"), { code: "DBC_RPC_MISSING" });
    return new Connection(url, "confirmed");
  }

  function payer() {
    if (givenPayer) return givenPayer;
    return parseInlineKeypair(env.DBC_CONFIG_PAYER_SECRET, "DBC_CONFIG_PAYER_SECRET");
  }

  function feeClaimer() {
    if (givenFeeClaimer) return givenFeeClaimer instanceof PublicKey ? givenFeeClaimer : new PublicKey(givenFeeClaimer);
    const raw = String(env.DBC_FEE_COLLECTOR || "").trim();
    if (!raw) throw Object.assign(new Error("DBC_FEE_COLLECTOR is required"), { code: "DBC_FEE_COLLECTOR_MISSING" });
    return new PublicKey(raw);
  }

  async function query(text, params) {
    return db.query(text, params);
  }

  async function withLock(key, fn) {
    const client = db.connect ? await db.connect() : null;
    const q = client ? client.query.bind(client) : query;
    let settled = false;
    try {
      if (client) await q("begin");
      await q("select pg_advisory_xact_lock(hashtext($1))", [key]);
      const ctx = {
        query: q,
        async commit() {
          if (client && !settled) {
            await q("commit");
            settled = true;
          }
        },
      };
      const result = await fn(ctx);
      if (client && !settled) {
        await q("commit");
        settled = true;
      }
      return result;
    } catch (error) {
      if (client && !settled) await q("rollback").catch(() => {});
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async function ensureLaunchConfig({ targetUsdMicros, stepIndex, stepUsdMicros, creatorFeeMode }) {
    const built = buildLaunchConfigParams(targetUsdMicros, stepUsdMicros, creatorFeeMode);
    const net = cluster();
    const quoteMint = DBC_QUOTE_MINT;
    const key = {
      cluster: net,
      quoteMint,
      targetUsdMicros: BigInt(targetUsdMicros).toString(),
      stepIndex: Number(stepIndex),
      creatorFeeMode,
      paramsHash: built.paramsHash,
    };

    return withLock(lockKey(key), async ({ query: q, commit }) => {
      const existing = await q(
        `select * from public.dbc_launch_configs
          where cluster = $1 and quote_mint = $2 and target_usd_micros = $3
            and step_index = $4 and creator_fee_mode = $5 and params_hash = $6
          limit 1`,
        [key.cluster, key.quoteMint, key.targetUsdMicros, key.stepIndex, key.creatorFeeMode, key.paramsHash],
      );
      const row0 = existing.rows[0];
      if (row0?.status === "active") return mapRow(row0, built);
      if (row0?.status === "failed" || row0?.status === "pending") {
        throw Object.assign(
          new Error("This DBC launch config failed on-chain readback and will not be created again until an operator clears it."),
          { code: "DBC_CONFIG_FAILED" },
        );
      }

      const conn = connection();
      await assertRpcCluster({ connection: conn, cluster: net });
      const pay = payer();
      const collector = feeClaimer();
      const configKp = Keypair.generate();
      const client = givenClient || new DynamicBondingCurveClient(conn, "confirmed");

      const tx = await client.partner.createConfig({
        config: configKp.publicKey,
        feeClaimer: collector,
        leftoverReceiver: collector,
        quoteMint: NATIVE_MINT,
        payer: pay.publicKey,
        ...built.configParams,
      });
      tx.feePayer = pay.publicKey;
      const sig = await sendTransaction(conn, tx, [pay, configKp]);
      const inserted = await q(
        `insert into public.dbc_launch_configs (
            cluster, quote_mint, target_usd_micros, step_index, step_usd_micros,
            creator_fee_mode, params_hash, config_address, threshold_lamports,
            total_token_supply, create_signature, status, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
          returning *`,
        [
          key.cluster, key.quoteMint, key.targetUsdMicros, key.stepIndex, stepUsdMicros.toString(),
          key.creatorFeeMode, key.paramsHash, configKp.publicKey.toBase58(),
          built.expected.thresholdLamports.toString(), built.expected.totalTokenSupply.toString(),
          sig, now().toISOString(),
        ],
      );
      const row = inserted.rows[0];
      try {
        if (confirmTransaction) await confirmTransaction(conn, sig);
        else await conn.confirmTransaction(sig, "confirmed");
      } catch (error) {
        await q(`update public.dbc_launch_configs set status = 'failed' where id = $1`, [row.id]);
        await commit();
        throw Object.assign(error, { code: error.code || "DBC_CONFIG_FAILED" });
      }

      const onChain = await client.state.getPoolConfig(configKp.publicKey);
      if (!onChain) {
        await q(`update public.dbc_launch_configs set status = 'failed' where id = $1`, [row.id]);
        await commit();
        throw Object.assign(new Error("DBC config missing after create"), { code: "DBC_CONFIG_FAILED" });
      }
      const mismatches = diffOnChainConfig(onChain, built.configParams, {
        feeClaimer: collector,
        leftoverReceiver: collector,
        quoteMint: NATIVE_MINT,
      });
      if (mismatches.length) {
        await q(
          `update public.dbc_launch_configs set status = 'failed', create_signature = $2 where id = $1`,
          [row.id, sig],
        );
        await commit();
        throw Object.assign(new Error("on-chain DBC config does not match expected params"), {
          code: "DBC_CONFIG_MISMATCH",
          mismatches,
        });
      }
      const updated = await q(
        `update public.dbc_launch_configs
            set status = 'active', create_signature = $2, verified_at = $3
          where id = $1
          returning *`,
        [row.id, sig, now().toISOString()],
      );
      return mapRow(updated.rows[0], built);
    });
  }

  return { ensureLaunchConfig, buildLaunchConfigParams };
}

function mapRow(row, built) {
  return {
    ...built,
    row,
    configAddress: row.config_address,
    createSignature: row.create_signature,
    status: row.status,
  };
}

let defaultLadder = null;
export function defaultDbcConfigLadder(deps) {
  if (deps) return createDbcConfigLadder(deps);
  if (!defaultLadder) {
    throw Object.assign(new Error("DBC config ladder is not configured"), { code: "DBC_LADDER_UNCONFIGURED" });
  }
  return defaultLadder;
}

export function setDefaultDbcConfigLadder(ladder) {
  defaultLadder = ladder;
}
