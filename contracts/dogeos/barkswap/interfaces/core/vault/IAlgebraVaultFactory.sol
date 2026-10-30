// SPDX-License-Identifier: GPL-2.0-or-later
// Algebra Integral v1.2.1 interface (GPL-2.0-or-later), copied from cryptoalgebra/Algebra tag v1.2.1-integral,
// src/core/contracts/interfaces/vault/IAlgebraVaultFactory.sol. Unchanged except this header.
pragma solidity >=0.5.0;

/// @title The interface for the Algebra Vault Factory
/// @notice This contract can be used for automatic vaults creation
/// @dev Version: Algebra Integral
interface IAlgebraVaultFactory {
  /// @notice returns address of the community fee vault for the pool
  /// @param pool the address of Algebra Integral pool
  /// @return communityFeeVault the address of community fee vault
  function getVaultForPool(address pool) external view returns (address communityFeeVault);

  /// @notice creates the community fee vault for the pool if needed
  /// @param pool the address of Algebra Integral pool
  /// @return communityFeeVault the address of community fee vault
  function createVaultForPool(
    address pool,
    address creator,
    address deployer,
    address token0,
    address token1
  ) external returns (address communityFeeVault);
}
