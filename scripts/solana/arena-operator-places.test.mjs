import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import {
  ARENA_BUYIN_DISCRIMINATOR,
  REWARDS_TREASURY_PROGRAM_ID,
} from "../../frontend/src/lib/solanaArenaLayout.mjs";
import { buildTournamentPlaces } from "../../frontend/api/lib/arenaTournamentPlaces.js";
import {
  ARENA_PROGRAM_ID,
  deriveArenaBuyInReceipt,
} from "./arena-operator-v0.mjs";
import {
  ARENA_KIND_TOURNAMENT_CODE,
  ARENA_STATE_LIVE,
  ARENA_STATE_RESOLVED,
  RESOLVE_POOL_PLACES_V2_DISCRIMINATOR,
  assertEd25519PlacesAdjacency,
  buildPlannedPlacesResolveInstructions,
  canonicalTournamentPoolIdBytes,
  planTournamentPlacesResolve,
  tournamentPlacesOutcomeHash,
} from "./arena-operator-resolve.mjs";
import { runOperatorJob } from "./arena-operator-worker.mjs";

const tournamentId = "tourney-places-1";
const poolId = canonicalTournamentPoolIdBytes(tournamentId);
const resolver = Keypair.generate();
// Eight paid entrants: the places policy pays 70 / 30 (champion, finalist).
const entrants = Array.from({ length: 8 }, () => ({ asset: Keypair.generate().publicKey, wallet: Keypair.generate().publicKey }));
const [champ, runnerUp, third] = entrants;
const show = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v?.toBase58 ? v.toBase58() : v));

