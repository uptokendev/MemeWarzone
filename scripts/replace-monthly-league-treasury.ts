/**
 * Replace the BNB / Robinhood MonthlyLeagueTreasury (2026-09-27).
 *
 * Both mainnet vaults were deployed with monthlyCapUsd = 30000 raw. sealMonth prices the cap as
 * monthlyCapUsd * 1e18 / oraclePrice(1e18), so the unit is USD with 18 decimals and 30000 raw is
 * $0.00000000000003: capNative came out at 38 wei (BNB) / 11 wei (Robinhood) and every sealMonth
 * reverts WinnerTotalAboveCap. The cap is immutable, so the vault is replaced:
 *
 *   1. deploy MonthlyLeagueTreasury(multisig = Safe, rootPoster = payout operator, oracle and charity
 *      taken from the old vault, cap = $30,000 in 18-decimal USD) -- only with MWZ_DEPLOY_SEND=1;
 *   2. Safe batch M1: router.proposeMonthlyLeagueTreasury(new), authorizeMonth x N on the new vault
 *      (same shape as P1: exceptional, so a month without winners cannot block the next), and the
 *      old vault's unallocated balance moved into the new one;
 *   3. Safe batch M2, after the router's upgradeDelay: router.acceptMonthlyLeagueTreasury().
 *
 * Every check is on the VALUE, not on presence: the cap is refused unless it prices back, through
 * the live oracle, to the intended dollar figure. Checking "the cap is set" is what let 30000 through.
 *
 *   PAYOUT_OPERATOR_ADDRESS=0x.. npx hardhat run scripts/replace-monthly-league-treasury.ts --network bscMainnet   # reads, plans
 *   MWZ_DEPLOY_SEND=1 PAYOUT_OPERATOR_ADDRESS=0x.. npx hardhat run ... --network bscMainnet                         # deploys + writes M1/M2
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { buildBatch } from "./make-safe-batch";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DAY = 86_400;
const WAD = 10n ** 18n;

/** $30,000 per month, mirroring the intent of the vaults it replaces. Whole dollars; scaled below. */
export const MONTHLY_CAP_USD_WHOLE = 30_000n;

type ChainSetup = { dir: string; native: string; router: string; oldMonthly: string; monthlyAuth: string };

export const CHAINS: Record<number, ChainSetup> = {
  56: { dir: "bnb", native: "BNB", router: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239", oldMonthly: "0xF62A09dea232bc8311D13bAEa89d79F48Cf7eCB8", monthlyAuth: "40" },
  4663: { dir: "robinhood", native: "ETH", router: "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb", oldMonthly: "0xE72A281b4A728AFb5fa836f593B56C8f74Fd4238", monthlyAuth: "12" },
};

/** monthlyCapUsd in the contract's unit: USD with 18 decimals. */
export function capUsdWad(wholeUsd: bigint = MONTHLY_CAP_USD_WHOLE): bigint {
  if (wholeUsd < 1n || wholeUsd > 10_000_000n) throw new Error(`monthly cap $${wholeUsd} is outside $1..$10M`);
  return wholeUsd * WAD;
}

/** The contract's own capNative (Math.mulDiv(cap, 1e18, price, Ceil)). */
export function capNativeAt(capUsd: bigint, oraclePriceWad: bigint): bigint {
  if (oraclePriceWad <= 0n) throw new Error("oracle price is zero");
  return (capUsd * WAD + oraclePriceWad - 1n) / oraclePriceWad;
}

/**
 * The value check: the cap, priced back through the live oracle, must be the intended dollar
 * figure (within $1 of rounding). Anything else is a unit mistake and is refused before signing.
 */
export function assertCapValue(capUsd: bigint, oraclePriceWad: bigint, wholeUsd: bigint = MONTHLY_CAP_USD_WHOLE) {
  const capNative = capNativeAt(capUsd, oraclePriceWad);
  const impliedUsd = (capNative * oraclePriceWad) / WAD / WAD;
  if (impliedUsd + 1n < wholeUsd || impliedUsd > wholeUsd + 1n) {
    throw new Error(`monthly cap ${capUsd} prices to $${impliedUsd} (${capNative} wei at ${oraclePriceWad}), not $${wholeUsd} -- unit mistake`);
  }
  return { capNative, impliedUsd };
}

export type Call = { contract: string; to: string; fn: string; args: unknown[] };

/** Month ids from the current month forward, with seal window [start of next month, +30 days]. */
export function monthAuthorizations(now: Date, months: number, maxWinnerPool: bigint, vault: string): Call[] {
  const calls: Call[] = [];
  for (let m = 0; m < months; m += 1) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const next = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) / 1000;
    const monthId = month.getUTCFullYear() * 100 + month.getUTCMonth() + 1;
    calls.push({ contract: "MonthlyLeagueTreasury", to: vault, fn: "authorizeMonth", args: [String(monthId), maxWinnerPool.toString(), String(next), String(next + 30 * DAY), true] });
  }
  return calls;
}

