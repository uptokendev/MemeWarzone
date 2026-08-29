import assert from "node:assert/strict";
import test from "node:test";

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import {
  loadSolanaLaunchpadInstructions,
  loadSolanaV0Module,
} from "../../scripts/load-solana-v0-module.mjs";

const {
  SOLANA_RELEASE_MAX_BYTES,
  assertLaunchpadV0Intent,
  assertLookupTableContains,
  buildLaunchpadAltPlan,
  buildLaunchpadV0Transaction,
  compileAndAssertLaunchpadV0,
  compileLaunchpadV0WithLatestBlockhash,
  configuredLaunchpadAltAddress,
  inspectLaunchpadV0Envelope,
  requireLaunchpadAltAddress,
} = await loadSolanaV0Module();
const {
  buildCreateCampaignInstruction,
  buildLaunchpadEd25519Instruction,
  buildTradeTokensInstruction,
} = await loadSolanaLaunchpadInstructions();

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const U64_MAX = (1n << 64n) - 1n;

function randomKeys(count) {
  return Array.from({ length: count }, () => Keypair.generate().publicKey);
}

function makeLookupTable(addresses) {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: U64_MAX,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: Keypair.generate().publicKey,
      addresses,
    },
  });
}

function makeEd25519Instruction() {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: Keypair.generate().publicKey.toBytes(),
    message: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 7) & 0xff),
  });
}

function legacyBytes(payer, instructions) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(...instructions);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

function reportSize(flow, legacy, stats) {
  console.info(`[solana-v0-gate] ${flow}`, {
    legacyBytes: legacy,
    v0Bytes: stats.serializedBytes,
    bytesSaved: legacy - stats.serializedBytes,
    requiredSigners: stats.requiredSigners,
    lookedUpAccounts: stats.lookupReadonlyCount + stats.lookupWritableCount,
    releaseMaxBytes: SOLANA_RELEASE_MAX_BYTES,
  });
}

function bytes32(fill) {
  return Array.from({ length: 32 }, (_, index) => (fill + index) & 0xff);
}

