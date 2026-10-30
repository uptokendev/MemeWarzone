// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MwzDisplayPair (EVM generation 8, BNB Chain only)
/// @notice Display-only Uniswap V2 look-alike pair per coin, so V2-based indexers (DexScreener does not index
/// Uniswap V4 on BSC) can see trades in our V4 pool. Modelled on flap.sh's FlapCurvePairFactory pairs as read on
/// chain: name "Uniswap V2", symbol "UNI-V2", decimals 18, totalSupply = sqrt(r0 * r1), token0/token1 sorted,
/// getReserves; V2 events Sync then Mint at launch and Sync then Swap per trade. Added for D10: factory().
/// Immutable, no proxy. Only the hook can write to it. It holds no funds, moves no funds and has no swap(),
/// mint() or burn(); nothing in our system reads it for money.
contract MwzDisplayPair {
    error NotHook();

    // Exact Uniswap V2 event signatures (IUniswapV2Pair)
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    string public constant name = "Uniswap V2";
    string public constant symbol = "UNI-V2";
    uint8 public constant decimals = 18;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    address public immutable hook;
    bool public immutable nativeIsToken0;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    constructor(address coin, address wrappedNative, address _hook) {
        factory = msg.sender;
        (token0, token1) = coin < wrappedNative ? (coin, wrappedNative) : (wrappedNative, coin);
        nativeIsToken0 = token0 == wrappedNative;
        hook = _hook;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function totalSupply() external view returns (uint256) {
        return Math.sqrt(uint256(reserve0) * uint256(reserve1));
    }

    /// @dev Reserves are clamped to uint112 (V2 storage width); the clamp is display-only.
    function _set(uint256 rNative, uint256 rCoin) private returns (uint112 r0, uint112 r1) {
        uint256 max = type(uint112).max;
        if (rNative > max) rNative = max;
        if (rCoin > max) rCoin = max;
        (r0, r1) = nativeIsToken0 ? (uint112(rNative), uint112(rCoin)) : (uint112(rCoin), uint112(rNative));
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(r0, r1);
    }

    /// @notice Launch: initial reserves, emitted as V2 does on the first mint (Sync, then Mint).
    function init(uint256 rNative, uint256 rCoin) external {
        if (msg.sender != hook) revert NotHook();
        (uint112 r0, uint112 r1) = _set(rNative, rCoin);
        emit Mint(msg.sender, r0, r1);
    }

    /// @notice One trade in the V4 pool: new reserves (Sync), then the trader-side amounts (Swap).
    function update(address sender, address to, uint256 nativeIn, uint256 coinIn, uint256 nativeOut, uint256 coinOut, uint256 rNative, uint256 rCoin)
        external
    {
        if (msg.sender != hook) revert NotHook();
        _set(rNative, rCoin);
        if (nativeIsToken0) emit Swap(sender, nativeIn, coinIn, nativeOut, coinOut, to);
        else emit Swap(sender, coinIn, nativeIn, coinOut, nativeOut, to);
    }
}

/// @title MwzDisplayPairFactory (EVM generation 8, BNB Chain only)
/// @notice Emits the standard Uniswap V2 PairCreated so V2 indexers discover the display pairs. Immutable; the hook
/// is wired once by the deployer (the hook address depends on a mined salt that includes this factory's address).
/// Holds no funds.
contract MwzDisplayPairFactory {
    error NotHook();
    error NotDeployer();
    error PairExists();
    error HookAlreadySet();
    error ZeroAddress();

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);
    event HookSet(address indexed hook);

    address public immutable wrappedNative;
    address public immutable deployer;
    address public hook; // set once, then fixed
    address[] public allPairs;
    mapping(address => mapping(address => address)) public getPair;

    constructor(address _wrappedNative) {
        if (_wrappedNative == address(0)) revert ZeroAddress();
        wrappedNative = _wrappedNative;
        deployer = msg.sender;
    }

    /// @notice One-time wiring. Only the deployer, only once, never address(0).
    function setHook(address _hook) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (hook != address(0)) revert HookAlreadySet();
        if (_hook == address(0)) revert ZeroAddress();
        hook = _hook;
        emit HookSet(_hook);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Hook only (inside MwzLaunchHook.createPool). One pair per coin, CREATE2 salt = the coin address.
    function createPair(address coin) external returns (address pair) {
        if (msg.sender != hook || msg.sender == address(0)) revert NotHook();
        if (getPair[coin][wrappedNative] != address(0)) revert PairExists();
        pair = address(new MwzDisplayPair{salt: bytes32(uint256(uint160(coin)))}(coin, wrappedNative, msg.sender));
        getPair[coin][wrappedNative] = pair;
        getPair[wrappedNative][coin] = pair;
        allPairs.push(pair);
        (address t0, address t1) = coin < wrappedNative ? (coin, wrappedNative) : (wrappedNative, coin);
        emit PairCreated(t0, t1, pair, allPairs.length);
    }
}