export function replacementBatches(input: { router: string; oldVault: string; newVault: string; oldUnallocated: bigint; now: Date; months: number; maxWinnerPool: bigint }) {
  const m1: Call[] = [
    { contract: "TreasuryRouterV3", to: input.router, fn: "proposeMonthlyLeagueTreasury", args: [input.newVault] },
    ...monthAuthorizations(input.now, input.months, input.maxWinnerPool, input.newVault),
  ];
  if (input.oldUnallocated > 0n) {
    m1.push({ contract: "MonthlyLeagueTreasury", to: input.oldVault, fn: "withdrawNative", args: [input.newVault, input.oldUnallocated.toString()] });
  }
  const m2: Call[] = [{ contract: "TreasuryRouterV3", to: input.router, fn: "acceptMonthlyLeagueTreasury", args: [] }];
  return { m1, m2 };
}

const VAULT_ABI = [
  "function multisig() view returns (address)",
  "function rootPoster() view returns (address)",
  "function oracle() view returns (address)",
  "function charityTreasury() view returns (address)",
  "function monthlyCapUsd() view returns (uint256)",
  "function unallocatedBalance() view returns (uint256)",
  "function monthAuthorization(uint256) view returns (uint256 maxWinnerPool, uint64 sealAfter, uint64 sealDeadline, bool authorized, bool consumed, bool exceptional)",
];
const ROUTER_ABI = [
  "function admin() view returns (address)",
  "function monthlyLeagueTreasury() view returns (address)",
  "function pendingMonthlyLeagueTreasury() view returns (address)",
  "function pendingMonthlyLeagueTreasurySince() view returns (uint64)",
  "function upgradeDelay() view returns (uint64)",
];

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not BNB (56) or Robinhood mainnet (4663)`);
  const operator = ethers.getAddress(String(process.env.PAYOUT_OPERATOR_ADDRESS || ""));
  if (operator === ethers.getAddress(SAFE)) throw new Error("the root poster must not be the Safe");
  const months = Math.max(1, Math.min(24, Number(process.env.MONTHLY_AUTH_MONTHS || 12)));
  const maxWinnerPool = ethers.parseEther(String(process.env.MONTHLY_AUTH_MAX || chain.monthlyAuth));

  const router = new ethers.Contract(chain.router, ROUTER_ABI, ethers.provider);
  if (ethers.getAddress(await router.admin()) !== ethers.getAddress(SAFE)) throw new Error(`router ${chain.router} admin is not the Safe`);
  const old = new ethers.Contract(chain.oldMonthly, VAULT_ABI, ethers.provider);
  if (ethers.getAddress(await old.multisig()) !== ethers.getAddress(SAFE)) throw new Error(`old monthly ${chain.oldMonthly} multisig is not the Safe`);
  const oracleAddress = ethers.getAddress(await old.oracle());
  const charity = ethers.getAddress(await old.charityTreasury());
  if ((await ethers.provider.getCode(charity)) === "0x") throw new Error(`charity ${charity} has no code`);
  const price = BigInt(await new ethers.Contract(oracleAddress, ["function nativeUsdPrice() view returns (uint256)"], ethers.provider).nativeUsdPrice());
  const oldCap = BigInt(await old.monthlyCapUsd());
  console.log(`[monthly] chain ${chainId} router ${chain.router} (Safe), oracle ${oracleAddress} price $${ethers.formatEther(price)}, charity ${charity}`);
  console.log(`[monthly] OLD ${chain.oldMonthly}: cap ${oldCap} -> ${capNativeAt(oldCap, price)} wei per month (broken)`);

  const capUsd = capUsdWad();
  const planned = assertCapValue(capUsd, price);
  console.log(`[monthly] NEW cap ${capUsd} = $${planned.impliedUsd} = ${ethers.formatEther(planned.capNative)} ${chain.native} per month at today's price`);
  if (maxWinnerPool > planned.capNative * 2n) throw new Error(`MONTHLY_AUTH_MAX ${ethers.formatEther(maxWinnerPool)} is over twice the $ cap in ${chain.native}; check the unit`);

  const recordPath = path.resolve(__dirname, "..", "deployments", chain.dir, "mainnet.monthly-league-treasury-v2.json");
  let newVault = fs.existsSync(recordPath) ? ethers.getAddress(JSON.parse(fs.readFileSync(recordPath, "utf8")).address) : "";
  if (!newVault) {
    if (process.env.MWZ_DEPLOY_SEND !== "1") {
      console.log("\nDRY RUN: nothing deployed. Re-run with MWZ_DEPLOY_SEND=1 to deploy the new vault and write the Safe batches.");
      return;
    }
    const factory = await ethers.getContractFactory("MonthlyLeagueTreasury");
    const contract = await factory.deploy(SAFE, operator, oracleAddress, charity, capUsd);
    await contract.waitForDeployment();
    newVault = await contract.getAddress();
    fs.writeFileSync(recordPath, `${JSON.stringify({ chainId, address: newVault, replaces: chain.oldMonthly, multisig: SAFE, rootPoster: operator, oracle: oracleAddress, charityTreasury: charity, monthlyCapUsd: capUsd.toString(), deployTx: contract.deploymentTransaction()?.hash || null, deployedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`[monthly] deployed ${newVault}, recorded ${path.relative(process.cwd(), recordPath)}`);
  }

  // Read the new vault back from chain (retrying: BSC RPCs lag a block) and check every value.
  const fresh = new ethers.Contract(newVault, VAULT_ABI, ethers.provider);
  let readCap = 0n;
  for (let attempt = 0; attempt < 10 && readCap === 0n; attempt += 1) {
    readCap = BigInt(await fresh.monthlyCapUsd().catch(() => 0n));
    if (readCap === 0n) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["multisig", ethers.getAddress(await fresh.multisig()), ethers.getAddress(SAFE)],
    ["rootPoster", ethers.getAddress(await fresh.rootPoster()), operator],
    ["oracle", ethers.getAddress(await fresh.oracle()), oracleAddress],
    ["charityTreasury", ethers.getAddress(await fresh.charityTreasury()), charity],
    ["monthlyCapUsd", readCap, capUsd],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) throw new Error(`new vault ${name} is ${got}, expected ${want}`);
    console.log(`  ok ${name} = ${got}`);
  }
  const live = assertCapValue(readCap, price);
  console.log(`  ok cap prices to $${live.impliedUsd} (${ethers.formatEther(live.capNative)} ${chain.native})`);

  const current = ethers.getAddress(await router.monthlyLeagueTreasury());
  const pending = ethers.getAddress(await router.pendingMonthlyLeagueTreasury());
  if (current === newVault) {
    console.log(`\n[monthly] DONE: router ${chain.router} already routes the monthly league to ${newVault}.`);
    for (const call of monthAuthorizations(new Date(), 2, maxWinnerPool, newVault)) {
      const auth = await fresh.monthAuthorization(call.args[0]);
      console.log(`  month ${call.args[0]}: authorized ${auth.authorized}, max ${ethers.formatEther(auth.maxWinnerPool)} ${chain.native}, seal after ${new Date(Number(auth.sealAfter) * 1000).toISOString()}`);
    }
    return;
  }

  const oldUnallocated = BigInt(await old.unallocatedBalance());
  const { m1, m2 } = replacementBatches({ router: chain.router, oldVault: chain.oldMonthly, newVault, oldUnallocated, now: new Date(), months, maxWinnerPool });
  const delay = Number(await router.upgradeDelay());
  const dir = path.resolve(__dirname, "..", "deployments", chain.dir);
  const m1Path = path.join(dir, "mainnet.M1-monthly-league-propose.safe-batch.json");
  const m2Path = path.join(dir, "mainnet.M2-monthly-league-accept.safe-batch.json");
  fs.writeFileSync(m1Path, `${JSON.stringify(buildBatch(chainId, `M1 ${chain.native} monthly league: propose new vault`, `Router proposes MonthlyLeagueTreasury ${newVault} ($${MONTHLY_CAP_USD_WHOLE} cap in 18-decimal USD; the old ${chain.oldMonthly} capped every month at a few wei). ${months} months authorized (max ${ethers.formatEther(maxWinnerPool)} ${chain.native}). Old vault dust moved in.`, m1), null, 2)}\n`);
  fs.writeFileSync(m2Path, `${JSON.stringify(buildBatch(chainId, `M2 ${chain.native} monthly league: accept new vault`, `Router accepts MonthlyLeagueTreasury ${newVault}. Sign no earlier than ${delay} s after M1 executed.`, m2), null, 2)}\n`);
  console.log(`\n[monthly] router today: ${current}${pending !== ethers.ZeroAddress ? `, pending ${pending}` : ""}; upgradeDelay ${delay} s`);
  console.log(`  M1 ${path.relative(process.cwd(), m1Path)} (${m1.length} calls)`);
  for (const call of m1) console.log(`    ${call.fn}(${call.args.map(String).join(", ")})`);
  console.log(`  M2 ${path.relative(process.cwd(), m2Path)} -- sign after M1 + ${delay} s`);
  for (const call of m2) console.log(`    ${call.fn}()`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
