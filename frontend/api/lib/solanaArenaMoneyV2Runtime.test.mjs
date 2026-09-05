import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import {
  ARENA_MONEY_V2_PROGRAM_ID,
  BOOST_RECEIPT_V2_DISCRIMINATOR,
  EVENT_PRIZE_VAULT_V1_DISCRIMINATOR,
  LEAGUE_SOURCE_RECEIPT_V2_DISCRIMINATOR,
  POSTGRAD_LEAGUE_TREASURY_V2_DISCRIMINATOR,
  SPONSORSHIP_EVENT_V1_DISCRIMINATOR,
  SPONSORSHIP_RECEIPT_V1_DISCRIMINATOR,
  verifyBoostReceiptV2,
  verifyEventPrizeVaultV1,
  verifyLeagueSourceReceiptV2,
  verifyPostGradLeagueTreasuryV2,
  verifySponsorshipEventV1,
  verifySponsorshipReceiptV1,
} from "../../src/lib/solanaArenaMoneyV2Layout.mjs";
import {
  buildSolanaBoostInstructionRequirements,
  buildSolanaSponsorshipInstructionRequirements,
  sponsorshipVaultLifetimeTotals,
  splitSolanaBoost,
  splitSolanaSponsorship,
  verifyExactVaultLamportDelta,
  verifySolanaSponsorshipVaultState,
} from "./solanaArenaMoneyV2Runtime.mjs";
import {
  deriveBoostReceiptV2Pda,
  deriveLeagueSourceReceiptV2Pda,
  derivePostGradLeagueTreasuryV2Pda,
  deriveSponsorshipEventV1Pda,
  deriveEventPrizeVaultV1Pda,
  deriveSponsorshipReceiptV1Pda,
} from "./solanaArenaMoneyV2Read.js";

const PK_A = new PublicKey("ComputeBudget111111111111111111111111111111");
const PK_B = new PublicKey("SysvarRent111111111111111111111111111111111");
const COMP = `0x${"11".repeat(32)}`;
const FUND = `0x${"22".repeat(32)}`;
const EVENT = `0x${"33".repeat(32)}`;
const PAYMENT = `0x${"44".repeat(32)}`;

function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function id32(hex) { return Buffer.from(hex.replace(/^0x/, ""), "hex"); }
function pk(value) { return new PublicKey(value).toBuffer(); }
function account(data) { return { data: Uint8Array.from(data) }; }

{
  const s = splitSolanaBoost(101n);
  assert.deepEqual({ prize: s.prize, protocol: s.protocol }, { prize: 91n, protocol: 10n });
  assert.equal(s.prize + s.protocol, 101n);
  const max = splitSolanaBoost(0xffffffffffffffffn);
  assert.equal(max.prize + max.protocol, 0xffffffffffffffffn);
}

{
  const s = splitSolanaSponsorship(101n);
  assert.deepEqual({ prize: s.prize, marketing: s.marketing, protocol: s.protocol }, { prize: 71n, marketing: 20n, protocol: 10n });
  assert.equal(s.prize + s.marketing + s.protocol, 101n);
}

{
  const req = buildSolanaBoostInstructionRequirements({ competitionId: COMP, fundingId: FUND, wallet: PK_B.toBase58(), grossLamports: 100n });
  assert.equal(req.programId, ARENA_MONEY_V2_PROGRAM_ID);
  assert.equal(req.instruction, "deposit_competition_boost_v2");
  assert.equal(req.accounts.length, 5);
  assert.equal(req.receiptPda, deriveBoostReceiptV2Pda(COMP, FUND, PK_B).toBase58());
  assert.equal(Buffer.from(req.dataBase64, "base64").length, 8 + 32 + 32 + 8);
}

{
  const req = buildSolanaSponsorshipInstructionRequirements({ eventId: EVENT, paymentId: PAYMENT, sponsor: PK_B.toBase58(), grossLamports: 100n });
  assert.equal(req.instruction, "pay_sponsorship_v1");
  assert.equal(req.accounts.length, 6);
  assert.equal(req.eventPda, deriveSponsorshipEventV1Pda(EVENT).toBase58());
  assert.equal(req.vaultPda, deriveEventPrizeVaultV1Pda(EVENT).toBase58());
  assert.equal(req.receiptPda, deriveSponsorshipReceiptV1Pda(EVENT, PAYMENT, PK_B).toBase58());
}

{
  const data = Buffer.concat([Buffer.from(BOOST_RECEIPT_V2_DISCRIMINATOR), Buffer.from([2]), id32(COMP), id32(FUND), pk(PK_B), u64(101), u64(91), u64(10), i64(123), Buffer.from([0, 7])]);
  const expectedPda = deriveBoostReceiptV2Pda(COMP, FUND, PK_B).toBase58();
  const ok = verifyBoostReceiptV2({ account: account(data), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: expectedPda, expectedPda, expectedCompetitionId: COMP, expectedFundingId: FUND, expectedFunder: PK_B.toBase58(), expectedGrossLamports: 101, expectedPrizeLamports: 91, expectedProtocolLamports: 10, PublicKey });
  assert.equal(ok.ok, true);
  assert.equal(verifyBoostReceiptV2({ account: account(data), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: PK_A.toBase58(), expectedPda, expectedCompetitionId: COMP, expectedFundingId: FUND, expectedFunder: PK_B.toBase58(), expectedGrossLamports: 101, PublicKey }).reason, "wrong-pda");
  const wrongDisc = Buffer.from(data); wrongDisc[0] ^= 0xff;
  assert.equal(verifyBoostReceiptV2({ account: account(wrongDisc), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: expectedPda, expectedPda, expectedCompetitionId: COMP, expectedFundingId: FUND, expectedFunder: PK_B.toBase58(), expectedGrossLamports: 101, PublicKey }).reason, "bad-layout-or-generation");
}

