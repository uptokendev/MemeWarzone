/**
 * EVM generation 8 on Barkswap (DogeOS) for the API: the contract fragments the API reads, the MwzV4Token creation code
 * and the coin CREATE2 that MwzBarkLauncher.launch runs, and the create signer's salt search (barkswap plan t21; spec
 * section 3 launcher row, section 4 API; docs/dogeos/barkswap-audit.md, MwzBarkLauncher open question 2).
 *
 * Coin address (MwzBarkLaunchLib.deployCoin, DELEGATECALLed by the launcher, so the CREATE2 deployer is the launcher):
 *   create2(launcher, keccak256(abi.encode(creator, req.salt)),
 *           keccak256(MwzV4Token.creationCode ++ abi.encode(name, symbol, 1e27, launcher)))
 * launch() reverts CoinNotBelowWNative unless that address sorts below the launcher's wNative (WDOGE), so the API
 * signs only a salt whose coin sorts below it (about 96% of salts do for WDOGE 0xF6BD...).
 *
 * MWZ_V4_TOKEN_CREATION_CODE is MwzV4Token.bytecode of the Bark build (gen-8 compiler settings: 0.8.26, cancun, viaIR,
 * 200 runs, bytecodeHash none; identical to the gen-8 build), the code MwzBarkLaunchLib embeds. The API ships from
 * frontend/ without the artifacts, so it is kept here; evmGen8BarkCreate.test.mjs compares it with artifacts-bark and
 * with MwzBarkLaunchLib's deployed bytecode whenever they are built. A coin contract change is a new generation.
 *
 * The fragments are human-readable copies of contracts/dogeos/barkswap/abi/*.abi.json (the test answers every read
 * from those ABIs, so a wrong fragment fails there). All Bark periphery is keyed by the coin address.
 */
import crypto from "node:crypto";
import { AbiCoder, concat, getAddress, getCreate2Address, keccak256 } from "ethers";

const coder = AbiCoder.defaultAbiCoder();

/** MwzBarkLauncher.SUPPLY (1B coins, 18 decimals): the coin constructor's supply argument. */
export const BARK_COIN_SUPPLY = 1_000_000_000n * 10n ** 18n;

export const BARK_LAUNCHER_ABI = [
  "function createPaused() view returns (bool)",
  "function createSigner() view returns (address)",
  "function plugin() view returns (address)",
  "function wNative() view returns (address)",
  "function isGraduationTargetAllowed(uint256 target) view returns (bool)",
  "function plan(uint256 targetUsd) view returns (tuple(uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB))",
  "function launches(address coin) view returns (address pool, uint40 openAt, int24 tickStart, int24 tickGrad, bool gradFeeTaken, address feeCreator, uint40 lastConvertAt, uint128 liqA, uint128 liqB, uint256 graduationFee)",
  "function creatorOwed(address coin) view returns (uint256)",
  "function pendingCreator(address coin) view returns (address)",
];
export const BARK_PLUGIN_ABI = [
  "function pools(address pool) view returns (uint160 sqrtGrad, uint40 openAt, bool graduated, uint40 graduatedAt, bool gradBurnDone, address coin, int24 tickStart, int24 tickGrad, uint160 sqrtStart)",
];
export const BARK_LENS_ABI = [
  "function progress(address coin) view returns (tuple(bool graduated, bool postPhase, uint40 graduatedAt, uint160 sqrtPriceX96, uint256 coinsSoldFromA, uint256 coinsInA, uint256 nativeInA, uint256 nativeTargetA))",
  "function tradingOpen(address coin) view returns (bool open, uint256 openAt)",
  "function currentFeeBps(address coin, address sender) view returns (uint256)",
  "function owed(address coin) view returns (tuple(address feeCreator, address pendingCreator, uint256 creatorOwed, uint256[4] coinBooks, uint256[4] uncollectedNative, uint256[4] uncollectedCoin, uint40 lastConvertAt, uint256 nextConvertAt, bool gradFeeTaken, uint256 graduationFee))",
  "function poolState(address coin) view returns (tuple(address pool, uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked, bool launchSettings))",
];
export const BARK_CHOICE_VAULT_ABI = [
  "function cfg(address coin) view returns (address creator, uint8 choice, uint8 creatorPct, address token)",
  "function creatorBalance(address coin) view returns (uint256)",
  "function holderBalance(address coin) view returns (uint256)",
  "function buybackBalance(address coin) view returns (uint256)",
  "function pendingCreator(address coin) view returns (address)",
];
export const BARK_RESERVE_LOCK_ABI = [
  "function reserves(address coin) view returns (address token, uint96 amount)",
  "function beneficiaryOf(address coin) view returns (address to)",
];
/** Algebra Integral 1.2.1 IAlgebraPoolState.globalState (contracts/dogeos/barkswap/interfaces/core/pool). */
export const ALGEBRA_POOL_STATE_ABI = [
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
];

