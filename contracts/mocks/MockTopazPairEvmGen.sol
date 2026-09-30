// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Topaz (Velodrome V2 style) volatile pair mock for the EVM-generation fee tests: real constant-product
/// swap with a 30 bps fee and K check, getAmountOut/getReserves/quote with the live pool's signatures, LP fees
/// held apart from reserves and paid by claimFees. `quote` answers from settable "TWAP reserves" and reverts
/// until they are set, like a pool with too few observations.
interface IMockTopazFeeSource {
    function getFee(address pool, bool stable) external view returns (uint256);
}

contract MockTopazPairEvmGen is ERC20 {
    using SafeERC20 for IERC20;

    address public token0;
    address public token1;
    address public factory;
    bool public stable;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public feeHeld0;
    uint256 public feeHeld1;
    uint256 public twapReserve0;
    uint256 public twapReserve1;
    bool public swapDisabled;
    /// @dev A pool with TWAP history whose last closed window equals spot (quote answers from live reserves).
    bool public twapFollowsSpot;
    mapping(address => uint256) public claimable0;
    mapping(address => uint256) public claimable1;

    constructor() ERC20("Mock Topaz EvmGen LP", "mTLP-EG") {}

    /// @dev Signature used by MockTopazFactory.setPool; the caller becomes the pool's factory.
    function setTokens(address token0_, address token1_, bool stable_) external {
        token0 = token0_;
        token1 = token1_;
        stable = stable_;
        factory = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev The swap fee follows the factory's getFee (Topaz's per-pool fee, E13); 30 bps without a factory.
    function _feeBps() internal view returns (uint256) {
        if (factory == address(0)) return 30;
        return IMockTopazFeeSource(factory).getFee(address(this), false);
    }

    function seed(uint256 amount0, uint256 amount1) external {
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        reserve0 += amount0;
        reserve1 += amount1;
    }

    function fundFees(address account, uint256 amount0, uint256 amount1) external {
        if (amount0 != 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        feeHeld0 += amount0;
        feeHeld1 += amount1;
        claimable0[account] += amount0;
        claimable1[account] += amount1;
    }

    function claimFees() external returns (uint256 amount0, uint256 amount1) {
        amount0 = claimable0[msg.sender];
        amount1 = claimable1[msg.sender];
        claimable0[msg.sender] = 0;
        claimable1[msg.sender] = 0;
        feeHeld0 -= amount0;
        feeHeld1 -= amount1;
        if (amount0 != 0) IERC20(token0).safeTransfer(msg.sender, amount0);
        if (amount1 != 0) IERC20(token1).safeTransfer(msg.sender, amount1);
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, block.timestamp);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        return _out(amountIn, tokenIn, reserve0, reserve1);
    }

    function setTwapReserves(uint256 r0, uint256 r1) external {
        twapReserve0 = r0;
        twapReserve1 = r1;
    }

    function setSwapDisabled(bool disabled) external {
        swapDisabled = disabled;
    }

    function setTwapFollowsSpot(bool on) external {
        twapFollowsSpot = on;
    }

    function quote(address tokenIn, uint256 amountIn, uint256) external view returns (uint256) {
        if (twapFollowsSpot) return _out(amountIn, tokenIn, reserve0, reserve1);
        require(twapReserve0 != 0 && twapReserve1 != 0, "observations");
        return _out(amountIn, tokenIn, twapReserve0, twapReserve1);
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

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        _burnSwapGas();
        require(!swapDisabled, "swap disabled");
        require(amount0Out < reserve0 && amount1Out < reserve1, "IL");
        require(amount0Out != 0 || amount1Out != 0, "IOA");
        if (amount0Out != 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out != 0) IERC20(token1).safeTransfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this)) - feeHeld0;
        uint256 b1 = IERC20(token1).balanceOf(address(this)) - feeHeld1;
        uint256 in0 = b0 > reserve0 - amount0Out ? b0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = b1 > reserve1 - amount1Out ? b1 - (reserve1 - amount1Out) : 0;
        require(in0 != 0 || in1 != 0, "IIA");
        // Same rounding as the live pool: the fee is floor(in * 30 / 10000), removed before the K check.
        uint256 adj0 = b0 - (in0 * _feeBps()) / 10_000;
        uint256 adj1 = b1 - (in1 * _feeBps()) / 10_000;
        require(adj0 * adj1 >= reserve0 * reserve1, "K");
        reserve0 = b0;
        reserve1 = b1;
    }

    function _out(uint256 amountIn, address tokenIn, uint256 r0, uint256 r1) private view returns (uint256) {
        (uint256 rIn, uint256 rOut) = tokenIn == token0 ? (r0, r1) : (r1, r0);
        uint256 net = amountIn - (amountIn * _feeBps()) / 10_000;
        return (net * rOut) / (rIn + net);
    }
}
