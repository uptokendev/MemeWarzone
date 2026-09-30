/**
 * Chain reads and writes for EVM generation-6 factories and generation-5 campaigns.
 *
 * Reads go straight to the contracts (the ABIs the API builder generated from the
 * contracts). Nothing here is used for an older factory or campaign: callers
 * check `isGen6Factory` / `readGen5Campaign` first, and both answer "no" for
 * every older generation, so today's create and trade paths are untouched (E14).
 */
import { Contract, ethers, type AbstractProvider, type Signer } from "ethers";
import LaunchFactoryGen6 from "@/abi/LaunchFactoryGen6.json";
import LaunchCampaignGen5 from "@/abi/LaunchCampaignGen5.json";
import CreatorRewardsVaultV2 from "@/abi/CreatorRewardsVaultV2.json";
import {
  EVM_ESCROW_FULLY_FREE_SECONDS,
  decodeEvmFeeChoice,
  escrowSummary,
  findFirstTime,
  findNextStepTime,
  isEvmGen6Pair,
} from "@/lib/evmGen6.mjs";

const FACTORY_ABI = (LaunchFactoryGen6 as any).abi as ethers.InterfaceAbi;
const CAMPAIGN_ABI = (LaunchCampaignGen5 as any).abi as ethers.InterfaceAbi;
const VAULT_ABI = (CreatorRewardsVaultV2 as any).abi as ethers.InterfaceAbi;

const GENERATION_ABI = [
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
] as const;
const ORACLE_ABI = ["function nativeTargetForUsd(uint256 usd) view returns (uint256)"] as const;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
] as const;

const CAMPAIGN_REQUEST_TUPLE =
  "(string name,string symbol,string logoURI,string xAccount,string website,string extraLink,uint256 graduationTarget,uint256 firstBuyTokens,uint256 firstBuyMaxCost,uint8 feeChoice,uint8 feeCreatorPct)";
const ROUTE_AUTH_TUPLE = "(uint8 tradeRouteProfile,uint8 finalizeRouteProfile,uint64 deadline,bytes signature)";

/** BnbBasicLaunchFactory (generation 6): the quote create with the 11-field request. */
export const GEN6_BNB_BASIC_QUOTE_CREATE_ABI = [
  `function createBasicQuoteCampaignAuthorized(${CAMPAIGN_REQUEST_TUPLE} req,address quoteToken,bytes32 quoteCatalogBindingHash,${ROUTE_AUTH_TUPLE} routeAuth) payable returns (address campaignAddr,address tokenAddr)`,
] as const;

/** The creator-facing errors a generation-6 create can add, in plain words. */
export const GEN6_CREATE_ERROR_MESSAGES: Record<string, string> = {
  FirstBuySlippage: "The first-buy price changed before the launch. Check the amount and try again.",
  FirstBuyValueWithoutAmount: "Value was sent without a first buy. Try again.",
  InsufficientValue: "The wallet sent less than the first-buy cost.",
  RefundFailed: "The refund of the unused first-buy value failed.",
  FirstBuyTooLarge: "The first buy is above 10% of the supply.",
  FirstBuyTooExpensive: "The first buy costs more than half of the graduation target at today's price. Lower it.",
  InvalidFeeChoice: "The creator fee choice is not valid. Pick one again.",
  OraclePriceUnavailable: "The price feed is not answering. Try again in a minute.",
  TargetOutOfRangeAtPrice: "This graduation target is out of range at today's price. Pick another tier.",
};

export type Gen6FactoryContext = {
  factoryGeneration: number;
  campaignGeneration: number;
  config: { totalSupply: bigint; curveBps: bigint; liquidityTokenBps: bigint; basePrice: bigint; priceSlope: bigint };
  protocolFeeBps: bigint;
  nativeTargetWei: bigint;
};

export async function readFactoryGenerations(
  provider: AbstractProvider,
  factoryAddress: string,
): Promise<{ factoryGeneration: number; campaignGeneration: number } | null> {
  if (!ethers.isAddress(factoryAddress)) return null;
  try {
    const factory = new Contract(factoryAddress, GENERATION_ABI, provider) as any;
    const [f, c] = await Promise.all([factory.FACTORY_GENERATION(), factory.CAMPAIGN_GENERATION()]);
    return { factoryGeneration: Number(f), campaignGeneration: Number(c) };
  } catch {
    return null;
  }
}

