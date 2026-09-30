// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only griefer: tries to move MEME into a Topaz pair before trading is enabled.
contract MockEvmGenBnbGrief {
    function tryTransfer(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function tryApproveAndTransferFrom(address token, address from, address to, uint256 amount) external {
        IERC20(token).transferFrom(from, to, amount);
    }

    receive() external payable {}
}
