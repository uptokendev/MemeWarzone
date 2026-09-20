import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "solanaArenaV0.ts"), "utf8");

test("Arena executor stays on the user V0 envelope without ALT or Legacy", () => {
  assert.match(source, /compileSolanaUserV0WithLatestBlockhash/);
  assert.match(source, /simulateSolanaUserV0OrThrow/);
  assert.match(source, /allowAdditionalInstructions: true/);
  assert.match(source, /instructions\?: TransactionInstruction\[\]/);
  assert.doesNotMatch(source, /new web3\.Transaction\s*\(/);
  assert.doesNotMatch(source, /compileToV0Message\(\s*lookup/);
  assert.doesNotMatch(source, /Ed25519/);
  assert.doesNotMatch(source, /claim_charity/);
  assert.doesNotMatch(source, /solanaV0Transaction/);
});

test("builders use frozen v2 / claim_winner discriminators", () => {
  assert.match(source, /open_battle_pool_v2/);
  assert.match(source, /deposit_stake_v2/);
  assert.match(source, /donate_support_v2/);
  assert.match(source, /deposit_buy_in_v2/);
  assert.match(source, /claim_winner/);
  assert.match(source, /refund_stake/);
  assert.match(source, /refund_buy_in_v2/);
  assert.match(source, /settle_expired_pool/);
  const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  assert.equal(disc("open_battle_pool_v2").length, 8);
});

test("prize-boost builders stay in the executor but are not a Batch 3 UI path", () => {
  assert.match(source, /deposit_prize_boost_v2/);
  assert.match(source, /refund_prize_boost_v2/);
  const ui = fs.readFileSync(path.join(root, "../components/arena/ArenaStakeButton.tsx"), "utf8");
  assert.doesNotMatch(ui, /prize_boost/);
});

test("Support and Buy-in consume explicit live, never live: configured", () => {
  const support = fs.readFileSync(path.join(root, "../components/arena/ArenaSupportButton.tsx"), "utf8");
  const buyIn = fs.readFileSync(path.join(root, "../components/arena/ArenaBuyInButton.tsx"), "utf8");
  const claim = fs.readFileSync(path.join(root, "../components/arena/ArenaWarPoolClaimButton.tsx"), "utf8");
  assert.doesNotMatch(support, /live:\s*configured/);
  assert.match(support, /live:\s*liveFlag/);
  assert.match(buyIn, /live:\s*liveFlag/);
  assert.match(claim, /isSolanaWarzoneMoneyLive/);
});

test("buy-in receipt endpoint verifies the authoritative PDA, not existence", () => {
  const apiRoot = path.join(root, "../../api");
  const tournaments = fs.readFileSync(path.join(apiRoot, "arenaTournaments.js"), "utf8");
  const reader = fs.readFileSync(path.join(apiRoot, "lib/solanaArenaPoolRead.js"), "utf8");
  const handler = tournaments.split("async function handleBuyInReceipt")[1]?.split("async function handleAdminList")[0] || "";
  assert.match(handler, /readAuthoritativeBuyInReceipt/);
  assert.match(handler, /BUY_IN_RECEIPT_INVALID/);
  assert.match(reader, /verifyAuthoritativeBuyInReceipt/);
  assert.doesNotMatch(handler, /getAccountInfo/);
});

// Every Arena action is a single instruction the creator signs in a wallet, so
// each one has to leave Phantom room to rewrite it. Measured rather than
// asserted from the source: a regex cannot tell you how large a transaction
// compiles to, which is exactly how the launchpad's create grew to 1087 bytes
// and started being blocked as a malicious dApp.
test("every Arena transaction leaves the wallet room to rewrite it", async () => {
  const web3 = await import("@solana/web3.js");
  const { build } = await import("esbuild");
  const os = await import("node:os");

  const bundlePath = path.join(os.tmpdir(), `arena-size-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, "solanaArenaV0.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile: bundlePath,
    external: ["@solana/web3.js"],
    alias: { "@": path.join(root, "..") },
    define: {
      "import.meta.env.VITE_FRONTEND_API_BASE": '""',
      "import.meta.env": "globalThis.__VITE_ENV__",
    },
    logLevel: "silent",
  });
  globalThis.__VITE_ENV__ = {};

  try {
    const A = await import(`file://${bundlePath}`);
    const { SOLANA_WALLET_REWRITE_BUDGET_BYTES: BUDGET, SOLANA_USER_V0_PACKET_LIMIT_BYTES: PACKET } =
      await (await import("../../scripts/load-solana-v0-module.mjs")).loadSolanaUserV0Module();

    const key = () => web3.Keypair.generate().publicKey.toBase58();
    const poolId = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
    const fundingId = Uint8Array.from({ length: 32 }, (_, i) => (i + 91) & 0xff);
    const payer = web3.Keypair.generate().publicKey;
    const blockhash = web3.Keypair.generate().publicKey.toBase58();
    const owner = key();
    const common = { web3, poolId };

    const cases = [
      ["open_battle_pool_v2", () => A.buildArenaOpenBattleV0Instruction({ ...common, opener: owner, assetA: key(), assetB: key(), ownerA: owner, ownerB: key(), requiredStakeA: 1_000_000_000n, requiredStakeB: 1_000_000_000n, supportDeadline: 1800000000n, depositDeadline: 1800000001n, resolveDeadline: 1800000002n })],
      ["deposit_stake_v2", () => A.buildArenaDepositStakeV0Instruction({ ...common, staker: key() })],
      ["support_v2", () => A.buildArenaSupportV0Instruction({ ...common, donor: key(), amountLamports: 500_000_000n })],
      ["buy_in_v2", () => A.buildArenaBuyInV0Instruction({ ...common, entryAsset: key(), entrant: key(), amountLamports: 500_000_000n })],
      ["prize_boost_v2", () => A.buildArenaPrizeBoostV0Instruction({ ...common, fundingId, funder: key(), amountLamports: 500_000_000n })],
      ["claim_winner", () => A.buildArenaWinnerClaimV0Instruction({ ...common, winner: key() })],
      ["stake_refund_v2", () => A.buildArenaStakeRefundV0Instruction({ ...common, staker: key() })],
      ["buy_in_refund_v2", () => A.buildArenaBuyInRefundV0Instruction({ ...common, entryAsset: key(), entrant: key() })],
      ["prize_boost_refund_v2", () => A.buildArenaPrizeBoostRefundV0Instruction({ ...common, fundingId, funder: key() })],
      ["settle_expired_v2", () => A.buildArenaSettleExpiredV0Instruction({ ...common, caller: key() })],
    ];

    for (const [name, make] of cases) {
      const { instruction } = await make();
      const message = new web3.TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [instruction],
      }).compileToV0Message();
      const bytes = new web3.VersionedTransaction(message).serialize().length;
      assert.ok(
        PACKET - bytes >= BUDGET,
        `${name} is ${bytes} bytes, leaving ${PACKET - bytes} for the wallet; it needs ${BUDGET}`,
      );
    }
  } finally {
    fs.rmSync(bundlePath, { force: true });
  }
});
