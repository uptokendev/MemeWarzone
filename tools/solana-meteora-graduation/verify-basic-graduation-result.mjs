import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");
const METEORA_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POSITION_POOL_OFFSET = 8;
const POSITION_NFT_MINT_OFFSET = 40;
const POSITION_UNLOCKED_LIQUIDITY_OFFSET = 152;
const POSITION_PERMANENT_LOCKED_LIQUIDITY_OFFSET = 184;
const CAMPAIGN_GRADUATED_OFFSET = 713;

function fail(message) { throw new Error(`[verify-basic-graduation-result] ${message}`); }
function readU128LE(buf, offset) {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(buf[offset + i]);
  return value;
}
function readPubkey(buf, offset) { return new PublicKey(buf.subarray(offset, offset + 32)); }
function parseGraduationLog(text) {
  const match = text.match(/GRADUATED\s+(\S+)\s+pool\s+(\S+)\s+position\s+(\S+)/);
  if (!match) fail("GRADUATED signature/pool/position line is missing");
  return { signature: match[1], pool: new PublicKey(match[2]), position: new PublicKey(match[3]) };
}

async function main() {
  const campaignArg = process.argv[2];
  const logPath = process.argv[3];
  const quoteMintArg = process.argv[4];
  if (!campaignArg || !logPath || !quoteMintArg) fail("usage: node verify-basic-graduation-result.mjs <CAMPAIGN> <RUNNER_LOG> <QUOTE_MINT>");
  if (!fs.existsSync(logPath)) fail(`runner log missing: ${logPath}`);
  const rpcUrl = String(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com");
  const connection = new Connection(rpcUrl, "confirmed");
  const campaign = new PublicKey(campaignArg);
  const quoteMint = new PublicKey(quoteMintArg);
  const parsed = parseGraduationLog(fs.readFileSync(logPath, "utf8"));
  const [campaignInfo, poolInfo, positionInfo, tx] = await Promise.all([
    connection.getAccountInfo(campaign, "confirmed"),
    connection.getAccountInfo(parsed.pool, "confirmed"),
    connection.getAccountInfo(parsed.position, "confirmed"),
    connection.getTransaction(parsed.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
  ]);
  if (!campaignInfo || !campaignInfo.owner.equals(PROGRAM_ID)) fail("campaign account missing or wrong owner");
  if (campaignInfo.data.length <= CAMPAIGN_GRADUATED_OFFSET || campaignInfo.data[CAMPAIGN_GRADUATED_OFFSET] !== 1) fail("campaign is not marked graduated");
  if (!poolInfo || !poolInfo.owner.equals(METEORA_PROGRAM)) fail("resulting pool missing or not owned by Meteora CP-AMM");
  if (!positionInfo || !positionInfo.owner.equals(METEORA_PROGRAM)) fail("resulting position missing or not owned by Meteora CP-AMM");
  if (positionInfo.data.length < 200) fail("Meteora position account is too short");
  const positionPool = readPubkey(positionInfo.data, POSITION_POOL_OFFSET);
  if (!positionPool.equals(parsed.pool)) fail("Meteora position pool binding mismatch");
  const positionNftMint = readPubkey(positionInfo.data, POSITION_NFT_MINT_OFFSET);
  const unlockedLiquidity = readU128LE(positionInfo.data, POSITION_UNLOCKED_LIQUIDITY_OFFSET);
  const permanentLockedLiquidity = readU128LE(positionInfo.data, POSITION_PERMANENT_LOCKED_LIQUIDITY_OFFSET);
  if (unlockedLiquidity !== 0n || permanentLockedLiquidity <= 0n) fail("Meteora position is not permanently locked");
  if (!tx || tx.meta?.err) fail("graduation transaction missing or failed");
  const report = {
    campaign: campaign.toBase58(), signature: parsed.signature, quoteMint: quoteMint.toBase58(),
    meteoraPool: parsed.pool.toBase58(), meteoraPosition: parsed.position.toBase58(),
    positionNftMint: positionNftMint.toBase58(), unlockedLiquidity: unlockedLiquidity.toString(),
    permanentLockedLiquidity: permanentLockedLiquidity.toString(), transactionVersion: tx.version,
    campaignGraduated: true, permanentCustody: true,
  };
  const output = String(process.env.SOLANA_BASIC_RESULT_REPORT || "").trim();
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
