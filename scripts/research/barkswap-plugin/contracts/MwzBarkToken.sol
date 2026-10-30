// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Plain 18-decimal ERC20, 1B fixed supply minted once to the launcher. No owner, no tax.
//
// Optional side-pool guard (research option for check 8, off when `algebraFactory == 0`): while our pool has not
// graduated, a transfer TO any other Algebra pool of the Barkswap factory reverts. Detection: the recipient has
// code, answers factory() == the Barkswap factory and answers token0() (the router and NPM also answer factory()
// but have no token0()). Transfers to our own pool, to EOAs and to any other contract pass.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IGraduationView} from "./BarkInterfaces.sol";

contract MwzBarkToken is ERC20 {
    error SidePoolBlocked(address pool);
    error OnlyLauncher();

    address public immutable launcher;
    address public immutable algebraFactory; // 0 = no guard
    address public immutable plugin;
    address public pool; // our pool, set once by the launcher

    constructor(string memory name_, string memory symbol_, uint256 supply, address to, address factory_, address plugin_) ERC20(name_, symbol_) {
        launcher = msg.sender;
        algebraFactory = factory_;
        plugin = plugin_;
        _mint(to, supply);
    }

    function setPool(address p) external {
        if (msg.sender != launcher || pool != address(0)) revert OnlyLauncher();
        pool = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (algebraFactory != address(0) && from != address(0) && to.code.length != 0) {
            address ours = pool;
            if (to != ours && _isAlgebraPool(to) && !IGraduationView(plugin).isGraduated(ours)) revert SidePoolBlocked(to);
        }
        super._update(from, to, value);
    }

    function _isAlgebraPool(address a) internal view returns (bool) {
        (bool ok, bytes memory r) = a.staticcall{gas: 8000}(abi.encodeWithSelector(0xc45a0155)); // factory()
        if (!ok || r.length != 32 || abi.decode(r, (address)) != algebraFactory) return false;
        (ok, r) = a.staticcall{gas: 8000}(abi.encodeWithSelector(0x0dfe1681)); // token0()
        return ok && r.length == 32;
    }
}