function planAddress(plan, label) {
  const entry = plan.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ALT plan address: ${label}`);
  return entry.address;
}

function makeProductionCreateFixture() {
  const payer = Keypair.generate().publicKey;
  const plan = buildLaunchpadAltPlan(web3);
  const lookupTable = makeLookupTable(plan.map((entry) => entry.address));
  const ed25519Instruction = buildLaunchpadEd25519Instruction(web3, {
    publicKey: Keypair.generate().publicKey.toBase58(),
    message: Uint8Array.from(bytes32(1)),
    signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 7) & 0xff),
  });
  const programInstruction = buildCreateCampaignInstruction(web3, {
    programId: PROGRAM_ID.toBase58(),
    args: {
      campaignId: bytes32(2),
      metadataHash: bytes32(3),
      clusterHash: bytes32(4),
      tickerHash: bytes32(5),
      reservationIdHash: bytes32(6),
      reservationVersion: "1",
      launchAt: "0",
      graduationTargetUsdMicros: "6000000",
      deadline: "1770000000",
      nonce: bytes32(7),
    },
    accounts: {
      creator: payer.toBase58(),
      globalConfig: planAddress(plan, "globalConfig").toBase58(),
      generationConfig: Keypair.generate().publicKey.toBase58(),
      creatorProfile: Keypair.generate().publicKey.toBase58(),
      riskProfile: Keypair.generate().publicKey.toBase58(),
      clusterProfile: Keypair.generate().publicKey.toBase58(),
      campaign: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      tokenVault: Keypair.generate().publicKey.toBase58(),
      solVault: Keypair.generate().publicKey.toBase58(),
      createAuthorization: Keypair.generate().publicKey.toBase58(),
      instructions: planAddress(plan, "instructionsSysvar").toBase58(),
      tokenProgram: planAddress(plan, "tokenProgram").toBase58(),
      systemProgram: planAddress(plan, "systemProgram").toBase58(),
    },
  });
  return { payer, plan, ed25519Instruction, programInstruction, lookupTable };
}

function makeProductionTradeFixture(side = "buy") {
  const payer = Keypair.generate().publicKey;
  const plan = buildLaunchpadAltPlan(web3);
  const lookupTable = makeLookupTable(plan.map((entry) => entry.address));
  const ed25519Instruction = buildLaunchpadEd25519Instruction(web3, {
    publicKey: Keypair.generate().publicKey.toBase58(),
    message: Uint8Array.from(bytes32(11)),
    signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 19) & 0xff),
  });
  const programInstruction = buildTradeTokensInstruction(web3, {
    programId: PROGRAM_ID.toBase58(),
    side,
    amountIn: side === "buy" ? "100000000" : "1000000",
    minOut: side === "buy" ? "1" : "1",
    deadline: "1770000000",
    nonce: bytes32(12),
    nativeTargetLamports: side === "buy" ? "100000000" : undefined,
    routeProfile: 1,
    accounts: {
      trader: payer.toBase58(),
      globalConfig: planAddress(plan, "globalConfig").toBase58(),
      campaign: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      tokenVault: Keypair.generate().publicKey.toBase58(),
      solVault: Keypair.generate().publicKey.toBase58(),
      traderTokenAccount: Keypair.generate().publicKey.toBase58(),
      riskProfile: Keypair.generate().publicKey.toBase58(),
      clusterProfile: Keypair.generate().publicKey.toBase58(),
      tradeAuthorization: Keypair.generate().publicKey.toBase58(),
      instructions: planAddress(plan, "instructionsSysvar").toBase58(),
      tokenProgram: planAddress(plan, "tokenProgram").toBase58(),
      systemProgram: planAddress(plan, "systemProgram").toBase58(),
      feeEscrow: Keypair.generate().publicKey.toBase58(),
      creatorFeeVault: Keypair.generate().publicKey.toBase58(),
    },
  });
  return { payer, plan, ed25519Instruction, programInstruction, lookupTable };
}

function makeTradeFixture(extraSigner = false) {
  const payer = Keypair.generate().publicKey;
  const staticAccounts = randomKeys(10);
  const dynamicAccounts = randomKeys(8);
  const extraSignerKey = Keypair.generate().publicKey;
  const ed25519Instruction = makeEd25519Instruction();
  const programInstruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ...staticAccounts.map((pubkey, index) => ({
        pubkey,
        isSigner: false,
        isWritable: index >= 4,
      })),
      ...dynamicAccounts.map((pubkey, index) => ({
        pubkey,
        isSigner: extraSigner && index === 0,
        isWritable: index % 2 === 0,
      })),
      ...(extraSigner ? [{ pubkey: extraSignerKey, isSigner: true, isWritable: false }] : []),
    ],
    data: Buffer.alloc(73, 0x33),
  });
  const lookupTable = makeLookupTable(staticAccounts);
  const computeInstruction = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  return { payer, staticAccounts, ed25519Instruction, programInstruction, computeInstruction, lookupTable };
}

test("production CREATE instruction compiles to a one-signer V0 envelope under the release ceiling", () => {
  const fixture = makeProductionCreateFixture();
  const instructions = [fixture.ed25519Instruction, fixture.programInstruction];
  const legacy = legacyBytes(fixture.payer, instructions);
  const { stats } = compileAndAssertLaunchpadV0(
    web3,
    {
      payer: fixture.payer,
      recentBlockhash: BLOCKHASH,
      instructions,
      lookupTableAccounts: [fixture.lookupTable],
    },
    {
      payer: fixture.payer,
      ed25519Instruction: fixture.ed25519Instruction,
      programInstruction: fixture.programInstruction,
    },
  );

  reportSize("CREATE", legacy, stats);
  assert.equal(fixture.programInstruction.keys.length, 14);
  assert.equal(fixture.programInstruction.data.length, 232);
  assert.equal(stats.requiredSigners, 1);
  assert.equal(stats.instructionCount, 2);
  assert.ok(stats.lookupReadonlyCount + stats.lookupWritableCount >= 4);
  assert.ok(stats.serializedBytes <= SOLANA_RELEASE_MAX_BYTES);
  assert.ok(stats.serializedBytes < legacy, `${stats.serializedBytes} must be smaller than legacy ${legacy}`);
});

test("production BUY and SELL instructions compile to one-signer V0 envelopes under the release ceiling", () => {
  for (const side of ["buy", "sell"]) {
    const fixture = makeProductionTradeFixture(side);
    const instructions = [
      fixture.ed25519Instruction,
      fixture.programInstruction,
    ];
    const legacy = legacyBytes(fixture.payer, instructions);
    const { stats } = compileAndAssertLaunchpadV0(
      web3,
      {
        payer: fixture.payer,
        recentBlockhash: BLOCKHASH,
        instructions,
        lookupTableAccounts: [fixture.lookupTable],
      },
      {
        payer: fixture.payer,
        ed25519Instruction: fixture.ed25519Instruction,
        programInstruction: fixture.programInstruction,
      },
    );

    reportSize(side === "buy" ? "BUY" : "SELL", legacy, stats);
    assert.equal(fixture.programInstruction.keys.length, 15);
    assert.equal(fixture.programInstruction.data.length, side === "buy" ? 73 : 65);
    assert.equal(stats.requiredSigners, 1);
    assert.equal(stats.instructionCount, 2);
    assert.ok(stats.serializedBytes <= SOLANA_RELEASE_MAX_BYTES);
  }
});

test("fresh blockhash rebuild keeps the same production CREATE intent and envelope size", async () => {
  const fixture = makeProductionCreateFixture();
  const instructions = [fixture.ed25519Instruction, fixture.programInstruction];
  const first = compileAndAssertLaunchpadV0(
    web3,
    {
      payer: fixture.payer,
      recentBlockhash: BLOCKHASH,
      instructions,
      lookupTableAccounts: [fixture.lookupTable],
    },
    {
      payer: fixture.payer,
      ed25519Instruction: fixture.ed25519Instruction,
      programInstruction: fixture.programInstruction,
    },
  );
  const nextBlockhash = Keypair.generate().publicKey.toBase58();
  const rebuilt = await compileLaunchpadV0WithLatestBlockhash(
    web3,
    {
      getLatestBlockhash: async () => ({ blockhash: nextBlockhash, lastValidBlockHeight: 42 }),
    },
    {
      payer: fixture.payer,
      instructions,
      lookupTableAccounts: [fixture.lookupTable],
    },
    {
      payer: fixture.payer,
      ed25519Instruction: fixture.ed25519Instruction,
      programInstruction: fixture.programInstruction,
    },
  );

  assert.equal(rebuilt.latest.blockhash, nextBlockhash);
  assert.notEqual(nextBlockhash, BLOCKHASH);
  assert.equal(rebuilt.stats.serializedBytes, first.stats.serializedBytes);
  assert.equal(rebuilt.stats.requiredSigners, 1);
  assert.equal(rebuilt.stats.instructionCount, first.stats.instructionCount);
});

test("wallet assertions may be appended but cannot break Ed25519 -> MemeWarzone adjacency", () => {
  const fixture = makeTradeFixture();
  const walletAssertion = new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [],
    data: Buffer.from([1, 2, 3, 4]),
  });

  const safe = buildLaunchpadV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      fixture.computeInstruction,
      fixture.ed25519Instruction,
      fixture.programInstruction,
      walletAssertion,
    ],
    lookupTableAccounts: [fixture.lookupTable],
  });
  assert.doesNotThrow(() => assertLaunchpadV0Intent(web3, safe, {
    payer: fixture.payer,
    ed25519Instruction: fixture.ed25519Instruction,
    programInstruction: fixture.programInstruction,
    lookupTableAccounts: [fixture.lookupTable],
  }));

  const unsafe = buildLaunchpadV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      fixture.computeInstruction,
      fixture.ed25519Instruction,
      walletAssertion,
      fixture.programInstruction,
    ],
    lookupTableAccounts: [fixture.lookupTable],
  });
  assert.throws(() => assertLaunchpadV0Intent(web3, unsafe, {
    payer: fixture.payer,
    ed25519Instruction: fixture.ed25519Instruction,
    programInstruction: fixture.programInstruction,
    lookupTableAccounts: [fixture.lookupTable],
  }), /immediately before MemeWarzone/i);
});

test("V0 gate rejects a transaction that gains a second required signer", () => {
  const fixture = makeTradeFixture(true);
  const transaction = buildLaunchpadV0Transaction(web3, {
    payer: fixture.payer,
    recentBlockhash: BLOCKHASH,
    instructions: [fixture.computeInstruction, fixture.ed25519Instruction, fixture.programInstruction],
    lookupTableAccounts: [fixture.lookupTable],
  });
  const stats = inspectLaunchpadV0Envelope(web3, transaction, [fixture.lookupTable]);
  assert.ok(stats.requiredSigners > 1);
  assert.throws(() => assertLaunchpadV0Intent(web3, transaction, {
    payer: fixture.payer,
    ed25519Instruction: fixture.ed25519Instruction,
    programInstruction: fixture.programInstruction,
    lookupTableAccounts: [fixture.lookupTable],
    releaseMaxBytes: null,
  }), /exactly one signer/i);
});

test("ALT verification fails closed when a required static address is missing", () => {
  const addresses = randomKeys(5);
  const lookupTable = makeLookupTable(addresses);
  assert.doesNotThrow(() => assertLookupTableContains(lookupTable, addresses));
  assert.throws(
    () => assertLookupTableContains(lookupTable, [...addresses, Keypair.generate().publicKey]),
    /missing required addresses/i,
  );
});

test("launchpad ALT plan is deterministic and unique", () => {
  const first = buildLaunchpadAltPlan(web3);
  const second = buildLaunchpadAltPlan(web3);
  assert.equal(first.length, second.length);
  assert.deepEqual(
    first.map((entry) => entry.address.toBase58()),
    second.map((entry) => entry.address.toBase58()),
  );
  assert.ok(first.length >= 15);
  assert.equal(new Set(first.map((entry) => entry.label)).size, first.length);
  for (const label of [
    "memewarzoneProgram",
    "globalConfig",
    "ed25519Program",
    "tokenProgram",
    "systemProgram",
    "rewardsTreasuryProgram",
    "weeklyLeagueVault",
    "protocolVault",
  ]) {
    assert.ok(first.some((entry) => entry.label === label), `ALT plan missing ${label}`);
  }
});

test("launchpad ALT address is fail-closed until configured", () => {
  const previous = process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS;
  const previousVite = process.env.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS;
  delete process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS;
  delete process.env.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS;
  try {
    assert.equal(configuredLaunchpadAltAddress(), "");
    assert.throws(() => requireLaunchpadAltAddress(), /VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS/);
    const address = Keypair.generate().publicKey.toBase58();
    process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS = address;
    assert.equal(configuredLaunchpadAltAddress(), address);
    assert.equal(requireLaunchpadAltAddress(), address);
  } finally {
    if (previous == null) delete process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS;
    else process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS = previous;
    if (previousVite == null) delete process.env.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS;
    else process.env.VITE_SOLANA_LAUNCHPAD_ALT_ADDRESS = previousVite;
  }
});

test("CREATE and BUY/SELL V0 compile through the same helper used by graduation", () => {
  const create = makeProductionCreateFixture();
  const trade = makeProductionTradeFixture("buy");
  const createCompiled = compileAndAssertLaunchpadV0(
    web3,
    {
      payer: create.payer,
      recentBlockhash: BLOCKHASH,
      instructions: [create.ed25519Instruction, create.programInstruction],
      lookupTableAccounts: [create.lookupTable],
    },
    {
      payer: create.payer,
      ed25519Instruction: create.ed25519Instruction,
      programInstruction: create.programInstruction,
    },
  );
  const tradeCompiled = compileAndAssertLaunchpadV0(
    web3,
    {
      payer: trade.payer,
      recentBlockhash: BLOCKHASH,
      instructions: [
        trade.ed25519Instruction,
        trade.programInstruction,
      ],
      lookupTableAccounts: [trade.lookupTable],
    },
    {
      payer: trade.payer,
      ed25519Instruction: trade.ed25519Instruction,
      programInstruction: trade.programInstruction,
    },
  );
  assert.equal(createCompiled.stats.requiredSigners, 1);
  assert.equal(tradeCompiled.stats.requiredSigners, 1);
  assert.ok(createCompiled.stats.serializedBytes <= SOLANA_RELEASE_MAX_BYTES);
  assert.ok(tradeCompiled.stats.serializedBytes <= SOLANA_RELEASE_MAX_BYTES);
});