{
  const treasuryPda = derivePostGradLeagueTreasuryV2Pda().toBase58();
  const treasury = Buffer.concat([Buffer.from(POSTGRAD_LEAGUE_TREASURY_V2_DISCRIMINATOR), Buffer.from([2]), pk(PK_B), pk(PK_A), pk(PK_B), u64(120), u64(80), u64(0), u64(0), Buffer.from([1])]);
  assert.equal(verifyPostGradLeagueTreasuryV2({ account: account(treasury), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: treasuryPda, expectedPda: treasuryPda, PublicKey }).ok, true);

  const receiptPda = deriveLeagueSourceReceiptV2Pda(COMP).toBase58();
  const source = Buffer.concat([Buffer.from(LEAGUE_SOURCE_RECEIPT_V2_DISCRIMINATOR), Buffer.from([2]), id32(COMP), Buffer.from([1]), u64(200), u64(120), u64(80), i64(123), Buffer.from([2])]);
  const verified = verifyLeagueSourceReceiptV2({ account: account(source), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: receiptPda, expectedPda: receiptPda, expectedSourceId: COMP, expectedAmountLamports: 200 });
  assert.equal(verified.ok, true);
  assert.equal(verified.receipt.monthlyLamports, 120n);
  assert.equal(verified.receipt.quarterlyLamports, 80n);
  assert.equal(verifyLeagueSourceReceiptV2({ account: account(source), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: receiptPda, expectedPda: receiptPda, expectedSourceId: FUND }).reason, "source-mismatch");
}

{
  const eventPda = deriveSponsorshipEventV1Pda(EVENT).toBase58();
  const event = Buffer.concat([Buffer.from(SPONSORSHIP_EVENT_V1_DISCRIMINATOR), Buffer.from([1]), id32(EVENT), pk(PK_B), pk(PK_A), u64(100), Buffer.from([1, 4])]);
  assert.equal(verifySponsorshipEventV1({ account: account(event), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: eventPda, expectedPda: eventPda, expectedEventId: EVENT, PublicKey }).ok, true);

  const vaultPda = deriveEventPrizeVaultV1Pda(EVENT).toBase58();
  const vault = Buffer.concat([Buffer.from(EVENT_PRIZE_VAULT_V1_DISCRIMINATOR), Buffer.from([1]), id32(EVENT), u64(71), u64(20), u64(10), u64(0), u64(0), u64(0), Buffer.from([5])]);
  const vaultVerified = verifyEventPrizeVaultV1({ account: account(vault), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: vaultPda, expectedPda: vaultPda, expectedEventId: EVENT });
  assert.equal(vaultVerified.ok, true);

  const receiptPda = deriveSponsorshipReceiptV1Pda(EVENT, PAYMENT, PK_B).toBase58();
  const receipt = Buffer.concat([Buffer.from(SPONSORSHIP_RECEIPT_V1_DISCRIMINATOR), Buffer.from([1]), id32(EVENT), id32(PAYMENT), pk(PK_B), u64(101), u64(71), u64(20), u64(10), i64(123), Buffer.from([6])]);
  const receiptVerified = verifySponsorshipReceiptV1({ account: account(receipt), owner: ARENA_MONEY_V2_PROGRAM_ID, accountAddress: receiptPda, expectedPda: receiptPda, expectedEventId: EVENT, expectedPaymentId: PAYMENT, expectedSponsor: PK_B.toBase58(), expectedGrossLamports: 101, expectedPrizeLamports: 71, expectedMarketingLamports: 20, expectedProtocolLamports: 10, PublicKey });
  assert.equal(receiptVerified.ok, true);

  const state = verifySolanaSponsorshipVaultState({
    eventId: EVENT,
    receipt: receiptVerified.receipt,
    vault: vaultVerified.vault,
    expectedSplit: { gross: 101n, prize: 71n, marketing: 20n, protocol: 10n },
  });
  assert.equal(state.gross, 101n);
  assert.deepEqual(sponsorshipVaultLifetimeTotals(vaultVerified.vault), { prize: 71n, marketing: 20n, protocol: 10n });
  assert.throws(
    () => verifySolanaSponsorshipVaultState({ eventId: FUND, receipt: receiptVerified.receipt, vault: vaultVerified.vault, expectedSplit: { gross: 101n, prize: 71n, marketing: 20n, protocol: 10n } }),
    /event identity mismatch/,
  );
}

{
  const vaultPda = deriveEventPrizeVaultV1Pda(EVENT).toBase58();
  const connection = {
    async getTransaction() {
      return {
        transaction: { message: { accountKeys: [PK_A, new PublicKey(vaultPda)] } },
        meta: { err: null, preBalances: [10, 1_000], postBalances: [10, 1_101] },
      };
    },
  };
  const exact = await verifyExactVaultLamportDelta({ connection, signature: "fixture-signature", vaultPda, grossLamports: 101n });
  assert.equal(exact.deltaLamports, "101");
  await assert.rejects(
    () => verifyExactVaultLamportDelta({ connection, signature: "fixture-signature", vaultPda, grossLamports: 100n }),
    /does not equal gross sponsorship payment/,
  );
}

console.log("Solana Arena Money V2 runtime certification tests passed");
