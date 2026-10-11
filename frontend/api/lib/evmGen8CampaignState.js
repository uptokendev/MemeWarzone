/**
 * Coin-page state of an EVM generation 8 coin (Uniswap V4 pool with the MemeWarzone hook), read from chain for
 * GET /api/evm/campaign-state. Design 6.4: the hook (pools(id), creatorOwed, pendingCreator, displayPair), the pool
 * price from the PoolManager (StateLibrary slot0 through extsload, so no StateView address is needed), progress = coins
 * sold from position A / A's coins (exact), price and fully diluted market cap from sqrtPriceX96, the fee rate now (the
 * launch window 90% -> 2% over 60 s, 2% bonding, 1% after graduation), the creator ledger (claimable in the hook or,
 * for holders / split / buyback coins, in the creator-choice vault), the creator reserve and the creator buy escrow.
 *
 * A gen-8 coin is recognised by its pool: id = keccak256(abi.encode(native, token, dynamic fee, 10, hook)) and
 * hook.pools(id).creator != 0. Quotes are not served here: the trade panel quotes through Uniswap's V4Quoter with
 * the pool key returned below (design 6.2); trading is never signed by the API (D3).
 */
import { ethers } from "ethers";
import {
  GEN8_FEE_CHOICE_NAMES,
  GEN8_RATES,
  GEN8_TOTAL_SUPPLY,
  GEN8_TRADE_PATH,
  WAD,
  gen8FeeRate,
  gen8MarketCapWei,
  gen8PoolId,
  gen8PoolKey,
  gen8Progress,
  nativePerCoinWei,
} from "../../shared/evmGen8.mjs";

const ZERO = ethers.ZeroAddress;
const POOLS_SLOT = 6n; // v4-core StateLibrary.POOLS_SLOT

export const GEN8_HOOK_STATE_ABI = [
  "function pools(bytes32) view returns (address creator, uint40 launchTime, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees)",
  "function creatorOwed(bytes32) view returns (uint256)",
  "function pendingCreator(bytes32) view returns (address)",
  "function displayPair(bytes32) view returns (address)",
];
const POOL_MANAGER_ABI = ["function extsload(bytes32 slot) view returns (bytes32)"];
const LENS_ABI = [
  "function progress(bytes32 id) view returns (tuple(bool graduated, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
];
const CHOICE_VAULT_ABI = [
  "function cfg(bytes32) view returns (address creator, uint8 choice, uint8 creatorPct, address token)",
  "function creatorBalance(bytes32) view returns (uint256)",
  "function holderBalance(bytes32) view returns (uint256)",
  "function buybackBalance(bytes32) view returns (uint256)",
  "function pendingCreator(bytes32) view returns (address)",
];
const RESERVE_LOCK_ABI = [
  "function reserves(bytes32) view returns (address token, uint96 amount)",
  "function beneficiaryOf(bytes32 id) view returns (address to)",
];
const ESCROW_ABI = [
  "function claimable(address token, address beneficiary) view returns (uint256)",
  "function claimed(address token, address beneficiary) view returns (uint256)",
  "function escrowedTotal(address token, address beneficiary) view returns (uint256)",
];

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

const addr = (v) => (v && v !== ZERO ? ethers.getAddress(v) : null);

/** StateLibrary._getPoolStateSlot(id): keccak256(abi.encodePacked(id, POOLS_SLOT)). */
export function poolStateSlot(poolId) {
  return ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(POOLS_SLOT), 32)]));
}

/** slot0 word -> sqrtPriceX96 (low 160 bits) and tick (next 24 bits, signed). */
export function decodeSlot0(word) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick };
}

/**
 * The hook's record of a token's pool, or null when the token is not a gen-8 coin of this hook. Cheap enough to run
 * before the gen-5/6/7 reader (one eth_call).
 */