export async function isGen6Factory(provider: AbstractProvider, factoryAddress: string): Promise<boolean> {
  const g = await readFactoryGenerations(provider, factoryAddress);
  return Boolean(g && isEvmGen6Pair(g.factoryGeneration, g.campaignGeneration));
}

/** What the create page needs to price a first buy: the curve config, the fee, the live native target. */
export async function readGen6CreateContext(
  provider: AbstractProvider,
  factoryAddress: string,
  graduationTarget: bigint,
): Promise<Gen6FactoryContext> {
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider) as any;
  const [f, c, config, protocolFeeBps, oracleAddress] = await Promise.all([
    factory.FACTORY_GENERATION(),
    factory.CAMPAIGN_GENERATION(),
    factory.config(),
    factory.protocolFeeBps(),
    factory.graduationOracle(),
  ]);
  if (!isEvmGen6Pair(f, c)) throw new Error(`Factory is generation ${Number(f)}/${Number(c)}, not 6/5.`);
  const oracle = new Contract(String(oracleAddress), ORACLE_ABI, provider) as any;
  const nativeTargetWei = BigInt(await oracle.nativeTargetForUsd(graduationTarget));
  return {
    factoryGeneration: Number(f),
    campaignGeneration: Number(c),
    config: {
      totalSupply: BigInt(config.totalSupply ?? config[0]),
      curveBps: BigInt(config.curveBps ?? config[1]),
      liquidityTokenBps: BigInt(config.liquidityTokenBps ?? config[2]),
      basePrice: BigInt(config.basePrice ?? config[3]),
      priceSlope: BigInt(config.priceSlope ?? config[4]),
    },
    protocolFeeBps: BigInt(protocolFeeBps),
    nativeTargetWei,
  };
}

export type Gen6CreateFields = {
  firstBuyTokens: bigint;
  firstBuyMaxCost: bigint;
  feeChoice: number;
  feeCreatorPct: number;
  value: bigint;
};

/** The 11-field CampaignRequest a generation-6 factory takes. */
export function gen6CampaignRequest(
  base: {
    name: string;
    symbol: string;
    logoURI: string;
    xAccount: string;
    website: string;
    extraLink: string;
    graduationTarget: string | bigint;
  },
  fields: Gen6CreateFields,
) {
  return {
    ...base,
    graduationTarget: BigInt(base.graduationTarget),
    firstBuyTokens: fields.firstBuyTokens,
    firstBuyMaxCost: fields.firstBuyMaxCost,
    feeChoice: fields.feeChoice,
    feeCreatorPct: fields.feeCreatorPct,
  };
}

/** JSON-safe copy for the create-authorization request (the API signs these four fields too). */
export function gen6CampaignRequestPayload(request: ReturnType<typeof gen6CampaignRequest>) {
  return {
    ...request,
    graduationTarget: request.graduationTarget.toString(),
    firstBuyTokens: request.firstBuyTokens.toString(),
    firstBuyMaxCost: request.firstBuyMaxCost.toString(),
  };
}

export function gen6FactoryWriter(factoryAddress: string, signer: Signer) {
  return new Contract(factoryAddress, FACTORY_ABI, signer) as any;
}

export function gen6CreateErrorMessage(error: any): string | null {
  const iface = new ethers.Interface(FACTORY_ABI);
  const candidates = [error?.data, error?.revert?.data, error?.info?.error?.data, error?.error?.data];
  const direct = String(error?.revert?.name || error?.errorName || "");
  if (direct && GEN6_CREATE_ERROR_MESSAGES[direct]) return GEN6_CREATE_ERROR_MESSAGES[direct];
  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x")) continue;
    try {
      const name = iface.parseError(data)?.name || "";
      if (GEN6_CREATE_ERROR_MESSAGES[name]) return GEN6_CREATE_ERROR_MESSAGES[name];
    } catch {
      // not a factory error
    }
  }
  return null;
}

