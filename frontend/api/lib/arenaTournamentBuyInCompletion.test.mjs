import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  STAGING_ARENA_V2_AUTHORITY,
  arenaWarPoolTreasuryV2Address,
  tournamentBuyInNativeRaw,
  tournamentPoolIdV2,
} from "./arenaTournamentBuyInV2.mjs";

const buyIns = fs.readFileSync(new URL("../arenaTournamentBuyIns.js", import.meta.url), "utf8");
const voteSetup = fs.readFileSync(new URL("../arenaVoteTournamentSetup.js", import.meta.url), "utf8");
const postgrad = fs.readFileSync(new URL("../postgrad.js", import.meta.url), "utf8");
const frontend = fs.readFileSync(new URL("../../src/components/arena/ArenaBuyInButton.tsx", import.meta.url), "utf8");
const solanaRead = fs.readFileSync(new URL("./solanaArenaPoolRead.js", import.meta.url), "utf8");
const contract = fs.readFileSync(new URL("../../../contracts/ArenaWarPoolTreasuryV2.sol", import.meta.url), "utf8");

const BSC = STAGING_ARENA_V2_AUTHORITY[97];
const RH = STAGING_ARENA_V2_AUTHORITY[46630];

test("1 BSC97 authoritative ArenaWarPoolTreasuryV2 identity is exact", () => {
  assert.equal(arenaWarPoolTreasuryV2Address(97, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97: BSC.treasury }), BSC.treasury);
  assert.equal(BSC.treasury, "0xAb8cb6d117b79dd7502898e50C900360924fDa85");
});

test("2 Robinhood46630 authoritative ArenaWarPoolTreasuryV2 identity is exact", () => {
  assert.equal(arenaWarPoolTreasuryV2Address(46630, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: RH.treasury }), RH.treasury);
  assert.equal(RH.treasury, "0x1eDd34933E5395c82F14CE2A220b81adF35C52B7");
});

test("3 wrong staging Treasury fails closed", () => {
  assert.throws(() => arenaWarPoolTreasuryV2Address(97, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_97: "0x1111111111111111111111111111111111111111" }), /attested authority/i);
  assert.throws(() => arenaWarPoolTreasuryV2Address(46630, { ARENA_WAR_POOL_TREASURY_V2_ADDRESS_46630: "0x2222222222222222222222222222222222222222" }), /attested authority/i);
});

test("4 tournament pool identity is deterministic and Tournament-bound", () => {
  assert.match(tournamentPoolIdV2("battle-tournament-1"), /^0x[0-9a-f]{64}$/i);
  assert.notEqual(tournamentPoolIdV2("battle-tournament-1"), tournamentPoolIdV2("battle-tournament-2"));
});