export async function readGen8Pool({ provider, cfg, token }) {
  const poolId = gen8PoolId(token, cfg.hook);
  const hook = new ethers.Contract(cfg.hook, GEN8_HOOK_STATE_ABI, provider);
  const p = await hook.pools(poolId);
  const creator = p.creator ?? p[0];
  if (!creator || creator === ZERO) return null;
  const fees = p.fees ?? p[8];
  return {
    poolId,
    hook,
    creator: ethers.getAddress(creator),
    launchTime: Number(p.launchTime ?? p[1]),
    graduated: Boolean(p.graduated ?? p[2]),
    tickGrad: Number(p.tickGrad ?? p[3]),
    tickStart: Number(p.tickStart ?? p[4]),
    liqA: BigInt(p.liqA ?? p[5]),
    liqB: BigInt(p.liqB ?? p[6]),
    sqrtGrad: BigInt(p.sqrtGrad ?? p[7]),
    fees: {
      bondingBps: Number(fees.bondingBps ?? fees[0]),
      postBps: Number(fees.postBps ?? fees[1]),
      creatorPostBps: Number(fees.creatorPostBps ?? fees[2]),
      sniperStartBps: Number(fees.sniperStartBps ?? fees[3]),
      creatorBondingBps: Number(fees.creatorBondingBps ?? fees[4]),
    },
  };
}

async function readSqrtPrice({ provider, cfg, poolId }) {
  const pm = new ethers.Contract(cfg.poolManager, POOL_MANAGER_ABI, provider);
  const word = await pm.extsload(poolStateSlot(poolId));
  return decodeSlot0(word);
}

/**
 * Full state. `pool` may be passed from readGen8Pool to save the call. Returns the same top-level shape as the gen-5
 * reader where the fields mean the same thing (supported, generation, creator, token, tradeFee, economics,
 * graduation, creatorClaims, viewer), plus `gen8` with the pool key, phase and trade path.
 */
