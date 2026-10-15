/**
 * Coin-page state of an EVM generation 8 coin (Uniswap V4 pool with the MemeWarzone hook), read from chain for
 * GET /api/evm/campaign-state. Design 6.4: the hook (pools(id), creatorOwed, pendingCreator, displayPair), the pool
 * price from the PoolManager (StateLibrary slot0 through extsload, so no StateView address is needed), progress = coins
 * sold from position A / A's coins (exact), price and fully diluted market cap from sqrtPriceX96, the fee rate now (the
 * launch window 90% -> 2% over 60 s, 2% bonding, 1% after graduation), the creator ledger (claimable in the hook or,
 * for holders / split / buyback coins, in the creator-choice vault), the creator reserve and the creator buy escrow.
 *
 * Fix round 2026-10-12 (build/evm-gen8 20d95e0a): hook pools() names openAt (was launchTime) and gains graduatedAt as a
 * tenth field; the lens progress() tuple gains postPhase and graduatedAt (second and third), and tradingOpen() is new.
 * Every read below is by name. The phase is the PRICE's (F1: post when sqrtPriceX96 <= sqrtAtTick(tickGrad)); the
 * platform status is graduated only when the latch is set AND the phase is post; the creator reserve releases from
 * graduatedAt + 1 h while latched and post. When the price cannot be read, evm_gen8_pools.last_phase / open_at stand in.
 *
 * A gen-8 coin is recognised by its pool: id = keccak256(abi.encode(native, token, dynamic fee, 10, hook)) and
 * hook.pools(id).creator != 0. Quotes are not served here: the trade panel quotes through Uniswap's V4Quoter with
 * the pool key returned below (design 6.2); trading is never signed by the API (D3).
 */
import { ethers } from "ethers";
import {
  GEN8_FEE_CHOICE_NAMES,
  GEN8_RATES,
  GEN8_RESERVE_RELEASE_DELAY_SECONDS,
  GEN8_TOTAL_SUPPLY,
  GEN8_TRADE_PATH,
  WAD,
  gen8FeeRate,
  gen8MarketCapWei,
  gen8PlatformStatus,
  gen8PoolId,
  gen8PoolKey,
  gen8PostPhase,
  gen8Progress,
  nativePerCoinWei,
} from "../../shared/evmGen8.mjs";

const ZERO = ethers.ZeroAddress;
const POOLS_SLOT = 6n; // v4-core StateLibrary.POOLS_SLOT

export const GEN8_HOOK_STATE_ABI = [
  "function pools(bytes32) view returns (address creator, uint40 openAt, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees, uint40 graduatedAt)",
  "function creatorOwed(bytes32) view returns (uint256)",
  "function pendingCreator(bytes32) view returns (address)",
  "function displayPair(bytes32) view returns (address)",
];
const POOL_MANAGER_ABI = ["function extsload(bytes32 slot) view returns (bytes32)"];
export const GEN8_LENS_ABI = [
  "function progress(bytes32 id) view returns (tuple(bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
  "function tradingOpen(bytes32 id) view returns (bool open, uint256 openAt)",
];
const LENS_ABI = GEN8_LENS_ABI;
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

// Canonical Multicall3. One aggregate3 replaces the six view calls below. pools() and getBlock stay outside:
// pools() is the recognition read, and the block time is not a contract view. Choice vault, reserve and escrow
// stay their own calls (they run only for some coins). allowFailure keeps one reverted view from blanking the rest.
export const GEN8_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];
const HOOK_VIEW_ABI = [
  "function creatorOwed(bytes32) view returns (uint256)",
  "function pendingCreator(bytes32) view returns (address)",
  "function displayPair(bytes32) view returns (address)",
];
const multicallIface = new ethers.Interface(MULTICALL3_ABI);
const hookViewIface = new ethers.Interface(HOOK_VIEW_ABI);
const pmViewIface = new ethers.Interface(POOL_MANAGER_ABI);
const lensViewIface = new ethers.Interface(LENS_ABI);
const multicallCode = new Map();