export const MWZ_V4_TOKEN_CREATION_CODE =
  "0x6080604052346103b157610a0a80380380610019816103b5565b9283398101906080818303126103b15780516001600160401b0381116103b157826100459183016103da565b602082015190926001600160401b0382116103b1576100659183016103da565b604082015160609092015190916001600160a01b038216918290036103b15783516001600160401b0381116102c257600354600181811c911680156103a7575b60208210146102a457601f8111610344575b50602094601f82116001146102e1579481929394955f926102d6575b50508160011b915f199060031b1c1916176003555b82516001600160401b0381116102c257600454600181811c911680156102b8575b60208210146102a457601f8111610241575b506020601f82116001146101de57819293945f926101d3575b50508160011b915f199060031b1c1916176004555b81156101c057600254908082018092116101ac5760207fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef915f9360025584845283825260408420818154019055604051908152a36040516105de908161042c8239f35b634e487b7160e01b5f52601160045260245ffd5b63ec442f0560e01b5f525f60045260245ffd5b015190505f80610134565b601f1982169060045f52805f20915f5b81811061022957509583600195969710610211575b505050811b01600455610149565b01515f1960f88460031b161c191690555f8080610203565b9192602060018192868b0151815501940192016101ee565b60045f527f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b601f830160051c8101916020841061029a575b601f0160051c01905b81811061028f575061011b565b5f8155600101610282565b9091508190610279565b634e487b7160e01b5f52602260045260245ffd5b90607f1690610109565b634e487b7160e01b5f52604160045260245ffd5b015190505f806100d3565b601f1982169560035f52805f20915f5b88811061032c57508360019596979810610314575b505050811b016003556100e8565b01515f1960f88460031b161c191690555f8080610306565b919260206001819286850151815501940192016102f1565b60035f527fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b601f830160051c8101916020841061039d575b601f0160051c01905b81811061039257506100b7565b5f8155600101610385565b909150819061037c565b90607f16906100a5565b5f80fd5b6040519190601f01601f191682016001600160401b038111838210176102c257604052565b81601f820112156103b1578051906001600160401b0382116102c257610409601f8301601f19166020016103b5565b92828452602083830101116103b157815f9260208093018386015e830101529056fe6080806040526004361015610012575f80fd5b5f3560e01c90816306fdde03146103ef57508063095ea7b31461036d57806318160ddd1461035057806323b872dd14610271578063313ce5671461025657806370a082311461021f57806395d89b4114610104578063a9059cbb146100d35763dd62ed3e1461007f575f80fd5b346100cf5760403660031901126100cf576100986104e8565b6100a06104fe565b6001600160a01b039182165f908152600160209081526040808320949093168252928352819020549051908152f35b5f80fd5b346100cf5760403660031901126100cf576100f96100ef6104e8565b6024359033610514565b602060405160018152f35b346100cf575f3660031901126100cf576040515f6004548060011c90600181168015610215575b602083108114610201578285529081156101e55750600114610190575b50819003601f01601f191681019067ffffffffffffffff82118183101761017c57610178829182604052826104be565b0390f35b634e487b7160e01b5f52604160045260245ffd5b905060045f527f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b5f905b8282106101cf57506020915082010182610148565b60018160209254838588010152019101906101ba565b90506020925060ff191682840152151560051b82010182610148565b634e487b7160e01b5f52602260045260245ffd5b91607f169161012b565b346100cf5760203660031901126100cf576001600160a01b036102406104e8565b165f525f602052602060405f2054604051908152f35b346100cf575f3660031901126100cf57602060405160128152f35b346100cf5760603660031901126100cf5761028a6104e8565b6102926104fe565b6001600160a01b0382165f818152600160209081526040808320338452909152902054909260443592915f1981106102d0575b506100f99350610514565b83811061033557841561032257331561030f576100f9945f52600160205260405f2060018060a01b0333165f526020528360405f2091039055846102c5565b634a1406b160e11b5f525f60045260245ffd5b63e602df0560e01b5f525f60045260245ffd5b8390637dc7a0d960e11b5f523360045260245260445260645ffd5b346100cf575f3660031901126100cf576020600254604051908152f35b346100cf5760403660031901126100cf576103866104e8565b602435903315610322576001600160a01b031690811561030f57335f52600160205260405f20825f526020528060405f20556040519081527f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b92560203392a3602060405160018152f35b346100cf575f3660031901126100cf575f6003548060011c906001811680156104b4575b602083108114610201578285529081156101e5575060011461045f5750819003601f01601f191681019067ffffffffffffffff82118183101761017c57610178829182604052826104be565b905060035f527fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b5f905b82821061049e57506020915082010182610148565b6001816020925483858801015201910190610489565b91607f1691610413565b602060409281835280519182918282860152018484015e5f828201840152601f01601f1916010190565b600435906001600160a01b03821682036100cf57565b602435906001600160a01b03821682036100cf57565b6001600160a01b03169081156105be576001600160a01b03169182156105ab57815f525f60205260405f205481811061059257817fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92602092855f525f84520360405f2055845f525f825260405f20818154019055604051908152a3565b8263391434e360e21b5f5260045260245260445260645ffd5b63ec442f0560e01b5f525f60045260245ffd5b634b637e8f60e11b5f525f60045260245ffdfea164736f6c634300081a000a";