export async function readGen8CampaignState({ provider, cfg, token, wallet = null, pool = null }) {
  const tokenAddress = ethers.getAddress(token);
  const p = pool || (await readGen8Pool({ provider, cfg, token: tokenAddress }));
  if (!p) return null;
  const block = await provider.getBlock("latest");
  const now = Number(block.timestamp);
  const lens = cfg.lens ? new ethers.Contract(cfg.lens, LENS_ABI, provider) : null;

  const [owedR, pendingR, displayR, slotR, lensR] = await Promise.all([
    settle(p.hook.creatorOwed(p.poolId)),
    settle(p.hook.pendingCreator(p.poolId)),
    settle(p.hook.displayPair(p.poolId)),
    settle(readSqrtPrice({ provider, cfg, poolId: p.poolId })),
    lens ? settle(lens.progress(p.poolId)) : Promise.resolve({ ok: false }),
  ]);
  const sqrtPriceX96 = slotR.ok ? slotR.value.sqrtPriceX96 : lensR.ok ? BigInt(lensR.value.sqrtPriceX96 ?? lensR.value[1]) : null;
  const progress = sqrtPriceX96 != null
    ? gen8Progress({ liqA: p.liqA, tickStart: p.tickStart, tickGrad: p.tickGrad, sqrtPriceX96, graduated: p.graduated })
    : null;
  const priceWei = sqrtPriceX96 ? nativePerCoinWei(sqrtPriceX96) : null;
  const marketCapWei = sqrtPriceX96 ? gen8MarketCapWei(sqrtPriceX96) : null;
  const currentBps = gen8FeeRate({ graduated: p.graduated, launchTime: p.launchTime, nowTs: now, fees: p.fees });
  const antiSniperEndsAt = p.launchTime + GEN8_RATES.sniperWindowSeconds;

  // Fee choice: keep coins name the human creator in the hook; holders / split / buyback coins name the
  // creator-choice vault, which records the human creator (D2).
  const isChoiceCoin = Boolean(cfg.choiceVault && p.creator.toLowerCase() === cfg.choiceVault.toLowerCase());
  let feeChoice = { id: 1, name: "keep", creatorPct: null, vault: null };
  let choiceVault = null;
  let humanCreator = p.creator;
  if (isChoiceCoin) {
    const vault = new ethers.Contract(cfg.choiceVault, CHOICE_VAULT_ABI, provider);
    const [cfgR, credR, holdR, buyR, pendR] = await Promise.all([
      settle(vault.cfg(p.poolId)), settle(vault.creatorBalance(p.poolId)), settle(vault.holderBalance(p.poolId)),
      settle(vault.buybackBalance(p.poolId)), settle(vault.pendingCreator(p.poolId)),
    ]);
    if (cfgR.ok) {
      const c = cfgR.value;
      humanCreator = addr(c.creator ?? c[0]) || humanCreator;
      const id = Number(c.choice ?? c[1]);
      feeChoice = { id, name: GEN8_FEE_CHOICE_NAMES[id] || "unknown", creatorPct: Number(c.creatorPct ?? c[2]) || null, vault: cfg.choiceVault };
    } else {
      feeChoice = { id: null, name: "unknown", creatorPct: null, vault: cfg.choiceVault };
    }
    choiceVault = {
      address: cfg.choiceVault,
      // pull(id) moves the hook ledger into the vault first (permissionless); these are the vault's own balances.
      creatorClaimableWei: credR.ok ? credR.value.toString() : null,
      holderPendingWei: holdR.ok ? holdR.value.toString() : null,
      buybackPendingWei: buyR.ok ? buyR.value.toString() : null,
      pendingCreator: pendR.ok ? addr(pendR.value) : null,
      error: cfgR.ok ? null : "The creator-choice vault could not be read.",
    };
  }

  let reserve = null;
  if (cfg.reserveLock) {
    const lock = new ethers.Contract(cfg.reserveLock, RESERVE_LOCK_ABI, provider);
    const [resR, benR] = await Promise.all([settle(lock.reserves(p.poolId)), settle(lock.beneficiaryOf(p.poolId))]);
    if (resR.ok) {
      reserve = {
        address: cfg.reserveLock,
        amount: BigInt(resR.value.amount ?? resR.value[1]).toString(),
        releasable: Boolean(p.graduated && BigInt(resR.value.amount ?? resR.value[1]) > 0n),
        beneficiary: benR.ok ? addr(benR.value) : null,
      };
    }
  }

  const viewer = wallet && ethers.isAddress(wallet) ? ethers.getAddress(wallet) : null;
  let escrow = null;
  if (viewer && cfg.escrow) {
    const e = new ethers.Contract(cfg.escrow, ESCROW_ABI, provider);
    const [cR, dR, tR] = await Promise.all([settle(e.claimable(tokenAddress, viewer)), settle(e.claimed(tokenAddress, viewer)), settle(e.escrowedTotal(tokenAddress, viewer))]);
    escrow = {
      address: cfg.escrow,
      totalTokens: tR.ok ? tR.value.toString() : null,
      claimedTokens: dR.ok ? dR.value.toString() : null,
      claimableTokens: cR.ok ? cR.value.toString() : null,
    };
  }

  const creatorOwedWei = owedR.ok ? owedR.value.toString() : null;
  const hookPendingCreator = pendingR.ok ? addr(pendingR.value) : null;
  const display = displayR.ok ? addr(displayR.value) : null;
  const key = gen8PoolKey(tokenAddress, cfg.hook);

  return {
    campaignAddress: tokenAddress,
    supported: true,
    generation: { factoryGeneration: 8, campaignGeneration: 8, factoryAddress: cfg.launcher, kind: "gen8" },
    blockNumber: Number(block.number),
    blockTimestamp: now,
    creator: humanCreator,
    token: tokenAddress,
    tradeFee: {
      currentBps,
      baseBps: p.graduated ? p.fees.postBps : p.fees.bondingBps,
      bondingBps: p.fees.bondingBps,
      postGraduationBps: p.fees.postBps,
      antiSniperStartBps: p.fees.sniperStartBps,
      antiSniperWindowSeconds: GEN8_RATES.sniperWindowSeconds,
      launchAt: p.launchTime,
      antiSniperEndsAt,
      antiSniperActive: !p.graduated && now < antiSniperEndsAt,
      appliesTo: "every swap in the coin's pool, from any wallet or router; the creator's first buy at launch pays the bonding rate",
    },
    quotes: {},
    economics: {
      generationKind: "gen8",
      bondingFeeBps: p.fees.bondingBps,
      postGraduationFeeBps: p.fees.postBps,
      creatorPostGraduationBps: p.fees.creatorPostBps,
      creatorBondingShareBpsOfFee: p.fees.creatorBondingBps,
      antiSniperStartBps: p.fees.sniperStartBps,
      graduationFeeBps: GEN8_RATES.graduationFeeBps,
      totalSupply: GEN8_TOTAL_SUPPLY.toString(),
      marketCapBasis: "fully_diluted",
    },
    graduation: {
      state: p.graduated ? "graduated" : "trading",
      phase: p.graduated ? "graduated" : "bonding",
      // Graduation happens inside the swap that crosses the top of A: no pending state, no keeper.
      pendingSince: null,
      sold: progress ? progress.soldRaw.toString() : null,
      curveSupply: progress ? progress.capacityRaw.toString() : null,
      progressBps: progress ? progress.bps : null,
      progressPct: progress ? progress.pct : null,
      lensNativeInAWei: lensR.ok ? BigInt(lensR.value.nativeInA ?? lensR.value[4]).toString() : null,
      lensNativeTargetAWei: lensR.ok ? BigInt(lensR.value.nativeTargetA ?? lensR.value[5]).toString() : null,
      graduate: { callable: false, repairNeeded: false, reason: p.graduated ? "graduated" : "in_swap" },
    },
    market: {
      sqrtPriceX96: sqrtPriceX96 != null ? sqrtPriceX96.toString() : null,
      tick: slotR.ok ? slotR.value.tick : null,
      priceNativeWeiPerCoin: priceWei != null ? priceWei.toString() : null,
      priceNative: priceWei != null ? Number(priceWei) / Number(WAD) : null,
      marketCapNativeWei: marketCapWei != null ? marketCapWei.toString() : null,
    },
    creatorClaims: {
      // hook.claimCreator(id, to): the hook creator only (the human creator on keep coins, the vault otherwise).
      hookCreator: p.creator,
      hookCreatorOwedWei: creatorOwedWei,
      hookPendingCreator,
      feeChoice,
      vault: choiceVault,
      reserve,
      escrow,
    },
    gen8: {
      poolId: p.poolId,
      poolKey: key,
      hook: cfg.hook,
      poolManager: cfg.poolManager,
      lens: cfg.lens,
      launcher: cfg.launcher,
      displayPair: display,
      tradePath: GEN8_TRADE_PATH,
      phase: p.graduated ? "graduated" : "bonding",
      tickStart: p.tickStart,
      tickGrad: p.tickGrad,
      liqA: p.liqA.toString(),
      liqB: p.liqB.toString(),
      tradeAuthorization: "none",
    },
    viewer: viewer
      ? {
          wallet: viewer,
          isCreator: viewer === humanCreator,
          canClaimHookCreatorFees: Boolean(viewer === p.creator && creatorOwedWei && BigInt(creatorOwedWei) > 0n),
          canClaimVaultFees: Boolean(isChoiceCoin && viewer === humanCreator && choiceVault?.creatorClaimableWei && BigInt(choiceVault.creatorClaimableWei) > 0n),
          canAcceptCreator: Boolean((hookPendingCreator && viewer === hookPendingCreator) || (choiceVault?.pendingCreator && viewer === choiceVault.pendingCreator)),
          canClaimEscrow: Boolean(escrow?.claimableTokens && BigInt(escrow.claimableTokens) > 0n),
        }
      : null,
  };
}