function unwrapCall(decoded) {
  if (decoded && typeof decoded.length === "number" && decoded.length === 1) {
    const inner = decoded[0];
    if (inner !== null && typeof inner === "object") return inner;
    return inner;
  }
  return decoded;
}

function decodeRow(iface, name, row) {
  if (!row?.success || !row.returnData || row.returnData === "0x") return { ok: false };
  try {
    return { ok: true, value: unwrapCall(iface.decodeFunctionResult(name, row.returnData)) };
  } catch {
    return { ok: false };
  }
}

async function hasMulticall3(provider, chainId) {
  const id = Number(chainId);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (multicallCode.has(id)) return multicallCode.get(id);
  try {
    const code = await provider.getCode(GEN8_MULTICALL3);
    const ok = typeof code === "string" && code !== "0x" && code.length > 2;
    multicallCode.set(id, ok);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The six view reads, as one Multicall3 aggregate3 when that contract has code on the chain. No code, or a throw
 * from the batch itself, runs the same six reads in parallel. A failed inner call is `{ ok: false }` on its own;
 * the others still settle. `slotR.value` is `{ sqrtPriceX96, tick }`, matching readSqrtPrice.
 */
export async function readGen8ViewBatch({ provider, cfg, pool, lens = null }) {
  const parallel = () => Promise.all([
    settle(pool.hook.creatorOwed(pool.poolId)),
    settle(pool.hook.pendingCreator(pool.poolId)),
    settle(pool.hook.displayPair(pool.poolId)),
    settle(readSqrtPrice({ provider, cfg, poolId: pool.poolId })),
    lens ? settle(lens.progress(pool.poolId)) : Promise.resolve({ ok: false }),
    lens ? settle(lens.tradingOpen(pool.poolId)) : Promise.resolve({ ok: false }),
  ]);
  if (!(await hasMulticall3(provider, cfg?.chainId))) return parallel();
  const calls = [
    { target: cfg.hook, allowFailure: true, callData: hookViewIface.encodeFunctionData("creatorOwed", [pool.poolId]) },
    { target: cfg.hook, allowFailure: true, callData: hookViewIface.encodeFunctionData("pendingCreator", [pool.poolId]) },
    { target: cfg.hook, allowFailure: true, callData: hookViewIface.encodeFunctionData("displayPair", [pool.poolId]) },
    { target: cfg.poolManager, allowFailure: true, callData: pmViewIface.encodeFunctionData("extsload", [poolStateSlot(pool.poolId)]) },
  ];
  if (lens && cfg.lens) {
    calls.push({ target: cfg.lens, allowFailure: true, callData: lensViewIface.encodeFunctionData("progress", [pool.poolId]) });
    calls.push({ target: cfg.lens, allowFailure: true, callData: lensViewIface.encodeFunctionData("tradingOpen", [pool.poolId]) });
  }
  try {
    const raw = await provider.call({ to: GEN8_MULTICALL3, data: multicallIface.encodeFunctionData("aggregate3", [calls]) });
    const [rows] = multicallIface.decodeFunctionResult("aggregate3", raw);
    const owedR = decodeRow(hookViewIface, "creatorOwed", rows[0]);
    const pendingR = decodeRow(hookViewIface, "pendingCreator", rows[1]);
    const displayR = decodeRow(hookViewIface, "displayPair", rows[2]);
    const word = decodeRow(pmViewIface, "extsload", rows[3]);
    const slotR = word.ok ? { ok: true, value: decodeSlot0(word.value) } : { ok: false };
    const lensR = lens && cfg.lens ? decodeRow(lensViewIface, "progress", rows[4]) : { ok: false };
    const openR = lens && cfg.lens ? decodeRow(lensViewIface, "tradingOpen", rows[5]) : { ok: false };
    return [owedR, pendingR, displayR, slotR, lensR, openR];
  } catch {
    return parallel();
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
  const fees = p.fees;
  const openAt = Number(p.openAt);
  const graduatedAt = Number(p.graduatedAt);
  return {
    poolId,
    hook,
    creator: ethers.getAddress(creator),
    // B: when trading opens (the launch block time when not scheduled). launchTime is the older name, kept for callers.
    openAt,
    launchTime: openAt,
    // The one-time latch (Graduated event) and its block time (0 before; the reserve releases from it + 1 h).
    graduated: Boolean(p.graduated),
    graduatedAt: graduatedAt > 0 ? graduatedAt : null,
    tickGrad: Number(p.tickGrad),
    tickStart: Number(p.tickStart),
    liqA: BigInt(p.liqA),
    liqB: BigInt(p.liqB),
    sqrtGrad: BigInt(p.sqrtGrad),
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
/**
 * The phase, open and reserve fields of a gen-8 coin (all unix seconds), from its hook record `p`, the pool price (or
 * the lens's postPhase, or the indexer's last_phase), and the block time. Exported for the indexer-only fallback.
 *   openAt            number   when trading opens
 *   tradingOpen       boolean  now >= openAt (the lens tradingOpen() when it was read)
 *   latched           boolean  the one-time graduation latch (hook pools().graduated)
 *   postPhase         boolean|null  the price is at or past the graduation price now (null: price unknown)
 *   graduatedAt       number|null   the latch time
 *   platformStatus    'graduated' | 'bonding'  graduated only when latched AND postPhase
 *   reserveReleaseAt  number|null   graduatedAt + 3600 (MwzReserveLock.RESERVE_RELEASE_DELAY)
 *   reserveReleasable boolean  latched AND postPhase AND now >= reserveReleaseAt (release() also needs its own tx)
 */
export function gen8PhaseFields({ openAt, latched, graduatedAt, postPhase, now, lensTradingOpen = null }) {
  const open = Number(openAt) || 0;
  const gradAt = graduatedAt ? Number(graduatedAt) : null;
  const post = postPhase === true ? true : postPhase === false ? false : null;
  const reserveReleaseAt = latched && gradAt ? gradAt + GEN8_RESERVE_RELEASE_DELAY_SECONDS : null;
  return {
    openAt: open,
    tradingOpen: typeof lensTradingOpen === "boolean" ? lensTradingOpen : Number(now) >= open,
    latched: Boolean(latched),
    postPhase: post,
    graduatedAt: latched ? gradAt : null,
    platformStatus: gen8PlatformStatus({ latched: Boolean(latched), postPhase: post }),
    reserveReleaseAt,
    reserveReleasable: Boolean(latched && post === true && reserveReleaseAt !== null && Number(now) >= reserveReleaseAt),
  };
}

/**
 * `indexed` (optional): the indexer's view of the pool ({ openAt, lastPhase, graduatedBlock, graduatedAt }, unix
 * seconds; readGen8IndexedPool), used only for what the chain read could not answer (the phase when neither the
 * PoolManager nor the lens answered).
 */
export async function readGen8CampaignState({ provider, cfg, token, wallet = null, pool = null, indexed = null }) {
  const tokenAddress = ethers.getAddress(token);
  const p = pool || (await readGen8Pool({ provider, cfg, token: tokenAddress }));
  if (!p) return null;
  const block = await provider.getBlock("latest");
  const now = Number(block.timestamp);
  const lens = cfg.lens ? new ethers.Contract(cfg.lens, LENS_ABI, provider) : null;

  const [owedR, pendingR, displayR, slotR, lensR, openR] = await readGen8ViewBatch({ provider, cfg, pool: p, lens });
  const sqrtPriceX96 = slotR.ok ? slotR.value.sqrtPriceX96 : lensR.ok ? BigInt(lensR.value.sqrtPriceX96) : null;
  // F1: the phase from the price (the lens rule); else the lens's own postPhase; else the indexer's last_phase.
  let postPhase = gen8PostPhase(sqrtPriceX96, p.tickGrad);
  let phaseSource = postPhase !== null ? "price" : null;
  if (postPhase === null && lensR.ok) {
    postPhase = Boolean(lensR.value.postPhase);
    phaseSource = "lens";
  }
  if (postPhase === null && (indexed?.lastPhase === "post" || indexed?.lastPhase === "bonding")) {
    postPhase = indexed.lastPhase === "post";
    phaseSource = "indexer";
  }
  const phase = gen8PhaseFields({
    openAt: p.openAt,
    latched: p.graduated,
    graduatedAt: p.graduatedAt,
    postPhase,
    now,
    lensTradingOpen: openR.ok ? Boolean(openR.value.open) : null,
  });
  const platformGraduated = phase.platformStatus === "graduated";
  const progress = sqrtPriceX96 != null
    ? gen8Progress({ liqA: p.liqA, tickStart: p.tickStart, tickGrad: p.tickGrad, sqrtPriceX96 })
    : null;
  const priceWei = sqrtPriceX96 ? nativePerCoinWei(sqrtPriceX96) : null;
  const marketCapWei = sqrtPriceX96 ? gen8MarketCapWei(sqrtPriceX96) : null;
  // The rate the next swap pays: by the price phase (F1), the decay from openAt (B). Unknown phase: the latch.
  const feePost = postPhase ?? p.graduated;
  const currentBps = gen8FeeRate({ postPhase: feePost, openAt: p.openAt, nowTs: now, fees: p.fees });
  const antiSniperEndsAt = p.openAt + GEN8_RATES.sniperWindowSeconds;

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
        // MwzReserveLock.release: latched, price at or past graduation, an hour after the latch (and its own tx).
        releasable: Boolean(phase.reserveReleasable && BigInt(resR.value.amount ?? resR.value[1]) > 0n),
        releaseAt: phase.reserveReleaseAt,
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
    // Fix round 2026-10-12 (see gen8PhaseFields): openAt, tradingOpen, latched, postPhase, graduatedAt,
    // platformStatus, reserveReleaseAt, reserveReleasable; phaseSource says where postPhase came from.
    ...phase,
    phaseSource,
    tradeFee: {
      currentBps,
      baseBps: feePost ? p.fees.postBps : p.fees.bondingBps,
      bondingBps: p.fees.bondingBps,
      postGraduationBps: p.fees.postBps,
      antiSniperStartBps: p.fees.sniperStartBps,
      antiSniperWindowSeconds: GEN8_RATES.sniperWindowSeconds,
      launchAt: p.openAt,
      openAt: p.openAt,
      antiSniperEndsAt,
      antiSniperActive: !feePost && now >= p.openAt && now < antiSniperEndsAt,
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
      // The platform status (latched AND post phase); a forced latch whose price fell back into A shows as trading.
      state: platformGraduated ? "graduated" : "trading",
      phase: platformGraduated ? "graduated" : "bonding",
      latched: p.graduated,
      // Graduation happens inside the swap that crosses the top of A: no pending state, no keeper.
      pendingSince: null,
      sold: progress ? progress.soldRaw.toString() : null,
      curveSupply: progress ? progress.capacityRaw.toString() : null,
      progressBps: progress ? progress.bps : null,
      progressPct: progress ? progress.pct : null,
      lensNativeInAWei: lensR.ok ? BigInt(lensR.value.nativeInA).toString() : null,
      lensNativeTargetAWei: lensR.ok ? BigInt(lensR.value.nativeTargetA).toString() : null,
      graduate: { callable: false, repairNeeded: false, reason: platformGraduated ? "graduated" : "in_swap" },
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
      phase: platformGraduated ? "graduated" : "bonding",
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

/**
 * The indexer's record of a gen-8 coin (evm_gen8_pools joined with campaigns), for when the chain cannot be read:
 * { poolId, token, creator, openAt, lastPhase, graduatedBlock, graduatedAt, tickStart, tickGrad, liqA, sqrtPriceX96 }
 * with times in unix seconds, or null (no row, no table, or the 20261012_000012 columns not applied). Never throws.
 */
export async function readGen8IndexedPool(db, chainId, token) {
  if (!db || typeof db.query !== "function" || !ethers.isAddress(String(token || ""))) return null;
  try {
    const { rows } = await db.query(
      `select g.pool_id, g.token_address, g.creator_address, g.open_at, g.last_phase, g.graduated_block, g.tick_start, g.tick_grad,
              g.liq_a::text as liq_a, g.last_sqrt_price_x96::text as last_sqrt_price_x96, c.graduated_at_chain
         from public.evm_gen8_pools g
         left join public.campaigns c on c.chain_id = g.chain_id and c.campaign_address = g.token_address
        where g.chain_id = $1 and g.token_address = $2
        limit 1`,
      [Number(chainId), String(token).toLowerCase()],
    );
    const r = rows?.[0];
    if (!r) return null;
    const secs = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);
    return {
      poolId: String(r.pool_id),
      token: ethers.getAddress(r.token_address),
      creator: r.creator_address ? ethers.getAddress(r.creator_address) : null,
      openAt: secs(r.open_at),
      lastPhase: r.last_phase === "post" || r.last_phase === "bonding" ? r.last_phase : null,
      graduatedBlock: r.graduated_block != null ? Number(r.graduated_block) : null,
      graduatedAt: r.graduated_block != null ? secs(r.graduated_at_chain) : null,
      tickStart: Number(r.tick_start),
      tickGrad: Number(r.tick_grad),
      liqA: r.liq_a != null ? String(r.liq_a) : null,
      sqrtPriceX96: r.last_sqrt_price_x96 != null ? String(r.last_sqrt_price_x96) : null,
    };
  } catch (error) {
    console.warn("[gen8] indexed pool read failed", error?.message || error);
    return null;
  }
}

/**
 * Coin-page state from the indexer alone (the RPC failed): the phase, open and reserve fields of gen8PhaseFields from
 * evm_gen8_pools.open_at / last_phase / graduated_block and campaigns.graduated_at_chain, plus progress from the last
 * indexed price. `source: "indexer"`, `stale: true`; nothing that needs the chain (claims, fee ledgers) is present.
 */
export function gen8IndexedCampaignState({ cfg, indexed, nowSec = Math.floor(Date.now() / 1000) }) {
  const latched = indexed.graduatedBlock !== null;
  const postPhase = indexed.lastPhase === "post" ? true : indexed.lastPhase === "bonding" ? false : null;
  const phase = gen8PhaseFields({ openAt: indexed.openAt ?? 0, latched, graduatedAt: indexed.graduatedAt, postPhase, now: nowSec });
  const platformGraduated = phase.platformStatus === "graduated";
  let progress = null;
  try {
    if (indexed.liqA != null && indexed.sqrtPriceX96 != null) progress = gen8Progress({ liqA: indexed.liqA, tickStart: indexed.tickStart, tickGrad: indexed.tickGrad, sqrtPriceX96: indexed.sqrtPriceX96 });
  } catch {
    progress = null;
  }
  return {
    campaignAddress: indexed.token,
    supported: true,
    source: "indexer",
    stale: true,
    generation: { factoryGeneration: 8, campaignGeneration: 8, factoryAddress: cfg.launcher, kind: "gen8" },
    blockTimestamp: nowSec,
    creator: indexed.creator,
    token: indexed.token,
    ...phase,
    phaseSource: postPhase === null ? null : "indexer",
    graduation: {
      state: platformGraduated ? "graduated" : "trading",
      phase: platformGraduated ? "graduated" : "bonding",
      latched,
      progressBps: progress ? progress.bps : null,
      progressPct: progress ? progress.pct : null,
    },
    gen8: {
      poolId: indexed.poolId,
      poolKey: gen8PoolKey(indexed.token, cfg.hook),
      hook: cfg.hook,
      poolManager: cfg.poolManager,
      lens: cfg.lens,
      launcher: cfg.launcher,
      tradePath: GEN8_TRADE_PATH,
      phase: platformGraduated ? "graduated" : "bonding",
      tickStart: indexed.tickStart,
      tickGrad: indexed.tickGrad,
      tradeAuthorization: "none",
    },
  };
}