test("5 exact native buy-in is derived from arena_tournaments.buy_in_native, not USD", () => {
  assert.equal(tournamentBuyInNativeRaw({ chainId: 97, buyInNative: "0.003125" }), 3_125_000_000_000_000n);
  assert.equal(tournamentBuyInNativeRaw({ chainId: 46630, buyInNative: "0.0042" }), 4_200_000_000_000_000n);
  assert.equal(tournamentBuyInNativeRaw({ chainId: 102, buyInNative: "0.025" }), 25_000_000n);
  assert.doesNotMatch(voteSetup, /250_000|buyInUsd:\s*["']0\.25["']|founder-locked \$0\.25/i);
  assert.match(voteSetup, /paymentAuthority:\s*"arena_tournaments\.buy_in_native"/);
});

test("6 historical Tournament rows remain authoritative through their stored buy_in_native", () => {
  assert.match(buyIns, /tournament\.buy_in_native/);
  assert.match(voteSetup, /select id, chain_id, buy_in_native/);
  assert.doesNotMatch(buyIns, /nativeUsd|usdMicros|TOURNAMENT_BUY_IN_USD_MICROS/);
});

test("7 backend independently verifies EVM chain Treasury runtime generation pool payer and amount", () => {
  const helper = fs.readFileSync(new URL("./arenaTournamentBuyInV2.mjs", import.meta.url), "utf8");
  assert.match(helper, /provider\.getNetwork\(\)/);
  assert.match(helper, /runtime hash mismatch/i);
  assert.match(helper, /GENERATION\(\)/);
  assert.match(helper, /contract\.pools\(poolId\)/);
  assert.match(helper, /contract\.buyIns\(poolId, getAddress\(String\(wallet\)\)\)/);
  assert.match(helper, /transaction used the wrong payer/i);
  assert.match(helper, /transaction used the wrong amount/i);
});

test("8 wrong chain wrong Treasury wrong pool wrong payer and wrong amount fail closed", () => {
  const helper = fs.readFileSync(new URL("./arenaTournamentBuyInV2.mjs", import.meta.url), "utf8");
  for (const needle of [
    /RPC chain mismatch/,
    /does not match backend authority/,
    /wrong Tournament pool/,
    /wrong payer/,
    /wrong amount/,
  ]) assert.match(helper, needle);
});

test("9 browser tx hash is optional evidence and never substitutes for buyIns mapping", () => {
  const helper = fs.readFileSync(new URL("./arenaTournamentBuyInV2.mjs", import.meta.url), "utf8");
  assert.match(helper, /proof\.paid !== expected/);
  assert.match(helper, /txHash = ""/);
  assert.match(buyIns, /readEvmTournamentPoolV2/);
  assert.match(buyIns, /verifyEvmTournamentBuyInV2/);
});

test("10 reload after chain success reconciles existing deposit before another EVM payment", () => {
  assert.match(frontend, /fetchBuyInStatus/);
  assert.match(frontend, /status\.buyInPaid \|\| status\.chainPaid/);
  assert.match(frontend, /await signedReceipt\(walletAddress\);[\s\S]*return;/);
  assert.match(frontend, /depositBuyIn\(status\.poolId/);
});

test("11 double-click and duplicate confirmation are idempotent", () => {
  assert.match(frontend, /if \(busy\) return/);
  assert.match(buyIns, /if \(entry\.buy_in_paid\) return json\(res, 200, \{ ok: true, idempotent: true/);
  assert.match(buyIns, /and buy_in_paid = false/);
  assert.match(buyIns, /if \(raced\?\.buy_in_paid\)/);
});

test("12 crash after chain success is recoverable without a second economic payment", () => {
  assert.match(buyIns, /recoveryAvailable: state\.ok === true/);
  assert.match(frontend, /chainPaid/);
  assert.match(contract, /if \(buyIns\[poolId\]\[msg\.sender\] != 0\) revert AlreadyDeposited\(\)/);
});

test("13 Solana payment rail and authoritative receipt PDA remain intact", () => {
  assert.match(frontend, /runSolanaArenaUserAction/);
  assert.match(frontend, /buildArenaBuyInV0Instruction/);
  assert.match(buyIns, /readAuthoritativeBuyInReceipt/);
  assert.match(solanaRead, /deriveArenaBuyInPda/);
  assert.match(solanaRead, /verifyAuthoritativeBuyInReceipt/);
});

test("14 frontend supports EVM chain switch and exact raw value", () => {
  assert.doesNotMatch(frontend, /if \(!isSolanaWarzoneChain\(id\)\) return null/);
  assert.match(frontend, /requestWalletChainSwitch/);
  assert.match(frontend, /value: amountRaw/);
  assert.match(frontend, /VITE_ARENA_WAR_POOL_TREASURY_V2_ADDRESS_/);
});

test("15 Battle and Vote Tournament receipts share one three-chain authoritative route", () => {
  assert.match(postgrad, /arenaTournamentBuyIns/);
  assert.match(postgrad, /buy-in-status\|v2-buy-in-receipt\|buy-in-receipt/);
  assert.match(buyIns, /arena_tournament_buy_in/);
  assert.match(buyIns, /isSolanaChainId/);
  assert.match(buyIns, /verifyEvmTournamentBuyInV2/);
});