function writeU64le(data, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function receiptAccount({ asset, wallet, amount = 100n, refunded = false, pool = poolId } = {}) {
  const data = new Uint8Array(8 + 32 + 32 + 32 + 8 + 1 + 1);
  data.set(ARENA_BUYIN_DISCRIMINATOR, 0);
  data.set(pool, 8);
  data.set(asset.toBytes(), 40);
  data.set(wallet.toBytes(), 72);
  writeU64le(data, 104, amount);
  data[112] = refunded ? 1 : 0;
  return { data, owner: REWARDS_TREASURY_PROGRAM_ID, pubkey: deriveArenaBuyInReceipt(pool, asset.toBase58(), wallet.toBase58()) };
}

/** 8 entrants, 3 rounds. Champion e0 beats e7, e2 (semi) and e1 (final); e1 beats e6 and e3. */
function bracket() {
  const t = (i) => entrants[i].asset.toBase58();
  const m = (id, a, b, winner) => ({ id, tokenA: t(a), tokenB: t(b), battleId: `b-${id}`, winner: t(winner), bye: false });
  return {
    rounds: [
      { round: 1, matches: [m("m1", 0, 7, 0), m("m2", 3, 4, 3), m("m3", 1, 6, 1), m("m4", 2, 5, 2)] },
      { round: 2, matches: [m("m5", 0, 2, 0), m("m6", 1, 3, 1)] },
      { round: 3, matches: [m("m7", 0, 1, 0)] },
    ],
  };
}

function tournament(overrides = {}) {
  return { id: tournamentId, chain_id: 101, status: "finished", winner_token: champ.asset.toBase58(), bracket: bracket(), ...overrides };
}

function entries() {
  return entrants.map((e) => ({ token_address: e.asset.toBase58(), owner_wallet: e.wallet.toBase58(), buy_in_paid: true }));
}

function policyPlaces() {
  const built = buildTournamentPlaces({ bracket: bracket(), entries: entries(), entrantCount: 8 });
  assert.equal(built.ok, true, show(built));
  return built.places;
}

function pool(overrides = {}) {
  return {
    kind: ARENA_KIND_TOURNAMENT_CODE,
    state: ARENA_STATE_LIVE,
    poolId,
    assetA: "", assetB: "", ownerA: "", ownerB: "",
    depositedStakeA: 0n, depositedStakeB: 0n,
    supportTotal: 0n, prizeBoostTotal: 1_000n, buyInTotal: 800n, buyInLamports: 100n, entryCount: 8,
    resolveDeadline: 2_000_000_000, actionNonce: 3n,
    claimedProtocol: false, claimedMwl: false, pendingProtocol: 10n, pendingMwl: 20n,
    ...overrides,
  };
}

function receiptsFor(places) {
  return places.map((place) => {
    const entrant = entrants.find((e) => e.asset.toBase58() === place.asset && e.wallet.toBase58() === place.wallet);
    assert.ok(entrant, `entrant for ${place.asset}`);
    return receiptAccount({ asset: entrant.asset, wallet: entrant.wallet });
  });
}

function config() {
  return { resolver: resolver.publicKey.toBase58(), protocolReceiver: Keypair.generate().publicKey.toBase58(), mwlReceiver: Keypair.generate().publicKey.toBase58() };
}

test("places policy: eight paid entrants pay champion 70 / finalist 30", () => {
  const places = policyPlaces();
  assert.deepEqual(places.map((p) => [p.asset, p.wallet, p.bps]), [
    [champ.asset.toBase58(), champ.wallet.toBase58(), 7_000],
    [runnerUp.asset.toBase58(), runnerUp.wallet.toBase58(), 3_000],
  ]);
  // Fewer than eight paid entrants: winner takes all.
  const small = buildTournamentPlaces({ bracket: bracket(), entries: entries().slice(0, 4), entrantCount: 4 });
  assert.equal(small.ok, true);
  assert.deepEqual(small.places.map((p) => p.bps), [10_000]);
});

test("planner resolves places with verified receipts, pool totals, nonce and deadline", () => {
  const places = policyPlaces();
  const plan = planTournamentPlacesResolve({ tournament: tournament(), pool: pool(), places, receiptAccounts: receiptsFor(places) });
  assert.equal(plan.ok, true, show(plan));
  assert.equal(plan.action, "resolve-places");
  assert.equal(plan.version, 2);
  assert.equal(plan.places.length, 2);
  assert.equal(plan.winnerAsset, champ.asset.toBase58());
  assert.equal(plan.winnerWallet, champ.wallet.toBase58());
  assert.equal(plan.receipts.length, 2);
  assert.equal(plan.receipts[1].toBase58(), deriveArenaBuyInReceipt(poolId, runnerUp.asset.toBase58(), runnerUp.wallet.toBase58()).toBase58());
  assert.equal(plan.buyInTotal, 800n);
  assert.equal(plan.prizeBoostTotal, 1_000n);
  assert.equal(plan.nonce, 3n);
  assert.equal(plan.deadline, 2_000_000_000n);
  assert.deepEqual(plan.outcomeHash, tournamentPlacesOutcomeHash({ id: tournamentId, places: plan.places, settlement_version: 1 }));
  assert.notDeepEqual(plan.outcomeHash, tournamentPlacesOutcomeHash({ id: tournamentId, places: [plan.places[1], plan.places[0]], settlement_version: 1 }));
});

test("planner blocks: bad bps, missing or foreign receipt, wrong champion, too many places", () => {
  const places = policyPlaces();
  const base = { tournament: tournament(), pool: pool(), places, receiptAccounts: receiptsFor(places) };
  assert.equal(planTournamentPlacesResolve({ ...base, places: [{ ...places[0], bps: 6_000 }, places[1]] }).reason, "place-bps-not-10000");
  assert.equal(planTournamentPlacesResolve({ ...base, receiptAccounts: [base.receiptAccounts[0]] }).reason, "receipt-count-mismatch");
  assert.equal(planTournamentPlacesResolve({ ...base, receiptAccounts: [base.receiptAccounts[0], null] }).reason, "place-2-receipt-missing-account");
  const foreign = receiptAccount({ asset: third.asset, wallet: third.wallet });
  assert.equal(planTournamentPlacesResolve({ ...base, receiptAccounts: [base.receiptAccounts[0], foreign] }).reason, "place-2-receipt-asset-mismatch");
  const refunded = receiptAccount({ asset: runnerUp.asset, wallet: runnerUp.wallet, refunded: true });
  assert.equal(planTournamentPlacesResolve({ ...base, receiptAccounts: [base.receiptAccounts[0], refunded] }).reason, "place-2-receipt-refunded");
  const swapped = [{ ...places[1], bps: 7_000 }, { ...places[0], bps: 3_000 }];
  assert.equal(planTournamentPlacesResolve({ ...base, places: swapped, receiptAccounts: receiptsFor(swapped) }).reason, "first-place-not-champion");
  assert.equal(planTournamentPlacesResolve({ ...base, tournament: tournament({ status: "live" }) }).reason, "tournament-not-finished");
  assert.equal(planTournamentPlacesResolve({ ...base, pool: pool({ entryCount: 1 }) }).reason, "more-places-than-entries");
  assert.equal(planTournamentPlacesResolve({ ...base, pool: pool({ resolveDeadline: 1 }) }).reason, "resolve-deadline-passed");
  assert.equal(planTournamentPlacesResolve({ ...base, pool: pool({ kind: 0 }) }).reason, "not-tournament");
  assert.equal(planTournamentPlacesResolve({ ...base, places: [...places, places[0], places[1]] }).reason, "invalid-place-count");
});

test("already resolved on-chain with the same places skips; a different list blocks", () => {
  const places = policyPlaces();
  const resolved = pool({
    state: ARENA_STATE_RESOLVED,
    placeCount: 2,
    placeAssets: [champ.asset.toBase58(), runnerUp.asset.toBase58(), ""],
    placeWallets: [champ.wallet.toBase58(), runnerUp.wallet.toBase58(), ""],
    winnerAsset: champ.asset.toBase58(),
    winnerWallet: champ.wallet.toBase58(),
  });
  const skip = planTournamentPlacesResolve({ tournament: tournament(), pool: resolved, places, receiptAccounts: receiptsFor(places) });
  assert.equal(skip.ok, true, show(skip));
  assert.equal(skip.action, "skip");
  const other = { ...resolved, placeWallets: [champ.wallet.toBase58(), third.wallet.toBase58(), ""] };
  assert.equal(planTournamentPlacesResolve({ tournament: tournament(), pool: other, places, receiptAccounts: receiptsFor(places) }).reason, "resolved-place-2-wallet-mismatch");
  assert.equal(planTournamentPlacesResolve({ tournament: tournament(), pool: { ...resolved, placeCount: 1 }, places, receiptAccounts: receiptsFor(places) }).reason, "resolved-place-count-mismatch");
});

test("built transaction: Ed25519 verify immediately before resolve_pool_places_v2, receipts carried in place order", () => {
  const places = policyPlaces();
  const plan = planTournamentPlacesResolve({ tournament: tournament(), pool: pool(), places, receiptAccounts: receiptsFor(places) });
  const built = buildPlannedPlacesResolveInstructions(plan, resolver);
  assertEd25519PlacesAdjacency(built.instructions);
  assert.equal(built.instructions[1].programId.toBase58(), ARENA_PROGRAM_ID.toBase58());
  assert.ok(Buffer.from(built.instructions[1].data.subarray(0, 8)).equals(Buffer.from(RESOLVE_POOL_PLACES_V2_DISCRIMINATOR)));
  const keys = built.instructions[1].keys.map((k) => k.pubkey.toBase58());
  assert.deepEqual(keys.slice(3), plan.receipts.map((k) => k.toBase58()), "remaining accounts are the verified receipts");
  assert.throws(() => assertEd25519PlacesAdjacency([built.instructions[1], built.instructions[0]]), /Ed25519 verify must be first/);
});

test("worker: resolve-tournament dry-run plans without sending; --send re-reads until the pool shows the places", async () => {
  const sends = [];
  let current = pool();
  const common = {
    command: "resolve-tournament",
    tournamentId,
    loadTournament: async () => ({ tournament: tournament(), entries: entries() }),
    loadPool: async () => current,
    loadConfig: async () => config(),
    loadReceipts: async (list) => receiptsFor(list),
    resolver,
    payer: resolver,
    sendResolvePlaces: async (plan) => {
      sends.push(plan);
      current = pool({
        state: ARENA_STATE_RESOLVED,
        placeCount: 2,
        placeAssets: [plan.places[0].asset, plan.places[1].asset, ""],
        placeWallets: [plan.places[0].wallet, plan.places[1].wallet, ""],
        winnerAsset: plan.places[0].asset,
        winnerWallet: plan.places[0].wallet,
      });
      return "sig-places";
    },
  };
  const dry = await runOperatorJob(common);
  assert.equal(dry.ok, true, show(dry));
  assert.equal(dry.action, "resolve-places");
  assert.equal(dry.sent, false);
  assert.equal(sends.length, 0);

  const sent = await runOperatorJob({ ...common, send: true });
  assert.equal(sent.ok, true, show(sent));
  assert.equal(sent.action, "sent");
  assert.equal(sent.reason, "resolved-places");
  assert.equal(sent.signature, "sig-places");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].places.map((p) => p.bps), [7_000, 3_000]);

  const again = await runOperatorJob({ ...common, send: true });
  assert.equal(again.action, "skip");
  assert.equal(sends.length, 1, "a resolved pool never re-sends");
});

