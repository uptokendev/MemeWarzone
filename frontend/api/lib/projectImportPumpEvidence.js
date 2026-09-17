import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

// Read-only layouts and seeds from pump-public-docs @ 9c82f61cb711b044a17f770ab8ce9f9bdf78f333.
// Deliberately decode the documented stable prefixes; trailing extension bytes confer no authority.
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEES_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WRAPPED_SOL = new PublicKey("So11111111111111111111111111111111111111112");
const ZERO = PublicKey.default;
const CURVE_DISC = Buffer.from([23,183,248,55,96,216,172,96]);
const SHARE_DISC = Buffer.from([216,74,9,0,56,140,93,75]);
const GLOBAL_DISC = Buffer.from([149,8,156,202,160,252,176,217]);
const POOL_DISC = Buffer.from([241,154,109,4,17,177,109,188]);
const keyAt = (b, i) => new PublicKey(b.subarray(i, i + 32));
const boolAt = (b, i) => b[i] === 0 || b[i] === 1;
const isTokenProgram = (p) => p?.equals?.(TOKEN_PROGRAM_ID) || p?.equals?.(TOKEN_2022_PROGRAM_ID);
function checkedBytes(account, program, discriminator, minLength) {
  if (!account || account.executable || !account.owner?.equals?.(program) || !(account.data instanceof Uint8Array)) return null;
  const b = Buffer.from(account.data);
  return b.length >= minLength && b.subarray(0, 8).equals(discriminator) ? b : null;
}
export function pumpCurveAddress(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0];
}
export function pumpSharingAddress(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), new PublicKey(mint).toBuffer()], PUMP_FEES_PROGRAM);
}
export function pumpPoolAddress(mint, quote = WRAPPED_SOL) {
  const key = new PublicKey(mint), quoteKey = new PublicKey(quote);
  const authority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), key.toBuffer()], PUMP_PROGRAM)[0];
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.from([0,0]), authority.toBuffer(), key.toBuffer(), quoteKey.toBuffer()], PUMP_AMM_PROGRAM);
  return { address, bump, authority, quote: quoteKey };
}
export function decodePumpCurve(account) {
  const b = checkedBytes(account, PUMP_PROGRAM, CURVE_DISC, 81);
  if (!b || !boolAt(b, 48) || (b.length>=82&&!boolAt(b,81)) || (b.length>=83&&!boolAt(b,82))) return null;
  const quote = b.length >= 115 ? keyAt(b, 83) : ZERO;
  return {
    creator: keyAt(b,49).toBase58(), complete: b[48] === 1,
    realTokenReserves: b.readBigUInt64LE(24).toString(), realQuoteReserves: b.readBigUInt64LE(32).toString(),
    quoteMint: (quote.equals(ZERO) ? WRAPPED_SOL : quote).toBase58(),
    unsupportedMode: b.length >= 82 && b[81] === 1,
  };
}
export function decodePumpSharing(account, mint, address) {
  const [canonical,bump] = pumpSharingAddress(mint);
  const b = checkedBytes(account, PUMP_FEES_PROGRAM, SHARE_DISC, 80);
  if (!b || !canonical.equals(new PublicKey(address)) || b[8] !== bump || b[9] !== 2 || ![0,1].includes(b[10]) || !boolAt(b,75) || !keyAt(b,11).equals(new PublicKey(mint))) return null;
  const count = b.readUInt32LE(76);
  if (count < 1 || count > 10 || b.length < 80 + count * 34) return null;
  const shareholders = [], seen = new Set();
  for (let i=0; i<count; i++) {
    const offset=80+i*34, wallet=keyAt(b,offset).toBase58(), shareBps=b.readUInt16LE(offset+32);
    if (!shareBps || seen.has(wallet)) return null;
    seen.add(wallet); shareholders.push({wallet,shareBps});
  }
  if (shareholders.reduce((sum,x)=>sum+x.shareBps,0)!==10000) return null;
  return { address:canonical.toBase58(), version:2, active:b[10]===1, admin:keyAt(b,43).toBase58(), adminRevoked:b[75]===1, shareholders };
}
export function pumpGlobalAddress() {
  return PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM)[0];
}
export function decodePumpGlobal(account) {
  const b=checkedBytes(account,PUMP_AMM_PROGRAM,GLOBAL_DISC,57);
  if(!b)return null;
  return {buyEnabled:(b[56]&8)===0,sellEnabled:(b[56]&16)===0,disableFlags:b[56]};
}
export function decodeCanonicalPumpPool(account, mint, quote=WRAPPED_SOL) {
  const expected = pumpPoolAddress(mint,quote);
  const b = checkedBytes(account,PUMP_AMM_PROGRAM,POOL_DISC,243);
  if (!b || (b.length>=244&&(!boolAt(b,243)||b[243]===1)) || (b.length>=245&&!boolAt(b,244)) || (b.length>245&&b.length<261) || b[8]!==expected.bump || b.readUInt16LE(9)!==0 || !keyAt(b,11).equals(expected.authority) || !keyAt(b,43).equals(new PublicKey(mint)) || !keyAt(b,75).equals(expected.quote)) return null;
  // i128 is a documented signed pricing adjustment, not funded SOL or a wallet authority.
  const virtualQuoteReserves=b.length>=261?BigInt.asIntN(128,b.readBigUInt64LE(245)|(b.readBigUInt64LE(253)<<64n)):0n;
  return { virtualQuoteReserves:virtualQuoteReserves.toString(), address:expected.address.toBase58(), baseMint:new PublicKey(mint).toBase58(), quoteMint:expected.quote.toBase58(), baseTokenAccount:keyAt(b,139).toBase58(), quoteTokenAccount:keyAt(b,171).toBase58(), lpSupply:b.readBigUInt64LE(203).toString(), coinCreator:keyAt(b,211).toBase58() };
}
export function inspectCustodyTokenAccount(account, address, mint, owner) {
  if (!account || account.executable || !isTokenProgram(account.owner)) return null;
  try {
    const parsed=unpackAccount(new PublicKey(address),account,account.owner);
    if (!parsed.isInitialized || parsed.isFrozen || !parsed.mint.equals(new PublicKey(mint)) || !parsed.owner.equals(new PublicKey(owner)) || parsed.delegate || parsed.closeAuthority) return null;
    return { tokenAccount:new PublicKey(address).toBase58(), owner:new PublicKey(owner).toBase58(), mint:new PublicKey(mint).toBase58(), amount:parsed.amount.toString(), verified:true };
  } catch { return null; }
}
async function read(connection,address) {
  // All URLs/providers are server configuration, never user-submitted endpoints.
  return connection.getAccountInfo(new PublicKey(address),"confirmed");
}
export async function readPumpImportEvidence({connection,mint,curveAccount,tokenProgram,claimant}) {
  const address=pumpCurveAddress(mint), curve=decodePumpCurve(curveAccount);
  if (!curve) return { platform:"unknown", authorityType:"unknown", market:{phase:"unknown",verified:false,reason:"launch_platform_unverified"}, custody:[] };
  const evidence={platform:"pumpfun",authorityType:"wallet",curveAddress:address.toBase58(),rawCreator:curve.creator,curveComplete:curve.complete,sharing:null,relationships:[],custody:[],market:{phase:curve.complete?"postgrad_unverified":"bonding",verified:!curve.complete,platform:"pumpfun",reason:curve.complete?"supported_pool_not_verified":"external_bonding",curveAddress:address.toBase58(),realQuoteReserves:curve.realQuoteReserves,quoteMint:curve.quoteMint}};
  const [sharingKey]=pumpSharingAddress(mint);
  if (curve.creator===sharingKey.toBase58()) {
    evidence.authorityType="fee_sharing";
    try {
      evidence.sharing=decodePumpSharing(await read(connection,sharingKey),mint,sharingKey);
      if (!evidence.sharing) evidence.authorityError="fee_sharing_record_invalid";
      else {
        const s=evidence.sharing;
        if(!s.active)evidence.authorityError="fee_sharing_inactive";
        if(s.admin===claimant)evidence.relationships.push({kind:s.adminRevoked?"historical_fee_admin":"fee_config_admin",wallet:claimant,confersProjectAuthority:false});
        const recipient=s.shareholders.find(x=>x.wallet===claimant);
        if(recipient)evidence.relationships.push({kind:"creator_fee_recipient",wallet:claimant,shareBps:recipient.shareBps,confersProjectAuthority:false});
      }
    } catch { evidence.authorityError="fee_sharing_lookup_unavailable"; }
  } else if (curve.creator===ZERO.toBase58() || !PublicKey.isOnCurve(new PublicKey(curve.creator).toBytes())) {
    evidence.authorityType="program_account";
  }
  if (!curve.complete) {
    // Only exempt the exact mint-specific custody account after its owner, token program and mint validate.
    if(isTokenProgram(tokenProgram)) {
      const ata=getAssociatedTokenAddressSync(new PublicKey(mint),address,true,tokenProgram);
      try { const custody=inspectCustodyTokenAccount(await read(connection,ata),ata,mint,address);if(custody)evidence.custody.push(custody); }
      catch { evidence.custodyCheck="unavailable"; }
    }
    return evidence;
  }
  if(curve.unsupportedMode || curve.quoteMint!==WRAPPED_SOL.toBase58()) {
    evidence.market={...evidence.market,reason:"market_mode_requires_technical_review"};return evidence;
  }
  const expected=pumpPoolAddress(mint);
  try {
    const pool=decodeCanonicalPumpPool(await read(connection,expected.address),mint);
    if (!pool) return evidence;
    if(pool.coinCreator!==curve.creator) evidence.authorityError="curve_pool_creator_conflict";
    const [base,quote,globalAccount]=await Promise.all([read(connection,pool.baseTokenAccount),read(connection,pool.quoteTokenAccount),read(connection,pumpGlobalAddress())]);
    const global=decodePumpGlobal(globalAccount);
    if(!global){evidence.market.reason="pool_controls_unverified";return evidence;}
    // The canonical pool owns canonical ATAs, not merely any accounts mentioning these mints.
    if(!isTokenProgram(base?.owner)||!isTokenProgram(quote?.owner)||
       !getAssociatedTokenAddressSync(new PublicKey(mint),expected.address,true,base.owner).equals(new PublicKey(pool.baseTokenAccount))||
       !getAssociatedTokenAddressSync(WRAPPED_SOL,expected.address,true,quote.owner).equals(new PublicKey(pool.quoteTokenAccount))) {
      evidence.market.reason="pool_custody_unverified";return evidence;
    }
    const baseCustody=inspectCustodyTokenAccount(base,pool.baseTokenAccount,mint,pool.address);
    const quoteCustody=inspectCustodyTokenAccount(quote,pool.quoteTokenAccount,WRAPPED_SOL,pool.address);
    if (!baseCustody || !quoteCustody) { evidence.market.reason="pool_custody_unverified";return evidence; }
    evidence.custody.push(baseCustody);
    const effectiveQuote=BigInt(quoteCustody.amount)+BigInt(pool.virtualQuoteReserves);
    evidence.market={...evidence.market,phase:"postgrad",poolAddress:pool.address,poolProgram:PUMP_AMM_PROGRAM.toBase58(),verified:true,liquidityAvailable:BigInt(baseCustody.amount)>0n&&BigInt(quoteCustody.amount)>0n,controlsVerified:true,buyEnabled:global.buyEnabled,sellEnabled:global.sellEnabled,pricingValid:effectiveQuote>0n,virtualQuoteReserves:pool.virtualQuoteReserves,effectiveQuoteReserves:effectiveQuote.toString(),virtualReservesAreLiquidity:false,venue:"PumpSwap",baseReserve:baseCustody.amount,quoteReserve:quoteCustody.amount,reason:"canonical_pumpswap_pool_verified",executionTested:false};
  } catch { evidence.market={...evidence.market,verified:false,reason:"market_rpc_unavailable"}; }
  return evidence;
}
