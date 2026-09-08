// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MockUniswapV3Factory} from "./MockUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

/// @dev Minimal NonfungiblePositionManager-compatible surface for MWZ staging.
contract MockUniswapV3PositionManager is ERC721 {
    using SafeERC20 for IERC20;

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct StoredPosition {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address pool;
    }

    address public immutable factory;
    address public immutable WETH9;
    uint256 public nextTokenId = 1;
    mapping(uint256 => StoredPosition) private _positions;

    constructor(address factory_, address weth9_) ERC721("Mock Uniswap V3 Position", "mUNI-V3-POS") {
        require(factory_ != address(0) && weth9_ != address(0), "zero dependency");
        factory = factory_;
        WETH9 = weth9_;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee_, uint160 sqrtPriceX96)
        external
        returns (address pool)
    {
        require(token0 < token1, "unsorted");
        MockUniswapV3Factory f = MockUniswapV3Factory(factory);
        pool = f.getPool(token0, token1, fee_);
        if (pool == address(0)) pool = f.createPool(token0, token1, fee_);
        if (MockUniswapV3Pool(pool).sqrtPriceX96() == 0) {
            MockUniswapV3Pool(pool).initialize(sqrtPriceX96);
        }
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "expired");
        require(params.token0 < params.token1, "unsorted");
        require(params.recipient != address(0), "zero recipient");
        require(params.tickLower < params.tickUpper, "bad ticks");
        require(params.amount0Desired >= params.amount0Min && params.amount1Desired >= params.amount1Min, "slippage");
        require(params.amount0Desired != 0 && params.amount1Desired != 0, "zero liquidity");

        address pool = MockUniswapV3Factory(factory).getPool(params.token0, params.token1, params.fee);
        require(pool != address(0), "pool missing");
        require(MockUniswapV3Pool(pool).sqrtPriceX96() != 0, "pool uninitialized");

        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        uint256 liquidityBase = amount0 < amount1 ? amount0 : amount1;
        require(liquidityBase <= type(uint128).max, "liquidity overflow");
        liquidity = uint128(liquidityBase);

        tokenId = nextTokenId++;
        IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);
        IERC20(params.token0).forceApprove(pool, amount0);
        IERC20(params.token1).forceApprove(pool, amount1);
        MockUniswapV3Pool(pool).seedLiquidity(tokenId, amount0, amount1);
        IERC20(params.token0).forceApprove(pool, 0);
        IERC20(params.token1).forceApprove(pool, 0);

        _positions[tokenId] = StoredPosition({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            pool: pool
        });
        _safeMint(params.recipient, tokenId);
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        require(params.recipient != address(0), "zero recipient");
        address owner = ownerOf(params.tokenId);
        require(
            msg.sender == owner || getApproved(params.tokenId) == msg.sender || isApprovedForAll(owner, msg.sender),
            "not authorized"
        );
        StoredPosition memory position = _positions[params.tokenId];
        (amount0, amount1) = MockUniswapV3Pool(position.pool).collectFees(
            params.tokenId,
            params.recipient,
            params.amount0Max,
            params.amount1Max
        );
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee_,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        ownerOf(tokenId);
        StoredPosition memory p = _positions[tokenId];
        nonce = 0;
        operator = getApproved(tokenId);
        token0 = p.token0;
        token1 = p.token1;
        fee_ = p.fee;
        tickLower = p.tickLower;
        tickUpper = p.tickUpper;
        liquidity = p.liquidity;
        feeGrowthInside0LastX128 = 0;
        feeGrowthInside1LastX128 = 0;
        uint256 owed0 = MockUniswapV3Pool(p.pool).claimable0();
        uint256 owed1 = MockUniswapV3Pool(p.pool).claimable1();
        tokensOwed0 = owed0 > type(uint128).max ? type(uint128).max : uint128(owed0);
        tokensOwed1 = owed1 > type(uint128).max ? type(uint128).max : uint128(owed1);
    }

    function poolForPosition(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _positions[tokenId].pool;
    }
}
