// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "./LaunchToken.sol";

/// @notice Deploys a campaign's LaunchToken with the caller (the campaign) as owner. It exists only to
/// keep LaunchToken's creation code out of the campaign's runtime bytecode (EIP-170, E7). Anyone can
/// call it, but the token it makes is always owned by the caller, so it cannot mint or move anyone
/// else's token; the campaign mints its supply right after and that mint is onlyOwner.
contract LaunchTokenDeployer {
    function deploy(string calldata name, string calldata symbol, uint256 cap) external returns (address) {
        return address(new LaunchToken(name, symbol, cap, msg.sender));
    }
}
