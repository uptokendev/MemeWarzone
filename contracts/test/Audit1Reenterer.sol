// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAudit1Campaign {
    function buyExactTokensAuthorized(uint256 amountOut, uint256 maxCost, uint8 routeProfile, uint64 routeDeadline, bytes calldata sig)
        external
        payable
        returns (uint256);
    function sellExactTokensAuthorized(uint256 amountIn, uint256 minPayout, uint8 routeProfile, uint64 routeDeadline, bytes calldata sig)
        external
        returns (uint256);
    function graduate() external returns (address);
    function token() external view returns (address);
}

interface IAudit1ERC20 {
    function approve(address, uint256) external returns (bool);
}

/// @notice Audit helper: a buyer whose refund callback tries to re-enter the campaign.
contract Audit1Reenterer {
    IAudit1Campaign public campaign;
    uint8 public mode; // 0 none, 1 sell on refund, 2 graduate on refund
    bool public reentered;
    bytes public sellSig;
    uint64 public sellDeadline;
    uint256 public sellAmount;

    constructor(address c) {
        campaign = IAudit1Campaign(c);
    }

    function setMode(uint8 m, uint256 amount, uint64 dl, bytes calldata sig) external {
        mode = m;
        sellAmount = amount;
        sellDeadline = dl;
        sellSig = sig;
    }

    function approveAll() external {
        IAudit1ERC20(campaign.token()).approve(address(campaign), type(uint256).max);
    }

    function buy(uint256 amountOut, uint256 maxCost, uint64 dl, bytes calldata sig) external payable {
        campaign.buyExactTokensAuthorized{value: msg.value}(amountOut, maxCost, 1, dl, sig);
    }

    receive() external payable {
        if (mode == 1) {
            reentered = true;
            campaign.sellExactTokensAuthorized(sellAmount, 0, 1, sellDeadline, sellSig);
        } else if (mode == 2) {
            reentered = true;
            campaign.graduate();
        }
    }
}