// ---------------------------------------------------------------- campaign reads

export type Gen5CampaignState = {
  campaign: string;
  factory: string;
  token: string;
  creator: string;
  launchAt: number;
  protocolFeeBps: number;
  currentTradeFeeBps: number;
  launched: boolean;
  graduationPending: boolean;
  pendingSince: number;
  nativeFallback: boolean;
  quoteToken: string;
  quoteSymbol: string | null;
  pool: string;
  feeVault: string;
  feeChoice: string | null;
  feeCreatorPct: number | null;
};

const ZERO = ethers.ZeroAddress;

/** Null for any campaign that is not generation 5 on a generation-6 factory. */
export async function readGen5Campaign(provider: AbstractProvider, campaignAddress: string): Promise<Gen5CampaignState | null> {
  if (!ethers.isAddress(campaignAddress)) return null;
  const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, provider) as any;
  let factoryAddress = "";
  try {
    factoryAddress = String(await campaign.factory());
  } catch {
    return null;
  }
  if (!(await isGen6Factory(provider, factoryAddress))) return null;
  const factory = new Contract(factoryAddress, FACTORY_ABI, provider) as any;
  const [token, creator, launchAt, protocolFeeBps, currentTradeFeeBps, launched, graduationPending, pendingSince, nativeFallback, quoteToken, feeChoice] =
    await Promise.all([
      campaign.token(),
      campaign.creator(),
      campaign.launchAt(),
      campaign.protocolFeeBps(),
      campaign.currentTradeFeeBps(),
      campaign.launched(),
      campaign.graduationPending(),
      campaign.pendingSince(),
      campaign.nativeFallback().catch(() => false),
      campaign.graduationQuoteToken().catch(() => ZERO),
      factory.campaignFeeChoice(campaignAddress).catch(() => null),
    ]);
  let pool = "";
  if (launched) {
    try {
      const state = await campaign.getGraduationState();
      pool = String(state?.dexPair ?? state?.[0] ?? "");
    } catch {
      pool = "";
    }
  }
  const quote = String(quoteToken || ZERO);
  let quoteSymbol: string | null = null;
  if (quote !== ZERO) {
    try {
      quoteSymbol = String(await (new Contract(quote, ERC20_ABI, provider) as any).symbol());
    } catch {
      quoteSymbol = null;
    }
  }
  const decoded = feeChoice ? decodeEvmFeeChoice(Number(feeChoice.choice ?? feeChoice[1]), Number(feeChoice.creatorPct ?? feeChoice[2])) : { choice: null, creatorSharePct: null };
  return {
    campaign: campaignAddress,
    factory: factoryAddress,
    token: String(token),
    creator: String(creator),
    launchAt: Number(launchAt),
    protocolFeeBps: Number(protocolFeeBps),
    currentTradeFeeBps: Number(currentTradeFeeBps),
    launched: Boolean(launched),
    graduationPending: Boolean(graduationPending),
    pendingSince: Number(pendingSince),
    nativeFallback: Boolean(nativeFallback),
    quoteToken: quote,
    quoteSymbol,
    pool: pool && pool !== ZERO ? pool : "",
    feeVault: feeChoice ? String(feeChoice.vault ?? feeChoice[0] ?? "") : "",
    feeChoice: decoded.choice,
    feeCreatorPct: decoded.creatorSharePct,
  };
}

export type Gen5CreatorState = {
  walletBalance: bigint;
  totalSupply: bigint;
  escrowTotal: bigint;
  escrowClaimed: bigint;
  escrowHeld: bigint;
  escrowLocked: bigint;
  escrowClaimable: bigint;
  nextReleaseAt: number;
  fullyFreeAt: number;
  graduationBeneficiary: string;
  pendingGraduation: bigint;
  pendingGraduationQuote: bigint;
  vaultCreatorBalance: bigint;
  vaultCreatorQuoteBalance: bigint;
};

