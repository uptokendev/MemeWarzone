// SPDX-License-Identifier: GPL-2.0-or-later
// Algebra Integral v1.2.1 interface (GPL-2.0-or-later), copied from cryptoalgebra/Algebra tag v1.2.1-integral,
// src/core/contracts/interfaces/IAlgebraPool.sol. Unchanged except this header.
pragma solidity >=0.8.4;

import './pool/IAlgebraPoolImmutables.sol';
import './pool/IAlgebraPoolState.sol';
import './pool/IAlgebraPoolActions.sol';
import './pool/IAlgebraPoolPermissionedActions.sol';
import './pool/IAlgebraPoolEvents.sol';
import './pool/IAlgebraPoolErrors.sol';

/// @title The interface for a Algebra Pool
/// @dev The pool interface is broken up into many smaller pieces.
/// This interface includes custom error definitions and cannot be used in older versions of Solidity.
/// For older versions of Solidity use #IAlgebraPoolLegacy
/// Credit to Uniswap Labs under GPL-2.0-or-later license:
/// https://github.com/Uniswap/v3-core/tree/main/contracts/interfaces
interface IAlgebraPool is
  IAlgebraPoolImmutables,
  IAlgebraPoolState,
  IAlgebraPoolActions,
  IAlgebraPoolPermissionedActions,
  IAlgebraPoolEvents,
  IAlgebraPoolErrors
{
  // used only for combining interfaces
}