/** keccak256 of the coin's init code (creation code ++ abi.encode(name, symbol, SUPPLY, launcher)). */
export function barkCoinInitCodeHash({ name, symbol, launcher }) {
  const args = coder.encode(["string", "string", "uint256", "address"], [String(name), String(symbol), BARK_COIN_SUPPLY, getAddress(launcher)]);
  return keccak256(concat([MWZ_V4_TOKEN_CREATION_CODE, args]));
}

/** The CREATE2 salt deployCoin uses: keccak256(abi.encode(creator, salt)). */
export function barkCoinSalt(creator, salt) {
  return keccak256(coder.encode(["address", "uint256"], [getAddress(creator), BigInt(salt)]));
}

/** The address MwzBarkLauncher.launch deploys the coin at for this creator, request salt, name and symbol. */
export function predictBarkCoinAddress({ launcher, creator, salt, name, symbol, initCodeHash = null }) {
  return getCreate2Address(getAddress(launcher), barkCoinSalt(creator, salt), initCodeHash || barkCoinInitCodeHash({ name, symbol, launcher }));
}

const randomUint256 = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

/**
 * The create signer's salt (spec section 3: "salt from the create signer so the coin sorts below WDOGE"): fresh random
 * 256-bit salts until the predicted coin address is below `wNative` as a uint160 (the launcher's own check). Returns
 * { salt, coin, tries }. Throws (code GEN8_SALT_NOT_FOUND) after `maxTries`; for WDOGE that is about 0.04^256, never.
 * `randomSalt` is injectable for tests.
 */
export function findBarkCoinSalt({ launcher, creator, name, symbol, wNative, randomSalt = randomUint256, maxTries = 256 }) {
  const initCodeHash = barkCoinInitCodeHash({ name, symbol, launcher });
  const limit = BigInt(getAddress(wNative));
  for (let tries = 1; tries <= maxTries; tries += 1) {
    const salt = BigInt(randomSalt());
    const coin = predictBarkCoinAddress({ launcher, creator, salt, initCodeHash });
    if (BigInt(coin) < limit) return { salt, coin, tries };
  }
  const error = new Error(`No CREATE2 salt found in ${maxTries} tries whose coin sorts below ${getAddress(wNative)}.`);
  error.code = "GEN8_SALT_NOT_FOUND";
  throw error;
}
