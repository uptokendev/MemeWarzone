import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { sameAddress } from "./bnb6cRouteAuthority";

const CHAIN_ID = 97;
const BUY_EXACT_TOKENS = 0;
const SELL_EXACT_TOKENS = 2;
const signerUrl = pathToFileURL(path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href;
const signerPromise = Function("specifier", "return import(specifier)")(signerUrl);

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function fund(deployer: any, wallet: ethers.Wallet, target: bigint) {
  const balance = await ethers.provider.getBalance(wallet.address);
  if (balance < target) await (await deployer.sendTransaction({ to: wallet.address, value: target - balance })).wait();
}

async function createAuth(mod: any, factory: any, creator: ethers.Wallet, routeAuthority: ethers.Wallet, request: any) {
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await mod.signCreateAuthorization({
    signer: routeAuthority,
    chainId: CHAIN_ID,
    factoryAddress: await factory.getAddress(),
    creator: creator.address,
    request,
    tradeRouteProfileId: tradeRouteProfile,
    finalizeRouteProfileId: finalizeRouteProfile,
    deadline,
  });
  return { tradeRouteProfile, finalizeRouteProfile, deadline, signature };
}

async function tradeAuth(mod: any, campaign: any, actor: ethers.Wallet, routeAuthority: ethers.Wallet, action: number, amount: bigint, limit: bigint) {
  const routeProfileId = Number(await campaign.tradeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await mod.signTradeAuthorization({
    signer: routeAuthority,
    chainId: CHAIN_ID,
    campaignAddress: await campaign.getAddress(),
    actor: actor.address,
    routeProfileId,
    action,
    amount,
    limit,
    deadline,
  });
  return { routeProfileId, deadline, signature };
}

async function executeSide(
  label: string,
  factory: any,
  mod: any,
  routeAuthority: ethers.Wallet,
  creator: ethers.Wallet,
  buyer: ethers.Wallet,
  trader: ethers.Wallet,
) {
  const now = Date.now();
  const request = {
    name: `Agent2 ${label} ${now}`,
    symbol: `A2${label}${String(now).slice(-4)}`.slice(0, 10),
    logoURI: "ipfs://agent2-normal-battle-cert",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const auth = await createAuth(mod, factory, creator, routeAuthority, request);
  const index = await factory.campaignsCount();
  const createTx = await factory.connect(creator).createCampaignAuthorized(request, auth);
  const createReceipt = await createTx.wait();
  const info = await factory.getCampaign(index);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);

  // Tiny token probes keep tBNB use minimal while still producing real chain-derived
  // holder, price/MCAP and eligible BUY/SELL evidence. Gas is the dominant cost.
  const unit = 10n ** 15n; // 0.001 token at 18 decimals
  const supply = await token.totalSupply();
  const quoteBefore = await campaign.quoteBuyExactTokens(unit);
  const holdersBefore = {
    buyer: (await token.balanceOf(buyer.address)).toString(),
    trader: (await token.balanceOf(trader.address)).toString(),
  };

  const buy1Amount = unit * 2n;
  const buy1Cost = await campaign.quoteBuyExactTokens(buy1Amount);
  const buy1Auth = await tradeAuth(mod, campaign, buyer, routeAuthority, BUY_EXACT_TOKENS, buy1Amount, buy1Cost);
  const buy1Tx = await campaign.connect(buyer).buyExactTokensAuthorized(buy1Amount, buy1Cost, buy1Auth.routeProfileId, buy1Auth.deadline, buy1Auth.signature, { value: buy1Cost });
  const buy1Receipt = await buy1Tx.wait();

  const buy2Amount = unit;
  const buy2Cost = await campaign.quoteBuyExactTokens(buy2Amount);
  const buy2Auth = await tradeAuth(mod, campaign, trader, routeAuthority, BUY_EXACT_TOKENS, buy2Amount, buy2Cost);
  const buy2Tx = await campaign.connect(trader).buyExactTokensAuthorized(buy2Amount, buy2Cost, buy2Auth.routeProfileId, buy2Auth.deadline, buy2Auth.signature, { value: buy2Cost });
  const buy2Receipt = await buy2Tx.wait();

  const sellAmount = unit / 2n;
  const sellPayout = await campaign.quoteSellExactTokens(sellAmount);
  const approveTx = await token.connect(buyer).approve(info.campaign, sellAmount);
  await approveTx.wait();
  const sellAuth = await tradeAuth(mod, campaign, buyer, routeAuthority, SELL_EXACT_TOKENS, sellAmount, sellPayout);
  const sellTx = await campaign.connect(buyer).sellExactTokensAuthorized(sellAmount, sellPayout, sellAuth.routeProfileId, sellAuth.deadline, sellAuth.signature);
  const sellReceipt = await sellTx.wait();

  const quoteAfter = await campaign.quoteBuyExactTokens(unit);
  const buyerBalance = await token.balanceOf(buyer.address);
  const traderBalance = await token.balanceOf(trader.address);
  const holdersAfter = { buyer: buyerBalance.toString(), trader: traderBalance.toString() };
  if (buyerBalance <= 0n || traderBalance <= 0n) throw new Error(`${label}: holder growth not proven`);
  if (quoteAfter <= quoteBefore) throw new Error(`${label}: chain-derived marginal market value did not increase`);

  const marginalMcapNativeWei = (quoteAfter * supply) / unit;
  return {
    label,
    chainId: CHAIN_ID,
    campaign: info.campaign,
    token: info.token,
    creator: creator.address,
    buyer: buyer.address,
    trader: trader.address,
    totalSupply: supply.toString(),
    quoteProbeTokenRaw: unit.toString(),
    quoteProbeBeforeWei: quoteBefore.toString(),
    quoteProbeAfterWei: quoteAfter.toString(),
    marginalMcapNativeWei: marginalMcapNativeWei.toString(),
    holdersBefore,
    holdersAfter,
    holderCountDeltaKnown: 2,
    transactions: {
      create: { hash: createTx.hash, blockNumber: createReceipt?.blockNumber },
      buyBuyer: { hash: buy1Tx.hash, blockNumber: buy1Receipt?.blockNumber, nativeWei: buy1Cost.toString(), tokens: buy1Amount.toString() },
      buyTrader: { hash: buy2Tx.hash, blockNumber: buy2Receipt?.blockNumber, nativeWei: buy2Cost.toString(), tokens: buy2Amount.toString() },
      sellBuyer: { hash: sellTx.hash, blockNumber: sellReceipt?.blockNumber, nativeWei: sellPayout.toString(), tokens: sellAmount.toString() },
      approve: approveTx.hash,
    },
  };
}

async function main() {
  if (network.name !== "bscTestnet") throw new Error(`refusing network ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`expected BSC97, got ${net.chainId}`);
  const manifestPath = path.resolve(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "certification/agent2-bsc97-stage-20260914.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (Number(manifest.chainId) !== CHAIN_ID) throw new Error("staged manifest is not chain 97");
  const routeKey = String(process.env.BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (!routeKey) throw new Error("BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY required");
  const routeAuthority = new ethers.Wallet(routeKey, ethers.provider);
  if (!sameAddress(routeAuthority.address, manifest.routeAuthority)) throw new Error("route authority mismatch");

  const deployerKey = String(process.env.BSC_TESTNET_PRIVATE_KEY || "").trim();
  if (!deployerKey) throw new Error("BSC_TESTNET_PRIVATE_KEY required");
  const creator = new ethers.Wallet(deployerKey, ethers.provider);
  if (!sameAddress(creator.address, manifest.admin)) throw new Error("deployer/admin mismatch");

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, creator);
  if (!(await factory.live())) await (await factory.enableLive()).wait();
  if (await factory.createPaused()) await (await factory.setCreatePaused(false)).wait();

  const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
  const trader = ethers.Wallet.createRandom().connect(ethers.provider);
  await fund(creator, buyer, ethers.parseEther("0.002"));
  await fund(creator, trader, ethers.parseEther("0.002"));

  const mod = await signerPromise;
  const left = await executeSide("L", factory, mod, routeAuthority, creator, buyer, trader);
  const right = await executeSide("R", factory, mod, routeAuthority, creator, buyer, trader);
  if (left.token.toLowerCase() === right.token.toLowerCase()) throw new Error("cross-side token collision");

  const report = {
    schemaVersion: 1,
    purpose: "agent2-normal-battle-destructive-market-evidence",
    sourceSha: process.env.GITHUB_SHA || null,
    chainId: CHAIN_ID,
    network: "bsc-testnet",
    factory: await factory.getAddress(),
    manifestEvidence: manifest.evidenceSource || null,
    left,
    right,
    checks: {
      freshCampaigns: true,
      chainDerivedMcapGrowth: true,
      holderGrowth: true,
      eligibleRealVolumeTransactions: 6,
      crossTokenIsolation: true,
      claimsTouched: false,
      graduationTouched: false,
    },
  };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/agent2-bsc97-normal-battle-market.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