test("worker: tournament resolve blocks on the wrong resolver, a live tournament, a non-Solana chain or an unpaid place", async () => {
  const common = {
    command: "resolve-tournament",
    tournamentId,
    loadTournament: async () => ({ tournament: tournament(), entries: entries() }),
    loadPool: async () => pool(),
    loadConfig: async () => config(),
    loadReceipts: async (list) => receiptsFor(list),
    resolver: Keypair.generate(),
    payer: resolver,
    sendResolvePlaces: async () => { throw new Error("must not send"); },
  };
  assert.equal((await runOperatorJob(common)).reason, "resolver-config-mismatch");
  assert.equal((await runOperatorJob({ ...common, resolver, loadTournament: async () => ({ tournament: tournament({ status: "live" }), entries: entries() }) })).reason, "tournament-not-finished");
  assert.equal((await runOperatorJob({ ...common, resolver, loadTournament: async () => ({ tournament: tournament({ chain_id: 56 }), entries: entries() }) })).reason, "not-solana");
  const finalistUnpaid = entries().map((entry, index) => (index === 1 ? { ...entry, owner_wallet: "" } : entry));
  assert.equal((await runOperatorJob({ ...common, resolver, loadTournament: async () => ({ tournament: tournament(), entries: finalistUnpaid }) })).reason, "places-no-paid-entry-for-place-2");
  assert.equal((await runOperatorJob({ ...common, resolver, tournamentId: "" })).reason, "missing-tournament-id");
});

test("worker: tournament protocol claim uses the tournament pot and the config receiver", async () => {
  const claims = [];
  let current = pool({ state: ARENA_STATE_RESOLVED, pendingProtocol: 25n, claimedProtocol: false });
  const result = await runOperatorJob({
    command: "claim-protocol",
    tournamentId,
    send: true,
    loadTournament: async () => ({ tournament: tournament(), entries: entries() }),
    loadPool: async () => current,
    loadConfig: async () => config(),
    resolver,
    payer: resolver,
    sendClaim: async (plan) => {
      claims.push(plan);
      current = { ...current, claimedProtocol: true, pendingProtocol: 0n };
      return "sig-claim";
    },
  });
  assert.equal(result.ok, true, show(result));
  assert.equal(result.action, "sent");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].amount, 25n);
  assert.ok(Buffer.from(claims[0].poolId).equals(poolId));
});
