// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

// TEST ONLY. Never deployed to any network. Used by test/MuchfiPositionLocker.fork.spec.ts on a Hardhat fork of
// DogeOS Chikyū (6281971) as the locker's integration source: the surface the position lockers read in
// configureRevenue (liquidityKind 2, v3Factory, positionManager, WETH, feeTier) for the MuchFi 1% tier, plus a
// deliver() that hands a MuchFi position NFT to a locker the way the graduation adapter does (operator == from ==
// this contract). Same shape as MockV3IntegrationEvmGen (contracts/mocks/MockUniswapV3EvmGen.sol), whose
// feeTier() is a hard-coded 3000 that MuchFi does not offer.
contract MuchfiForkLockerIntegration is IERC721Receiver {
    uint24 public constant MUCHFI_FEE_TIER = 10_000;

    address public immutable v3Factory;
    address public immutable positionManager;
    address public immutable WETH;

    constructor(address v3Factory_, address positionManager_, address weth_) {
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        WETH = weth_;
    }

    function liquidityKind() external pure returns (uint8) {
        return 2;
    }

    function feeTier() external pure returns (uint24) {
        return MUCHFI_FEE_TIER;
    }

    function deliver(address locker, uint256 tokenId) external {
        IERC721(positionManager).safeTransferFrom(address(this), locker, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
