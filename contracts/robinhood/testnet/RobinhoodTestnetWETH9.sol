// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title Robinhood Testnet WETH9
/// @notice Testnet-only wrapped ETH with canonical WETH9 deposit/withdraw/ERC20 behavior.
/// @dev Behavior is pinned to the classic WETH9 contract used by Uniswap periphery. The Solidity
///      version is modernized only for this repository's compiler; externally observable WETH9
///      semantics are intentionally unchanged. Deployment is restricted to 46630, with 31337 only
///      when explicitly enabled for deterministic local rehearsal.
contract RobinhoodTestnetWETH9 {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    string public constant SOURCE_VERSION = "canonical-weth9-behavior/mwz-rh46630-v1";
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
    uint256 public constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 public constant LOCAL_REHEARSAL_CHAIN_ID = 31337;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error WrongChain(uint256 chainId);

    constructor(bool allowLocalRehearsal) {
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid);
        bool localAllowed = allowLocalRehearsal && block.chainid == LOCAL_REHEARSAL_CHAIN_ID;
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID && !localAllowed) revert WrongChain(block.chainid);
    }

    receive() external payable {
        deposit();
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "WETH: insufficient");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WETH: insufficient");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WETH: allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
