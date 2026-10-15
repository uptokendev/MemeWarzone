// SPDX-License-Identifier: GPL-2.0-or-later
// Algebra Integral v1.2.1 interface (GPL-2.0-or-later), copied from cryptoalgebra/Algebra tag v1.2.1-integral,
// src/periphery/contracts/interfaces/external/IWNativeToken.sol. Unchanged except this header.
pragma solidity ^0.8.0;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title Interface for WNativeToken
interface IWNativeToken is IERC20 {
    /// @notice Deposit ether to get wrapped ether
    function deposit() external payable;

    /// @notice Withdraw wrapped ether to get ether
    function withdraw(uint256) external;
}
