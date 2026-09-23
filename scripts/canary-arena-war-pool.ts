/**
 * Drive one real battle through ArenaWarPoolTreasuryV2 on a testnet.
 *
 * Opens a pool, has both sides stake, boosts one side with a signed quote,
 * resolves it with the resolver's signature, then claims all three buckets and
 * checks every wei against the constants the contract advertises: entry
 * 75/20/5, boosts 90/10. The split is the whole product promise on this
 * contract, so it is checked against balances that actually moved rather than
 * against the event, which is only what the contract says it did.
 *
 * Deposits are left paused afterwards, exactly as the deployment left them.
 *
 *   ARENA_CANARY_SEND=1 \
 *   WAR_POOL=0x... OWNER_A_PK=0x... OWNER_B_PK=0x... \
 *     npx hardhat run scripts/canary-arena-war-pool.ts --network bscTestnet
 */
import { ethers, network } from "hardhat";

const ENTRY_LEAGUE_BPS = 2000n;
const ENTRY_PROTOCOL_BPS = 500n;
const BOOST_PROTOCOL_BPS = 1000n;
const BPS = 10000n;

const ALLOWED_CHAINS: Record<string, bigint> = { bscTestnet: 97n, robinhoodTestnet: 46630n };

async function waitTx(tp: any, label: string) {
  const tx = await tp;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  console.log(`  ${label}: ${tx.hash}`);
  return receipt;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${actual}${ok ? "" : `  expected ${expected}`}`);
}

async function main() {
  const expectedChain = ALLOWED_CHAINS[network.name];
  if (!expectedChain) throw new Error(`arena canary refuses ${network.name}; testnets only`);
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== expectedChain) throw new Error(`${network.name} expects ${expectedChain}, got ${net.chainId}`);
  if (String(process.env.ARENA_CANARY_SEND || "").trim() !== "1") {
    throw new Error("refusing to send; set ARENA_CANARY_SEND=1");
  }

  const warPoolAddress = ethers.getAddress(String(process.env.WAR_POOL || "").trim());
  const [owner] = await ethers.getSigners();
  const ownerAddress = await owner.getAddress();
  const ownerA = new ethers.Wallet(String(process.env.OWNER_A_PK || "").trim(), ethers.provider);
  const ownerB = new ethers.Wallet(String(process.env.OWNER_B_PK || "").trim(), ethers.provider);

  const warPool = await ethers.getContractAt("ArenaWarPoolTreasuryV2", warPoolAddress, owner);
  const leagueAddress = ethers.getAddress(await (warPool as any).postGradLeagueTreasury());
  const protocolReceiver = ethers.getAddress(await (warPool as any).protocolReceiver());
  const resolverAddress = ethers.getAddress(await (warPool as any).resolver());
  const boostSigner = ethers.getAddress(await (warPool as any).boostQuoteSigner());

  console.log(`arena canary on ${network.name} (${net.chainId})`);
  console.log(`  warPool ${warPoolAddress}`);
  console.log(`  league  ${leagueAddress}`);
  console.log(`  protocol receiver ${protocolReceiver}`);
  console.log(`  resolver ${resolverAddress} boostSigner ${boostSigner}`);
  console.log(`  ownerA ${ownerA.address} ownerB ${ownerB.address}`);
  check("GENERATION", await (warPool as any).GENERATION(), 2n);
  check("ENTRY_LEAGUE_BPS", await (warPool as any).ENTRY_LEAGUE_BPS(), ENTRY_LEAGUE_BPS);
  check("ENTRY_PROTOCOL_BPS", await (warPool as any).ENTRY_PROTOCOL_BPS(), ENTRY_PROTOCOL_BPS);
  check("BOOST_PROTOCOL_BPS", await (warPool as any).BOOST_PROTOCOL_BPS(), BOOST_PROTOCOL_BPS);

  // The resolver and the boost signer are the deployer in a testnet deployment.
  if (resolverAddress !== ownerAddress || boostSigner !== ownerAddress) {
    throw new Error("this canary signs as the deployer; resolver/boostQuoteSigner must be it");
  }

  const stakeAmount = ethers.parseEther(String(process.env.STAKE_ETH || "0.002"));
  const boostAmount = ethers.parseEther(String(process.env.BOOST_ETH || "0.001"));
  const poolId = ethers.id(`arena-canary:${network.name}:${Date.now()}`);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const depositDeadline = now + 3600n;
  const resolveDeadline = now + 7200n;

  const depositsWerePaused = await (warPool as any).depositsPaused();
  if (depositsWerePaused) await waitTx((warPool as any).setDepositsPaused(false), "setDepositsPaused(false)");

  await waitTx(
    (warPool as any).openBattlePool(poolId, ownerA.address, ownerB.address, stakeAmount, depositDeadline, resolveDeadline),
    "openBattlePool",
  );
  await waitTx((warPool as any).connect(ownerA).depositStake(poolId, { value: stakeAmount }), "depositStake(A)");
  await waitTx((warPool as any).connect(ownerB).depositStake(poolId, { value: stakeAmount }), "depositStake(B)");

  // Boost one side with a signed quote, which is how the app prices them.
  const domain = { name: "ArenaWarPoolTreasury", version: "2", chainId: Number(net.chainId), verifyingContract: warPoolAddress };
  const boostTypes = {
    BoostQuote: [
      { name: "poolId", type: "bytes32" }, { name: "matchId", type: "bytes32" }, { name: "roundNumber", type: "uint256" },
      { name: "booster", type: "address" }, { name: "sideToken", type: "address" }, { name: "boostUnits", type: "uint256" },
      { name: "unitPriceNativeRaw", type: "uint256" }, { name: "grossNativeRaw", type: "uint256" },
      { name: "pricingVersion", type: "uint256" }, { name: "oracleTimestamp", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const boostUnits = 1n;
  const boostQuote = {
    poolId, matchId: ethers.ZeroHash, roundNumber: 0n, booster: ownerB.address, sideToken: ownerA.address,
    boostUnits, unitPriceNativeRaw: boostAmount, grossNativeRaw: boostAmount,
    pricingVersion: 1n, oracleTimestamp: now, nonce: BigInt(Date.now()), deadline: now + 3600n,
  };
  const boostSignature = await owner.signTypedData(domain, boostTypes, boostQuote);
  await waitTx(
    (warPool as any).connect(ownerB).boostBattle(
      poolId, ownerA.address, boostUnits, boostAmount, 1n, now, boostQuote.nonce, boostQuote.deadline, boostSignature,
      { value: boostAmount },
    ),
    "boostBattle(B boosts A)",
  );

  const stakeTotal = stakeAmount * 2n;
  const entryGross = stakeTotal;
  const expectedLeague = (entryGross * ENTRY_LEAGUE_BPS) / BPS;
  const expectedEntryProtocol = (entryGross * ENTRY_PROTOCOL_BPS) / BPS;
  const expectedBoostProtocol = (boostAmount * BOOST_PROTOCOL_BPS) / BPS;
  const expectedProtocol = expectedEntryProtocol + expectedBoostProtocol;
  const expectedWinner = (entryGross - expectedLeague - expectedEntryProtocol) + (boostAmount - expectedBoostProtocol);

  const resolveDeadlineSig = now + 3600n;
  const resolveTypes = {
    ResolvePoolV2: [
      { name: "poolId", type: "bytes32" }, { name: "winnerPayout", type: "address" },
      { name: "stakeTotal", type: "uint256" }, { name: "buyInTotal", type: "uint256" },
      { name: "boostTotal", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const resolveSignature = await owner.signTypedData(domain, resolveTypes, {
    poolId, winnerPayout: ownerA.address, stakeTotal, buyInTotal: 0n, boostTotal: boostAmount, deadline: resolveDeadlineSig,
  });
  await waitTx((warPool as any).resolve(poolId, ownerA.address, resolveDeadlineSig, resolveSignature), "resolve(winner=A)");

  const resolved = await (warPool as any).pools(poolId);
  check("pendingWinner", resolved.pendingWinner, expectedWinner);
  check("pendingProtocol", resolved.pendingProtocol, expectedProtocol);
  check("pendingLeague", resolved.pendingLeague, expectedLeague);
  check("entry prize is 75%", resolved.pendingLeague + resolved.pendingProtocol + resolved.pendingWinner, stakeTotal + boostAmount);

  const poolContractBefore = await ethers.provider.getBalance(warPoolAddress);
  const winnerBefore = await ethers.provider.getBalance(ownerA.address);
  const protocolBefore = await ethers.provider.getBalance(protocolReceiver);
  const leagueBefore = await ethers.provider.getBalance(leagueAddress);

  // Only the winner may claim, and the payout goes to msg.sender, so the
  // winner's own gas is unavoidable and has to be added back rather than
  // ignored -- otherwise the assertion quietly tolerates a short payout.
  const winnerReceipt = await waitTx((warPool as any).connect(ownerA).claimWinner(poolId), "claimWinner (by winner)");
  const winnerGas = BigInt(winnerReceipt.gasUsed) * BigInt(winnerReceipt.gasPrice ?? 0n);

  // These two are permissionless, so they are sent by someone who is not the
  // recipient and the recipient's balance moves by the payout alone.
  await waitTx((warPool as any).connect(ownerB).claimProtocol(poolId), "claimProtocol (by a third party)");
  const monthlyEpoch = ethers.id(`canary-monthly:${network.name}`);
  const quarterlyEpoch = ethers.id(`canary-quarterly:${network.name}`);
  await waitTx((warPool as any).connect(ownerB).claimLeague(poolId, monthlyEpoch, quarterlyEpoch), "claimLeague (by a third party)");

  check("winner received", (await ethers.provider.getBalance(ownerA.address)) - winnerBefore + winnerGas, expectedWinner);
  check("protocol received", (await ethers.provider.getBalance(protocolReceiver)) - protocolBefore, expectedProtocol);
  check("league received", (await ethers.provider.getBalance(leagueAddress)) - leagueBefore, expectedLeague);

  const after = await (warPool as any).pools(poolId);
  check("claimedWinner", after.claimedWinner, true);
  check("claimedProtocol", after.claimedProtocol, true);
  check("claimedLeague", after.claimedLeague, true);
  check("nothing left pending", after.pendingWinner + after.pendingProtocol + after.pendingLeague, 0n);

  // The contract's own balance, not its absolute value: it may still custody
  // other pools, and asserting it is empty would only be true on a chain where
  // this canary had never run before.
  const poolContractAfter = await ethers.provider.getBalance(warPoolAddress);
  check("contract paid out exactly this pool", poolContractBefore - poolContractAfter, expectedWinner + expectedProtocol + expectedLeague);

  // Deposits go back to closed, which is the state the deployment leaves and
  // the state this contract must sit in until the founder opens it. Restoring
  // "whatever it was" is not good enough: a previous interrupted run can leave
  // it open, and then the canary would hand it back open.
  if (!(await (warPool as any).depositsPaused())) {
    await waitTx((warPool as any).setDepositsPaused(true), "setDepositsPaused(true)");
  }
  check("deposits closed again", await (warPool as any).depositsPaused(), true);
  void depositsWerePaused;

  if (failures > 0) throw new Error(`${failures} arena canary checks failed`);
  console.log("\nARENA CANARY PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
