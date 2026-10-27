/**
 * Gen-8 creator-choice operator end to end on a LOCAL chain (anvil, chain 97, no fork; nothing touches a public
 * network) with the production gen-8 contracts and a throwaway Postgres 16: a holders coin, a split coin and a buyback
 * coin; wallets trade across a simulated week (time travel); the real ingest and census run, then the operator pass
 * through all four hold-through checks and the Monday run. Asserts the leaf file (a steady holder paid, a dipper paid on
 * its lowest balance, a flipper / a below-0.01% wallet / a late buyer not paid, the creator and the pool not paid), the
 * proposal on chain; then the local Safe approves (4 args) and authorizes on the distributor, 24 h pass, the pass
 * executes and a holder claims with the published proof; a buyback burns to 0xdEaD; a crash after recording a job
 * (before its broadcast) is resolved on restart with the same signed bytes and no second send.
 * Skips when the artifacts, anvil or Postgres 16 are missing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { artifactsAvailable, deployArtifact, deployGen8Local, launchCoin, startAnvil, swap, wallets, fund, WAD } from "./gen8/gen8LocalChain.js";
import { gen8SchemaFiles } from "./gen8/gen8TestDb.js";

const PG16 = "/usr/lib/postgresql/16/bin";
const runnable = artifactsAvailable() && fs.existsSync(`${PG16}/initdb`);
const DEAD = "0x000000000000000000000000000000000000dEaD";
const WEEK = 7 * 86_400;

test("gen-8 creator-choice operator end to end on a local chain", { skip: runnable ? false : "gen-8 artifacts, anvil or Postgres 16 missing", timeout: 900_000 }, async () => {
  process.env.DBC_PG_BIN = PG16;
  process.env.RUNTIME_ENVIRONMENT = "local";
  process.env.PG_DISABLE_SSL = "1";
  const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
  const mig = "db/migrations/20261022_000001_evm_gen8_choice.sql";
  const pg = await startThrowawayPostgres({
    port: Number(process.env.DBC_THROWAY_PG_PORT || 55441),
    extraFiles: [
      ...gen8SchemaFiles(),
      "db/migrations/20260930_300001_evm_creator_choice_operator.sql",
      "db/migrations/20261008_000040_evm_holder_batches_per_vault.sql",
      mig,
      mig, // idempotent
    ],
  });
  const anvil = await startAnvil(Number(process.env.GEN8_ANVIL_PORT || 8781), 97);
  try {
    process.env.DATABASE_URL = pg.url;
    process.env.BSC_RPC_HTTP_97 = anvil.url;
    const db = pg.pool;
    await db.query(`
      create table public.reward_batches (id uuid primary key default gen_random_uuid(), reward_type text, chain text, token_symbol text,
        status text, total_amount numeric, recipient_count int, claimable_count int, claimed_count int, failed_count int, source text,
        metadata jsonb, published_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
      create table public.reward_ledger (id uuid primary key default gen_random_uuid(), reward_type text, source_id text, source_label text,
        wallet_address text, chain text, token_symbol text, amount numeric, status text, metadata jsonb, claimable_at timestamptz,
        claim_error text, created_at timestamptz default now(), updated_at timestamptz default now());
      create table public.reward_batch_items (id uuid primary key default gen_random_uuid(), batch_id uuid, reward_ledger_id uuid,
        wallet_address text, amount numeric, status text, metadata jsonb);
    `);
    // RLS on the new tables; anon / authenticated have nothing.
    const rls = (await db.query(`select relname, relrowsecurity from pg_class where relname in ('evm_gen8_holder_check_runs','evm_gen8_holder_checks','evm_gen8_choice_jobs')`)).rows;
    assert.equal(rls.length, 3);
    assert.ok(rls.every((r: any) => r.relrowsecurity));
    const anonGrants = (await db.query(`select count(*)::int n from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name like 'evm_gen8_%choice%'`)).rows[0].n;
    assert.equal(anonGrants, 0);

    const provider = new ethers.JsonRpcProvider(anvil.url, 97, { staticNetwork: true, cacheTimeout: -1 });
    const env = await deployGen8Local(provider, { display: false });
    const startBlock = await provider.getBlockNumber();
    const A = {
      launcher: (await env.launcher.getAddress()).toLowerCase(), hook: (await env.hook.getAddress()).toLowerCase(), pm: (await env.pm.getAddress()).toLowerCase(),
      splitter: (await env.splitter.getAddress()).toLowerCase(), vault: (await env.vault.getAddress()).toLowerCase(), lock: (await env.reserveLock.getAddress()).toLowerCase(),
      escrow: (await env.escrow.getAddress()).toLowerCase(),
    };
    // ---- the local Safe wires the vault as on mainnet: holder distributor (vault = its batch operator), operator, caps.
    const distributor = await deployArtifact(env.deployer, "RewardDistributor", [env.safe.address]);
    const D = await distributor.getAddress();
    await (await (distributor.connect(env.safe) as any).setBatchOperator(A.vault)).wait();
    const vaultSafe = env.vault.connect(env.safe) as any;
    await (await vaultSafe.setHolderDistributorOnce(D)).wait();
    await (await vaultSafe.setOperator(env.operator.address, false)).wait();
    await (await vaultSafe.setCaps(WAD, WAD, 600n, 50n, 10n * WAD)).wait();

    const genv: NodeJS.ProcessEnv = {
      ...process.env,
      EVM_GEN8_LAUNCHER_97: `${A.launcher}@${startBlock}`, EVM_GEN8_HOOK_97: `${A.hook}@${startBlock}`, EVM_GEN8_POOL_MANAGER_97: A.pm,
      EVM_GEN8_SPLITTER_97: `${A.splitter}@${startBlock}`, EVM_GEN8_CHOICE_VAULT_97: A.vault, EVM_GEN8_RESERVE_LOCK_97: A.lock, EVM_GEN8_ESCROW_97: A.escrow,
      EVM_GEN8_CONFIRMATIONS: "0", EVM_GEN8_LOG_CHUNK: "5000",
      EVM_GEN8_DISPLAY_HEAD_TAG_97: "latest", EVM_GEN8_MONEY_HEAD_TAG_97: "latest",
      EVM_GEN8_LINK_ROUTERS_97: (await env.trader.getAddress()).toLowerCase(),
      EVM_GEN8_CHOICE_ENABLED_97: "true", EVM_GEN8_CHOICE_SEND: "true",
      EVM_HOLDER_MIN_PAYOUT_WEI_97: "1000", EVM_GEN8_PULL_MIN_WEI_97: "1", EVM_BUYBACK_MIN_WEI_97: "1000000000",
      EVM_BUYBACK_MAX_PER_DAY: "9",
    };
    // A steady holder on the configured soft list (EVM_HOLDER_EXCLUDED_WALLETS): stored per check, never paid.
    const listedWallet = wallets(provider, 30)[25].address.toLowerCase();
    genv.EVM_HOLDER_EXCLUDED_WALLETS_97 = listedWallet;

    const { evmGen8Config } = await import("../evm/evmGen8Config.js");
    const { defaultGen8Sinks, runGen8ChainOnce } = await import("../evm/evmGen8Pool.js");
    const { runGen8HolderCensusOnce } = await import("../evm/evmGen8Holders.js");
    const { weekOf, weekSecret, dayMoments, holderBatchId, merklePlan, verifyProof, merkleLeaf, allocateToHolders } = await import("../evm/evmCreatorChoice.js");
    const { gen8CheckMoments, checkGen8LeafFileShape, GEN8_HOLDER_RULE } = await import("../evm/evmGen8HoldThrough.js");
    const { createEthersGen8ChoiceChain, createEthersGen8ChoiceSender } = await import("../evm/evmGen8ChoiceChain.js");
    const { runGen8ChoicePass } = await import("../evm/evmGen8ChoicePass.js");
    const { gen8ChoiceConfig, runGen8ChoiceTick } = await import("../evm/evmGen8ChoiceWorker.js");
    const { holdThroughBalances } = await import("../dbc/dbcCreatorChoice.js");
    const cfg = evmGen8Config(97, genv).config!;
    const sinks = await defaultGen8Sinks(db);
    const ctx = { cfg, db, provider: provider as any, sinks, env: genv };

    // ---- the week: W = a Monday at least 3 days ahead; a master secret whose check windows are comfortably wide.
    const t0 = (await provider.getBlock("latest"))!.timestamp;
    let W = weekOf(new Date((t0 + 3 * 86_400) * 1000)).end.getTime() / 1000;
    let master = "";
    let moments: Date[] = [];
    for (let n = 0; n < 10_000; n += 1) {
      const m = `gen8-choice-local-${n}`;
      const wk = weekOf(new Date(W * 1000));
      const now = gen8CheckMoments(weekSecret(m, 97, wk.weekId), 97, wk.start).map((d) => d.getTime() / 1000);
      const prevWk = weekOf(new Date((W - WEEK) * 1000));
      const prev = gen8CheckMoments(weekSecret(m, 97, prevWk.weekId), 97, prevWk.start).map((d) => d.getTime() / 1000);
      const gaps = now.slice(1).map((x, i) => x - now[i]);
      if (prev[3] < W - 3 * 3600 && now[0] > W + 2 * 3600 && gaps.every((g) => g > 6 * 3600) && now[3] < W + WEEK - 6 * 3600) {
        master = m;
        moments = now.map((x) => new Date(x * 1000));
        break;
      }
    }
    assert.ok(master, "a master secret with wide check windows");
    genv.EVM_BUYBACK_SEED_SECRET = master;
    const weekId = weekOf(new Date(W * 1000)).weekId;
    const passCfg = gen8ChoiceConfig(97, genv);
    assert.equal(passCfg.perDay, 4, "at most 4 buyback moments a day");
    assert.equal(passCfg.pullMinWei, 1n);

    const chainTime = async () => (await provider.getBlock("latest"))!.timestamp;
    const travel = async (sec: number) => {
      await provider.send("evm_setNextBlockTimestamp", [Math.ceil(sec)]);
      await provider.send("evm_mine", []);
    };
    const catchUp = async () => {
      for (let i = 0; i < 50; i += 1) if (!(await runGen8ChainOnce(ctx))) break;
    };
    const census = async () => {
      await catchUp();
      for (let i = 0; i < 3; i += 1) await runGen8HolderCensusOnce({ db: db as any, cfg, provider: provider as any, env: genv });
    };
    const alerts: any[] = [];
    const alert = async (a: any) => {
      alerts.push(a);
    };
    const chain = createEthersGen8ChoiceChain(provider, A.vault, env.operator.address);
    const sender = createEthersGen8ChoiceSender(provider, env.operator.connect(provider) as ethers.Wallet, 97, A.vault, passCfg.maxFeePerGasWei);
    const pass = async (s = sender) => runGen8ChoicePass({ db, chainId: 97, chain, sender: s, cfg: passCfg, send: true, now: new Date((await chainTime()) * 1000), alert });
    const tick = async () => runGen8ChoiceTick({ db, maxSends: 30, run: (keyedByVault) => chainTime().then((t) => runGen8ChoicePass({ db, chainId: 97, chain, sender, cfg: passCfg, send: true, now: new Date(t * 1000), alert, keyedByVault })) });

    // ---- launch one hour before W (after the previous week's last check: those checks are not required)
    await travel(W - 3600);
    await (await (env.feed as any).set(600n * 10n ** 8n, await chainTime())).wait(); // the mock feed is fresh at launch
    const H =await launchCoin(env, env.creator, { feeChoice: 2, firstBuyValue: WAD / 1000n, name: "Holders Eight", symbol: "HLD8" });
    const S = await launchCoin(env, env.creator, { feeChoice: 3, feeCreatorPct: 30, firstBuyValue: WAD / 1000n, name: "Split Eight", symbol: "SPL8" });
    const B = await launchCoin(env, env.creator, { feeChoice: 4, firstBuyValue: WAD / 1000n, name: "Buyback Eight", symbol: "BUY8" });
    const [steady, dipper, flipper, small, late, listed] = wallets(provider, 30).slice(20, 26);
    await fund(provider, [steady, dipper, flipper, small, late, listed].map((w) => w.address));
    await travel((await chainTime()) + 120);
    const supply: bigint = await (H.coin as any).totalSupply();
    const min = supply / 10_000n;
    await swap(env, H, steady, { buy: true, exactIn: true, amount: WAD / 50n });
    await swap(env, H, dipper, { buy: true, exactIn: true, amount: WAD / 50n });
    await swap(env, H, flipper, { buy: true, exactIn: true, amount: WAD / 100n });
    await swap(env, H, small, { buy: true, exactIn: false, amount: min / 2n, maxIn: WAD / 100n });
    await swap(env, H, listed, { buy: true, exactIn: false, amount: 2n * min, maxIn: WAD / 100n });
    await swap(env, S, steady, { buy: true, exactIn: true, amount: WAD / 50n });
    await swap(env, S, dipper, { buy: true, exactIn: true, amount: WAD / 100n });
    await swap(env, B, steady, { buy: true, exactIn: true, amount: WAD / 50n });
    await swap(env, B, steady, { buy: false, exactIn: true, amount: min });
    const balH = async (w: ethers.Wallet) => (await (H.coin as any).balanceOf(w.address)) as bigint;
    assert.ok((await balH(small)) < min && (await balH(small)) > 0n, "the small wallet holds less than 0.01%");
    await census();
    const pools = (await db.query(`select pool_id, fee_choice, hook_creator_address, creator_address from public.evm_gen8_pools where chain_id = 97 order by fee_choice`)).rows;
    assert.deepEqual(pools.map((p: any) => Number(p.fee_choice)), [2, 3, 4]);
    assert.ok(pools.every((p: any) => p.hook_creator_address === A.vault && p.creator_address === env.creator.address.toLowerCase()), "choice coins: vault is the hook creator, the human creator is recorded");

    // ---- the four checks, trading in between
    const checkBlocks: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await travel(moments[i].getTime() / 1000 + 60);
      await census();
      // A pass before the census caught up would wait; here the census is at the moment's block.
      await tick();
      const runs = (await db.query(`select pool_id, block_number, block_time, supply::text supply, holders from public.evm_gen8_holder_check_runs where chain_id = 97 and week_id = $1 and check_index = $2 order by pool_id`, [weekId, i])).rows;
      assert.equal(runs.length, 2, `check ${i}: the holders coin and the split coin (not the buyback coin)`);
      assert.ok(runs.every((r: any) => Number(r.block_time) >= moments[i].getTime() / 1000 && BigInt(r.supply) === supply));
      checkBlocks.push(Number(runs[0].block_number));
      // Idempotent: a second pass at the same check writes nothing.
      const before = (await db.query(`select count(*)::int n from public.evm_gen8_holder_checks`)).rows[0].n;
      await pass();
      assert.equal((await db.query(`select count(*)::int n from public.evm_gen8_holder_checks`)).rows[0].n, before);
      if (i === 0) {
        await swap(env, H, late, { buy: true, exactIn: true, amount: WAD / 100n }); // late buyer: misses check 0
        await swap(env, H, dipper, { buy: false, exactIn: true, amount: (await balH(dipper)) / 2n }); // dipper: half
        await swap(env, H, flipper, { buy: false, exactIn: true, amount: await balH(flipper) }); // flipper: out
      } else if (i === 1) {
        await swap(env, H, flipper, { buy: true, exactIn: true, amount: WAD / 100n }); // flipper back in
      } else if (i === 2) {
        await swap(env, H, dipper, { buy: true, exactIn: true, amount: WAD / 100n }); // dipper tops up again
      }
    }
    // The creator, the pool manager and the vault are never stored as holders.
    const stored = new Set((await db.query(`select distinct wallet from public.evm_gen8_holder_checks where chain_id = 97`)).rows.map((r: any) => r.wallet));
    for (const skip of [env.creator.address.toLowerCase(), A.pm, A.vault, A.hook, DEAD.toLowerCase()]) assert.ok(!stored.has(skip), `${skip} is not a holder`);
    assert.ok(stored.has(small.address.toLowerCase()), "the small wallet is stored; the 0.01% line applies at payout");

    // Fees after the last check (the daily pulls took the earlier ones): the Monday run pulls them first.
    await swap(env, H, steady, { buy: true, exactIn: true, amount: WAD / 200n });
    await swap(env, S, steady, { buy: true, exactIn: true, amount: WAD / 200n });

    // ---- Monday: pulls, build, store, publish, propose
    await travel(W + WEEK + 600);
    await census();
    await tick();
    const batchId = holderBatchId(97, weekId, "airdrop_holders_gen8").toLowerCase();
    const row = (await db.query(`select leaf_file, status, root, total_raw::text total, claim_deadline::text deadline, reward_batch_id from public.evm_holder_batches where chain_id = $1 and lower(vault_address) = $2 and lower(batch_id) = $3`, [97, A.vault, batchId])).rows[0];
    assert.ok(row, "the week's batch is stored under the gen-8 vault (the watchdog's query)");
    assert.equal(row.status, "proposed");
    const pullJobs = (await db.query(`select subject, status from public.evm_gen8_choice_jobs where action = 'pull' and moment_key = $1`, [`week:${weekId}`])).rows;
    assert.deepEqual(pullJobs.map((j: any) => j.subject).sort(), [H.id, S.id].sort(), "Monday pulls of the holders and the split coin, before the batch");
    assert.ok(pullJobs.every((j: any) => j.status === "confirmed"));
    const file = row.leaf_file;
    checkGen8LeafFileShape(file);
    assert.equal(file.version, 2);
    assert.equal(file.rule, GEN8_HOLDER_RULE);
    assert.equal(file.batchId.toLowerCase(), batchId);
    assert.equal(file.holderDistributor.toLowerCase(), D.toLowerCase());
    const { root } = merklePlan(file.leaves.map((l: any) => ({ account: l.account, amount: BigInt(l.amount) })));
    assert.equal(root, file.root);
    const paid = new Map<string, bigint>(file.leaves.map((l: any) => [l.account.toLowerCase(), BigInt(l.amount)]));
    assert.ok(paid.has(steady.address.toLowerCase()), "steady holder paid");
    assert.ok(paid.has(dipper.address.toLowerCase()), "dipper paid");
    for (const w of [flipper, small, late, listed, env.creator]) assert.ok(!paid.has(w.address.toLowerCase()), `${w.address} not paid`);
    for (const a of [A.pm, A.vault, A.hook]) assert.ok(!paid.has(a), "contracts not paid");
    // Independent recomputation from the chain: balanceOf at each check block, the shared rule, the file's pot.
    const hPool = file.pools.find((p: any) => p.poolId === H.id);
    assert.deepEqual(hPool.checks.map((c: any) => c.index), [0, 1, 2, 3]);
    assert.deepEqual(hPool.checks.map((c: any) => c.block), checkBlocks);
    assert.ok(hPool.checks.every((c: any) => JSON.stringify(c.softExcluded) === JSON.stringify([listedWallet])), "the soft-listed wallet is named at every check");
    assert.ok(file.pools.find((p: any) => p.poolId === S.id).checks.every((c: any) => c.softExcluded.length === 0));
    assert.equal(hPool.checks[0].holders, 4, "holders after the soft list, before the 0.01% line (steady, dipper, flipper, small)");
    const holdersAt = async (blockTag: number) => {
      const out = [];
      for (const w of [steady, dipper, flipper, small, late]) {
        const amount: bigint = await (H.coin as any).balanceOf(w.address, { blockTag });
        if (amount > 0n) out.push({ owner: w.address.toLowerCase(), amount });
      }
      return out;
    };
    const lowest = holdThroughBalances(await Promise.all(checkBlocks.map(async (b) => ({ supply, balances: await holdersAt(b) }))));
    const dipLow = lowest.find((x) => x.owner === dipper.address.toLowerCase())!.amount;
    assert.equal(dipLow, (await (H.coin as any).balanceOf(dipper.address, { blockTag: checkBlocks[1] })) as bigint, "the dipper counts with its lowest balance");
    const expected = allocateToHolders(BigInt(hPool.pot), lowest);
    for (const [owner, amount] of expected) {
      const leaf = file.leaves.find((l: any) => l.account.toLowerCase() === owner);
      assert.equal(BigInt(leaf.parts.find((p: any) => p.poolId === H.id).amount), amount, `H part of ${owner}`);
    }
    const onChain = await (env.vault as any).holderBatches(batchId);
    assert.equal(String(onChain.root).toLowerCase(), file.root.toLowerCase());
    assert.equal(BigInt(onChain.total), BigInt(file.total));
    assert.equal(Number(onChain.status), 1);
    const contents = await (env.vault as any).batchContents(batchId);
    assert.deepEqual([...contents[0]].map((x: string) => x.toLowerCase()), file.pools.map((p: any) => p.poolId));
    const rb = (await db.query(`select status, metadata from public.reward_batches where id = $1`, [row.reward_batch_id])).rows[0];
    assert.equal(rb.status, "funding_check");
    assert.equal(rb.metadata.program, "airdrop_holders_gen8");
    assert.equal(rb.metadata.contractBatchId.toLowerCase(), batchId);

    // ---- the payout watchdog's independent verifier (payoutWatchdogGen8.ts) approves exactly this file.
    {
      const { verifyGen8HolderProposal } = await import("../evm/payoutWatchdogGen8.js");
      const proposeJob = (await db.query(`select tx_hash from public.evm_gen8_choice_jobs where action = 'propose_holder_batch' and status = 'confirmed'`)).rows[0];
      const ptx = (await provider.getTransaction(proposeJob.tx_hash))!;
      const prc = (await provider.getTransactionReceipt(proposeJob.tx_hash))!;
      const ev = prc.logs.map((l) => { try { return env.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "HolderBatchProposed")!;
      const proposal = {
        chainId: 97, vault: A.vault, program: "airdrop_holders_gen8", batchId, root: String(ev.args.root), total: BigInt(ev.args.total),
        executableAt: BigInt(ev.args.executableAt), claimDeadline: BigInt(ev.args.claimDeadline), blockNumber: prc.blockNumber,
        blockTime: (await provider.getBlock(prc.blockNumber))!.timestamp, txHash: proposeJob.tx_hash, txTo: ptx.to, txData: ptx.data,
      };
      const transfer = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
      const deps = {
        vault: async () => ({ holderDistributor: D, operator: env.operator.address }),
        coin: async (id: string) => {
          const c = await (env.vault as any).cfg(id);
          const row = (await db.query(`select token_address, launch_block from public.evm_gen8_pools where pool_id = $1`, [id])).rows[0];
          // No creator transfer in this test: the history is the registered creator from the launch block.
          return { choice: Number(c[1]), token: String(c[3]).toLowerCase(), creator: String(c[0]).toLowerCase(), registeredToken: row.token_address, launchBlock: Number(row.launch_block), creators: [{ block: Number(row.launch_block), creator: String(c[0]).toLowerCase() }] };
        },
        blockTime: async (b: number) => (await provider.getBlock(b))!.timestamp,
        census: async (token: string, launchBlock: number, blocks: number[]) => {
          const last = Math.max(...blocks);
          const logs = await provider.getLogs({ address: token, topics: [transfer.getEvent("Transfer")!.topicHash], fromBlock: launchBlock, toBlock: last });
          const bal = new Map<string, bigint>();
          let sup = 0n;
          const at = new Map<number, Map<string, bigint>>();
          const supplyAt = new Map<number, bigint>();
          const pending = [...blocks].sort((a, b) => a - b);
          const snap = (b: number) => {
            at.set(b, new Map([...bal].filter(([, v]) => v > 0n)));
            supplyAt.set(b, sup);
          };
          for (const l of logs) {
            while (pending.length && pending[0] < l.blockNumber) snap(pending.shift()!);
            const e = transfer.parseLog(l)!;
            const from = String(e.args.from).toLowerCase();
            const to = String(e.args.to).toLowerCase();
            const v = BigInt(e.args.value);
            if (from === ethers.ZeroAddress) sup += v;
            else bal.set(from, (bal.get(from) ?? 0n) - v);
            if (to === ethers.ZeroAddress) sup -= v;
            else bal.set(to, (bal.get(to) ?? 0n) + v);
          }
          while (pending.length) snap(pending.shift()!);
          return { at, supplyAt, end: { block: last, replayed: supplyAt.get(last)!, onChain: BigInt(await (new ethers.Contract(token, ["function totalSupply() view returns (uint256)"], provider)).totalSupply({ blockTag: last })) } };
        },
        holderBalanceBefore: async (id: string, block: number) => BigInt(await (env.vault as any).holderBalance(id, { blockTag: block - 1 })),
        censusExclusions: async () => (await db.query(`select wallet from public.evm_gen8_holder_exclusions where chain_id = 97`)).rows.map((r: any) => r.wallet),
      };
      const verdict = await verifyGen8HolderProposal(proposal as any, file, deps as any, {
        minPayoutWei: passCfg.minPayoutWei, claimWindowDays: passCfg.claimWindowDays, excluded: passCfg.excluded, riskExcluded: new Set(), masterSecret: master, maxExcludedBps: 1_000,
      });
      assert.equal(verdict.ok, true, `the watchdog's verifier refuses the operator's batch: ${JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      console.log("[gen8-choice test] watchdog verifier: ok", JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }

    // ---- the Safe's part (the watchdog's job in production): approve (4 args) + authorize on the distributor
    await tick();
    assert.equal((await db.query(`select last_reason from public.evm_holder_batches where lower(batch_id) = $1`, [batchId])).rows[0].last_reason, "waiting for the Safe to approve this root, total and claim deadline");
    await (await vaultSafe.approveHolderBatch(batchId, file.root, BigInt(file.total), BigInt(file.claimDeadline))).wait();
    await (await (distributor.connect(env.safe) as any).authorizeBatch(batchId, BigInt(file.total), W + WEEK, W + WEEK + 6 * 86_400)).wait();
    await tick();
    assert.equal((await db.query(`select status from public.evm_holder_batches where lower(batch_id) = $1`, [batchId])).rows[0].status, "proposed", "veto window still open");
    await travel((await chainTime()) + 24 * 3600 + 60);
    await census();
    await tick();
    assert.equal((await db.query(`select status from public.evm_holder_batches where lower(batch_id) = $1`, [batchId])).rows[0].status, "executed");
    assert.equal(Number((await (env.vault as any).holderBatches(batchId)).status), 2);
    const rbOpen = (await db.query(`select status from public.reward_batches where id = $1`, [row.reward_batch_id])).rows[0];
    assert.equal(rbOpen.status, "claim_open");
    // ---- a holder claims with the published proof
    const ledger = (await db.query(`select amount::text amount, status, metadata from public.reward_ledger where wallet_address = $1 and metadata->>'program' = 'airdrop_holders_gen8'`, [steady.address.toLowerCase()])).rows[0];
    assert.equal(ledger.status, "claimable");
    const proof = ledger.metadata.merkleProof as string[];
    assert.ok(verifyProof(file.root, merkleLeaf(steady.address, BigInt(ledger.amount)), proof));
    const before = await provider.getBalance(steady.address);
    const rc = await (await (distributor.connect(steady) as any).claim(batchId, BigInt(ledger.amount), proof)).wait();
    const gas = BigInt(rc.gasUsed) * BigInt(rc.gasPrice ?? rc.effectiveGasPrice);
    assert.equal((await provider.getBalance(steady.address)) - before + gas, BigInt(ledger.amount), "claimed exactly the leaf");

    // ---- buyback: a fresh fee on B, then its next secret moment; the first send "crashes" after it was recorded
    await swap(env, B, steady, { buy: true, exactIn: true, amount: WAD / 100n });
    await census();
    await tick(); // settles whatever is due now (daily pulls, an already-due moment)
    const deadBefore: bigint = await (B.coin as any).balanceOf(DEAD);
    const nowT = await chainTime();
    let target = 0;
    for (let d = 0; d < 3 && !target; d += 1) {
      const day = new Date((nowT + d * 86_400) * 1000);
      const ms = dayMoments(weekSecret(master, 97, weekOf(day).weekId), 97, B.id, day, 4);
      const next = ms.map((m) => m.getTime() / 1000).find((m) => m > nowT + 700);
      if (next) target = next;
    }
    assert.ok(target > 0, "an upcoming buyback moment");
    await swap(env, B, steady, { buy: true, exactIn: true, amount: WAD / 200n }); // creator fee in the hook before the moment
    await travel(Math.floor(target) + 30);
    await census();
    // The pull before the buyback.
    const r1 = await pass();
    assert.equal(r1.sent?.action, "pull");
    assert.ok(r1.sent?.confirmed);
    // The buyback is recorded signed, then the process dies before the broadcast.
    const nonceBefore = await provider.getTransactionCount(env.operator.address, "latest");
    const crashing = { ...sender, broadcast: async () => { throw new Error("process killed before broadcast"); } };
    const r2 = await pass(crashing);
    assert.equal(r2.sent?.action, "buyback");
    assert.equal(r2.sent?.confirmed, false);
    const job = (await db.query(`select * from public.evm_gen8_choice_jobs where action = 'buyback' and status = 'sending'`)).rows[0];
    assert.ok(job, "the buyback job is recorded before its broadcast");
    assert.equal(await provider.getTransactionCount(env.operator.address, "latest"), nonceBefore, "nothing left the process");
    // Restart: the 'sending' job is re-broadcast with the same bytes, nothing new is signed while it is in flight.
    const r3 = await pass();
    assert.equal(r3.inFlight, true);
    assert.equal(r3.sent, null, "no second transaction while one is in flight");
    const r4 = await pass();
    assert.equal(r4.inFlight, false);
    const done = (await db.query(`select status, tx_hash from public.evm_gen8_choice_jobs where id = $1`, [job.id])).rows[0];
    assert.equal(done.status, "confirmed");
    assert.equal(done.tx_hash, job.tx_hash, "the same signed transaction");
    assert.equal(await provider.getTransactionCount(env.operator.address, "latest"), nonceBefore + 1 + (r4.sent ? 1 : 0), "exactly one buyback was sent");
    const buybacks = (await db.query(`select count(*)::int n from public.evm_gen8_choice_jobs where action = 'buyback' and moment_key = $1`, [job.moment_key])).rows[0].n;
    assert.equal(buybacks, 1, "one job for the moment");
    const deadAfter: bigint = await (B.coin as any).balanceOf(DEAD);
    assert.ok(deadAfter > deadBefore, "the buyback burned coins to 0xdEaD");
    const rcB = await provider.getTransactionReceipt(job.tx_hash);
    const parsed = rcB!.logs.map((l) => { try { return env.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Buyback");
    assert.ok(parsed && BigInt(parsed.args.coinsBurned) > 0n);

    // ---- an operator that is not the vault's: nothing is sent, a critical alert is raised
    const stranger = wallets(provider, 30)[29];
    const strangerSender = createEthersGen8ChoiceSender(provider, stranger.connect(provider) as ethers.Wallet, 97, A.vault);
    const r5 = await pass(strangerSender);
    assert.equal(r5.operatorOk, false);
    assert.equal(r5.sent, null);
    assert.ok(alerts.some((a) => a.kind === "gen8_choice_operator_refused"));
    assert.ok(!alerts.some((a) => a.kind === "gen8_choice_check_missed"), "no check was missed");
    assert.ok(!alerts.some((a) => a.kind === "gen8_choice_tx_stuck"), "the re-broadcast job was not stuck");
    assert.ok(!alerts.some((a) => a.kind === "gen8_choice_vault_layout"), "the vault storage layout check passed");
    provider.destroy();
  } finally {
    await anvil.stop();
    await pg.stop();
    // indexer.ts starts its league feed timer at import; end the test process once the test is done.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
});