/** The creator's balances on a generation-5 coin: escrow, graduation pull payment, vault. */
export async function readGen5CreatorState(
  provider: AbstractProvider,
  state: Gen5CampaignState,
  nowUnix = Math.floor(Date.now() / 1000),
): Promise<Gen5CreatorState> {
  const campaign = new Contract(state.campaign, CAMPAIGN_ABI, provider) as any;
  const token = new Contract(state.token, ERC20_ABI, provider) as any;
  const vault = state.feeVault && state.feeVault !== ZERO ? (new Contract(state.feeVault, VAULT_ABI, provider) as any) : null;
  const [walletBalance, totalSupply, escrowTotal, escrowClaimed, vestedNow, beneficiary, pendingGraduation, pendingGraduationQuote, vaultCreator, vaultQuote] =
    await Promise.all([
      token.balanceOf(state.creator),
      token.totalSupply(),
      campaign.creatorEscrowTotal(),
      campaign.creatorEscrowClaimed(),
      campaign.creatorEscrowVested(nowUnix),
      campaign.creatorGraduationBeneficiary().catch(() => ZERO),
      campaign.pendingCreatorGraduation().catch(() => 0n),
      campaign.pendingCreatorQuote().catch(() => 0n),
      vault ? vault.creatorBalance(state.campaign).catch(() => 0n) : 0n,
      vault ? vault.creatorQuoteBalance(state.campaign).catch(() => 0n) : 0n,
    ]);
  const total = BigInt(escrowTotal);
  const vested = BigInt(vestedNow);
  const summary = escrowSummary({ total, claimed: escrowClaimed, vestedNow: vested });
  let nextReleaseAt = 0;
  let fullyFreeAt = 0;
  if (summary.locked > 0n) {
    // The escrow views are step functions of time; each probe is one eth_call.
    const probe = async (t: number) => BigInt(await campaign.creatorEscrowVested(t));
    const horizon = nowUnix + EVM_ESCROW_FULLY_FREE_SECONDS + 1;
    [nextReleaseAt, fullyFreeAt] = await Promise.all([
      findNextStepTime(probe, nowUnix, horizon),
      findFirstTime(async (t: number) => (await probe(t)) >= total, nowUnix, horizon),
    ]);
  }
  return {
    walletBalance: BigInt(walletBalance),
    totalSupply: BigInt(totalSupply),
    escrowTotal: total,
    escrowClaimed: BigInt(escrowClaimed),
    escrowHeld: summary.held,
    escrowLocked: summary.locked,
    escrowClaimable: summary.claimable,
    nextReleaseAt,
    fullyFreeAt,
    graduationBeneficiary: String(beneficiary || ZERO),
    pendingGraduation: BigInt(pendingGraduation),
    pendingGraduationQuote: BigInt(pendingGraduationQuote),
    vaultCreatorBalance: BigInt(vaultCreator),
    vaultCreatorQuoteBalance: BigInt(vaultQuote),
  };
}

// ---------------------------------------------------------------- creator writes

async function send(txPromise: Promise<any>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return { hash: String(receipt?.hash || tx?.hash || "") };
}

export async function claimCreatorEscrow(signer: Signer, campaignAddress: string) {
  const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, signer) as any;
  await campaign.claimCreatorEscrow.staticCall();
  return send(campaign.claimCreatorEscrow());
}

export async function claimCreatorGraduation(signer: Signer, campaignAddress: string, to: string, includeQuote: boolean) {
  const campaign = new Contract(campaignAddress, CAMPAIGN_ABI, signer) as any;
  await campaign.claimCreatorGraduation.staticCall(to, includeQuote);
  return send(campaign.claimCreatorGraduation(to, includeQuote));
}

export async function claimVaultCreatorFees(signer: Signer, vaultAddress: string, campaignAddress: string) {
  const vault = new Contract(vaultAddress, VAULT_ABI, signer) as any;
  await vault.claimCreatorFees.staticCall(campaignAddress);
  return send(vault.claimCreatorFees(campaignAddress));
}

export async function claimVaultCreatorQuote(signer: Signer, vaultAddress: string, campaignAddress: string) {
  const vault = new Contract(vaultAddress, VAULT_ABI, signer) as any;
  await vault.claimCreatorQuote.staticCall(campaignAddress);
  return send(vault.claimCreatorQuote(campaignAddress));
}
