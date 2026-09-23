// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice An ERC20 that can be told to fail transfers to one address.
/// @dev Exists to reach the pending-balance branches in the permanent lockers.
/// They accrue a payout when a token transfer to a fee recipient fails, and
/// until now nothing could make one fail, so neither the accrual nor the claim
/// that drains it had ever executed. Real tokens fail this way for ordinary
/// reasons: blocklists, paused transfers, recipients that revert in a hook.
contract MockBlockableERC20 {
    string public name = "Blockable";
    string public symbol = "BLK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Transfers to this address revert. Zero disables the behaviour.
    address public blocked;
    /// When true the transfer returns false instead of reverting, which is the
    /// other way real tokens fail and the one that silently skips a require.
    bool public returnFalseInsteadOfRevert;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setBlocked(address account, bool returnFalse) external {
        blocked = account;
        returnFalseInsteadOfRevert = returnFalse;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        if (to == blocked && blocked != address(0)) {
            if (returnFalseInsteadOfRevert) return false;
            revert("BLOCKED");
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
