// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IMockV3SwapCallbackEvmGen {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @dev Uniswap V3 pool mock with one full-range liquidity L and the real exact-input swap math
/// (sqrtPriceX96, sqrtPriceLimitX96 partial fills, 0.30% fee on the input), pay-by-callback, and LP fees
/// accrued to a single position collected through the position manager. Ticks are not simulated: `tick`
/// and the TWAP answer of observe() are set by the test; observe() reverts until one is set.
contract MockUniswapV3PoolEvmGen {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 2 ** 96;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public positionManager;
    uint160 public sqrtPriceX96;
    uint128 public liquidity;
    int24 public tick;
    bool public twapSet;
    int56 public twapTick;
    uint16 public cardinalityNext = 1;
    uint256 public claimable0;
    uint256 public claimable1;

    constructor(address tokenA, address tokenB, uint24 fee_) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
    }

    function setup(address positionManager_, uint160 sqrtPriceX96_, uint128 liquidity_) external {
        positionManager = positionManager_;
        sqrtPriceX96 = sqrtPriceX96_;
        liquidity = liquidity_;
    }

    function setTick(int24 tick_) external {
        tick = tick_;
    }

    function setTwap(bool set_, int56 twapTick_) external {
        twapSet = set_;
        twapTick = twapTick_;
    }

    /// @dev Test helper: a third party's swap fees owed to the single position.
    function accrueFees(uint256 amount0, uint256 amount1) external {
        if (amount0 != 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        claimable0 += amount0;
        claimable1 += amount1;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick, 0, 1, cardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory cum, uint160[] memory spl) {
        require(twapSet, "OLD");
        cum = new int56[](secondsAgos.length);
        spl = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            cum[i] = -twapTick * int56(uint56(secondsAgos[i]));
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > cardinalityNext) cardinalityNext = next;
    }

    function collectFees(address recipient, uint128 max0, uint128 max1) external returns (uint256 a0, uint256 a1) {
        require(msg.sender == positionManager, "only npm");
        a0 = claimable0 < max0 ? claimable0 : max0;
        a1 = claimable1 < max1 ? claimable1 : max1;
        claimable0 -= a0;
        claimable1 -= a1;
        if (a0 != 0) IERC20(token0).safeTransfer(recipient, a0);
        if (a1 != 0) IERC20(token1).safeTransfer(recipient, a1);
    }

    /// @dev Test knob: gas each swap burns first, to model an expensive real pool (harvest gas guard tests).
    uint256 public swapGasBurn;

    function setSwapGasBurn(uint256 amount) external {
        swapGasBurn = amount;
    }

    function _burnSwapGas() internal view {
        uint256 amount = swapGasBurn;
        if (amount == 0) return;
        uint256 start = gasleft();
        while (start - gasleft() < amount) {}
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        _burnSwapGas();
        require(amountSpecified > 0, "exact input only");
        uint256 L = liquidity;
        uint256 sp = sqrtPriceX96;
        uint256 lq = L << 96;
        uint256 amtIn = uint256(amountSpecified);
        uint256 net = (amtIn * (1e6 - fee)) / 1e6;
        uint256 next;
        uint256 out;
        if (zeroForOne) {
            require(limit < sp && limit > MIN_SQRT_RATIO, "SPL");
            next = Math.mulDiv(lq, sp, lq + net * sp, Math.Rounding.Ceil);
            if (next < limit) {
                next = limit;
                net = Math.mulDiv(lq, sp - next, sp * next, Math.Rounding.Ceil);
                amtIn = Math.mulDiv(net, 1e6, 1e6 - fee, Math.Rounding.Ceil);
            }
            out = Math.mulDiv(L, sp - next, Q96);
            claimable0 += amtIn - net;
            sqrtPriceX96 = uint160(next);
            if (out != 0) IERC20(token1).safeTransfer(recipient, out);
            uint256 before = IERC20(token0).balanceOf(address(this));
            IMockV3SwapCallbackEvmGen(msg.sender).uniswapV3SwapCallback(int256(amtIn), -int256(out), data);
            require(IERC20(token0).balanceOf(address(this)) >= before + amtIn, "IIA");
            return (int256(amtIn), -int256(out));
        } else {
            require(limit > sp && limit < MAX_SQRT_RATIO, "SPL");
            next = sp + Math.mulDiv(net, Q96, L);
            if (next > limit) {
                next = limit;
                net = Math.mulDiv(L, next - sp, Q96, Math.Rounding.Ceil);
                amtIn = Math.mulDiv(net, 1e6, 1e6 - fee, Math.Rounding.Ceil);
            }
            out = Math.mulDiv(lq, next - sp, next * sp);
            claimable1 += amtIn - net;
            sqrtPriceX96 = uint160(next);
            if (out != 0) IERC20(token0).safeTransfer(recipient, out);
            uint256 before = IERC20(token1).balanceOf(address(this));
            IMockV3SwapCallbackEvmGen(msg.sender).uniswapV3SwapCallback(-int256(out), int256(amtIn), data);
            require(IERC20(token1).balanceOf(address(this)) >= before + amtIn, "IIA");
            return (-int256(out), int256(amtIn));
        }
    }
}

contract MockUniswapV3FactoryEvmGen {
    mapping(bytes32 => address) internal pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address a, address b, uint24 fee) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b, fee)) : keccak256(abi.encode(b, a, fee));
    }
}

contract MockUniswapV3PositionManagerEvmGen is ERC721 {
    struct Pos {
        address pool;
        address token0;
        address token1;
        uint24 fee;
        uint128 liquidity;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Pos) internal pos;

    constructor() ERC721("Mock V3 EvmGen Position", "mV3EG") {}

    function mintPosition(address to, address pool) external returns (uint256 id) {
        id = nextId++;
        MockUniswapV3PoolEvmGen p = MockUniswapV3PoolEvmGen(pool);
        pos[id] = Pos(pool, p.token0(), p.token1(), p.fee(), p.liquidity());
        _mint(to, id);
    }

    function positions(uint256 id)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        ownerOf(id);
        Pos memory p = pos[id];
        return (0, address(0), p.token0, p.token1, p.fee, -887220, 887220, p.liquidity, 0, 0, 0, 0);
    }

    function collect(CollectParams calldata params) external payable returns (uint256, uint256) {
        require(ownerOf(params.tokenId) == msg.sender, "not owner");
        return MockUniswapV3PoolEvmGen(pos[params.tokenId].pool).collectFees(params.recipient, params.amount0Max, params.amount1Max);
    }
}

/// @dev Stands in for the graduation adapter as the locker's integration source.
contract MockV3IntegrationEvmGen {
    address public v3Factory;
    address public positionManager;
    address public WETH;

    constructor(address v3Factory_, address positionManager_, address weth_) {
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        WETH = weth_;
    }

    function liquidityKind() external pure returns (uint8) {
        return 2;
    }

    function feeTier() external pure returns (uint24) {
        return 3000;
    }

    function deliver(address locker, uint256 tokenId) external {
        ERC721(positionManager).safeTransferFrom(address(this), locker, tokenId);
    }
}
