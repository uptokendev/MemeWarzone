// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * The TopazRouterAdapter half of the Topaz surface, and nothing else.
 *
 * The real adapter (0x5c3135Df… on BNB, 0xC49895Ee… on BSC testnet) answers
 * poolFactory() and WETH() and reverts defaultFactory() and weth(); Topaz's own
 * router does the opposite. MockTopazRouter answers all four, so it cannot show
 * what happens when the two are passed the wrong way round. This one can.
 */
contract MockTopazAdapterOnly {
    address public immutable poolFactoryAddress;
    address public immutable wrapped;

    constructor(address poolFactory_, address wrapped_) {
        poolFactoryAddress = poolFactory_;
        wrapped = wrapped_;
    }

    function poolFactory() external view returns (address) {
        return poolFactoryAddress;
    }

    function WETH() external view returns (address) {
        return wrapped;
    }
}
