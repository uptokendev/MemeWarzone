import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
} from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import { loadSolanaLaunchpadInstructions, loadSolanaV0Module } from "./load-solana-v0-module.mjs";

const ALT = process.argv[2] || process.env.SOLANA_LAUNCHPAD_ALT_ADDRESS || "";
if (!ALT) {
  throw new Error("pass the launchpad ALT address");
}

const bytes32 = (fill) => Array.from({ length: 32 }, (_, index) => (fill + index) & 0xff);
function planAddress(plan, label) {
  const entry = plan.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ALT plan address: ${label}`);
  return entry.address.toBase58();
}

const v0 = await loadSolanaV0Module();
const instructions = await loadSolanaLaunchpadInstructions();
const connection = new Connection(
  String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim(),
  "confirmed",
);
const plan = v0.buildLaunchpadAltPlan(web3);
const table = await v0.fetchAndVerifyLaunchpadLookupTable(web3, connection, {
  address: ALT,
  requiredAddresses: plan.map((entry) => entry.address),
});
const planSet = new Set(plan.map((entry) => entry.address.toBase58()));
const extra = table.state.addresses.map((address) => address.toBase58()).filter((address) => !planSet.has(address));
const blockhash = Keypair.generate().publicKey.toBase58();

const payer = Keypair.generate().publicKey;
const ed25519 = instructions.buildLaunchpadEd25519Instruction(web3, {
  publicKey: Keypair.generate().publicKey.toBase58(),
  message: Uint8Array.from(bytes32(1)),
  signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 7) & 0xff),
});
const createIx = instructions.buildCreateCampaignInstruction(web3, {
  programId: v0.SOLANA_LAUNCHPAD_PROGRAM_ID,
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
    globalConfig: planAddress(plan, "globalConfig"),
    generationConfig: Keypair.generate().publicKey.toBase58(),
    creatorProfile: Keypair.generate().publicKey.toBase58(),
    riskProfile: Keypair.generate().publicKey.toBase58(),
    clusterProfile: Keypair.generate().publicKey.toBase58(),
    campaign: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    tokenVault: Keypair.generate().publicKey.toBase58(),
    solVault: Keypair.generate().publicKey.toBase58(),
    createAuthorization: Keypair.generate().publicKey.toBase58(),
    instructions: planAddress(plan, "instructionsSysvar"),
    tokenProgram: planAddress(plan, "tokenProgram"),
    systemProgram: planAddress(plan, "systemProgram"),
  },
});
const create = v0.compileAndAssertLaunchpadV0(
  web3,
  {
    payer,
    recentBlockhash: blockhash,
    instructions: [ed25519, createIx],
    lookupTableAccounts: [table],
  },
  { payer, ed25519Instruction: ed25519, programInstruction: createIx },
);

function compileTrade(side) {
  const trader = Keypair.generate().publicKey;
  const ed25519Instruction = instructions.buildLaunchpadEd25519Instruction(web3, {
    publicKey: Keypair.generate().publicKey.toBase58(),
    message: Uint8Array.from(bytes32(11)),
    signature: Uint8Array.from({ length: 64 }, (_, index) => (index + 19) & 0xff),
  });
  const programInstruction = instructions.buildTradeTokensInstruction(web3, {
    programId: v0.SOLANA_LAUNCHPAD_PROGRAM_ID,
    side,
    amountIn: side === "buy" ? "100000000" : "1000000",
    minOut: "1",
    deadline: "1770000000",
    nonce: bytes32(12),
    nativeTargetLamports: side === "buy" ? "100000000" : undefined,
    routeProfile: 1,
    accounts: {
      trader: trader.toBase58(),
      globalConfig: planAddress(plan, "globalConfig"),
      campaign: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      tokenVault: Keypair.generate().publicKey.toBase58(),
      solVault: Keypair.generate().publicKey.toBase58(),
      traderTokenAccount: Keypair.generate().publicKey.toBase58(),
      riskProfile: Keypair.generate().publicKey.toBase58(),
      clusterProfile: Keypair.generate().publicKey.toBase58(),
      tradeAuthorization: Keypair.generate().publicKey.toBase58(),
      instructions: planAddress(plan, "instructionsSysvar"),
      tokenProgram: planAddress(plan, "tokenProgram"),
      systemProgram: planAddress(plan, "systemProgram"),
      feeEscrow: Keypair.generate().publicKey.toBase58(),
      creatorFeeVault: Keypair.generate().publicKey.toBase58(),
    },
  });
  return v0.compileAndAssertLaunchpadV0(
    web3,
    {
      payer: trader,
      recentBlockhash: blockhash,
      instructions: [
        ed25519Instruction,
        programInstruction,
      ],
      lookupTableAccounts: [table],
    },
    { payer: trader, ed25519Instruction, programInstruction },
  );
}

const buy = compileTrade("buy");
const sell = compileTrade("sell");
console.log(JSON.stringify({
  address: ALT,
  authority: table.state.authority?.toBase58?.() || null,
  frozen: !table.state.authority,
  addressCount: table.state.addresses.length,
  requiredAddressCount: plan.length,
  extra,
  create: create.stats,
  buy: buy.stats,
  sell: sell.stats,
}, null, 2));
