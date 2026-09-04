// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMonthlyCapOracle {
    function nativeUsdPrice() external view returns (uint256);
}

/// @notice Seals monthly league prize pools against an oracle-derived cap and routes overflow to charity.
contract MonthlyLeagueTreasury is ReentrancyGuard {
    uint256 public constant DEFAULT_MONTHLY_CAP_USD = 1_500_000 ether;
    uint256 private constant WAD = 1e18;

    struct MonthSeal {
        bool isSealed;
        bytes32 winnersRoot;
        uint256 oraclePrice;
        uint256 capUsd;
        uint256 capNative;
        uint256 playerPool;
        uint256 winnerTotal;
        uint256 overflow;
        uint256 sealedAt;
    }

    struct MonthAuthorization {
        uint256 maxWinnerPool;
        uint64 sealAfter;
        uint64 sealDeadline;
        bool authorized;
        bool consumed;
        bool exceptional;
    }

    address public immutable multisig;
    address public rootPoster;
    IMonthlyCapOracle public immutable oracle;
    address public immutable charityTreasury;
    uint256 public immutable monthlyCapUsd;

    mapping(uint256 => MonthSeal) public monthSeal;
    mapping(uint256 => MonthAuthorization) public monthAuthorization;
    mapping(uint256 => uint256) public monthClaimedTotal;
    mapping(uint256 => uint256) public monthOutstandingClaims;
    mapping(uint256 => mapping(bytes32 => bool)) public monthLeafClaimed;
    uint256 public totalOutstandingClaims;
    uint256 public lastAuthorizedMonthId;

    event RootPosterUpdated(address indexed oldRootPoster, address indexed newRootPoster);
    event MonthAuthorized(uint256 indexed monthId, uint256 maxWinnerPool, uint64 sealAfter, uint64 sealDeadline, bool exceptional);
    event MonthAuthorizationRevoked(uint256 indexed monthId);
    event MonthSealed(
        uint256 indexed monthId,
        bytes32 indexed winnersRoot,
        uint256 capUsd,
        uint256 capNative,
        uint256 playerPool,
        uint256 winnerTotal,
        uint256 overflow
    );
    event ClaimReserveUpdated(uint256 indexed monthId, uint256 monthOutstanding, uint256 totalOutstanding);
    event Claimed(uint256 indexed monthId, address indexed recipient, uint256 amount, bytes32 indexed leaf);
    event NativeWithdrawn(address indexed to, uint256 amount);

    error NotMultisig();
    error NotRootPosterOrMultisig();
    error ZeroAddress();
    error RootZero();
    error MonthAlreadySealed();
    error MonthNotSealed();
    error WinnerTotalAboveCap();
    error WinnerTotalAbovePlayerPool();
    error AmountZero();
    error AlreadyClaimed();
    error BadProof();
    error ClaimExceedsWinnerTotal();
    error InsufficientBalance();
    error ReservedBalanceInvariant();
    error NativeTransferFailed();
    error InvalidMonthId();
    error MonthNotNextCanonical();
    error MonthNotAuthorized();
    error MonthAuthConsumed();
    error MonthAuthRevoked();
    error SealTooEarly();
    error SealAuthExpired();
    error WinnerTotalAboveAuthorizedMax();
    error BadSealWindow();

    modifier onlyMultisig() {
        if (msg.sender != multisig) revert NotMultisig();
        _;
    }

    modifier onlyRootPosterOrMultisig() {
        if (msg.sender != rootPoster && msg.sender != multisig) revert NotRootPosterOrMultisig();
        _;
    }

    constructor(address multisig_, address rootPoster_, address oracle_, address charityTreasury_, uint256 monthlyCapUsd_) {
        if (multisig_ == address(0) || oracle_ == address(0) || charityTreasury_ == address(0)) revert ZeroAddress();
        multisig = multisig_;
        rootPoster = rootPoster_;
        oracle = IMonthlyCapOracle(oracle_);
        charityTreasury = charityTreasury_;
        monthlyCapUsd = monthlyCapUsd_ == 0 ? DEFAULT_MONTHLY_CAP_USD : monthlyCapUsd_;
        emit RootPosterUpdated(address(0), rootPoster_);
    }

    receive() external payable {}

    function setRootPoster(address newRootPoster) external onlyMultisig {
        emit RootPosterUpdated(rootPoster, newRootPoster);
        rootPoster = newRootPoster;
    }

    function nextCanonicalMonth(uint256 monthId) public pure returns (uint256) {
        uint256 year = monthId / 100;
        uint256 month = monthId % 100;
        if (year < 2020 || month < 1 || month > 12) revert InvalidMonthId();
        if (month == 12) return (year + 1) * 100 + 1;
        return monthId + 1;
    }

    /// @notice Safe-only: approve a canonical month (or an exceptional recovery month).
    function authorizeMonth(
        uint256 monthId,
        uint256 maxWinnerPool,
        uint64 sealAfter,
        uint64 sealDeadline,
        bool exceptional
    ) external onlyMultisig {
        if (maxWinnerPool == 0) revert AmountZero();
        if (sealDeadline <= sealAfter) revert BadSealWindow();
        uint256 year = monthId / 100;
        uint256 month = monthId % 100;
        if (year < 2020 || month < 1 || month > 12) revert InvalidMonthId();
        if (!exceptional) {
            if (lastAuthorizedMonthId == 0 || monthId == lastAuthorizedMonthId) {
                // First month, or re-authorization of the current unsealed month after revoke.
            } else {
                if (!monthSeal[lastAuthorizedMonthId].isSealed) revert MonthNotNextCanonical();
                if (monthId != nextCanonicalMonth(lastAuthorizedMonthId)) revert MonthNotNextCanonical();
            }
        }
        MonthAuthorization storage auth = monthAuthorization[monthId];
        if (auth.consumed) revert MonthAuthConsumed();
        if (monthSeal[monthId].isSealed) revert MonthAlreadySealed();
        auth.maxWinnerPool = maxWinnerPool;
        auth.sealAfter = sealAfter;
        auth.sealDeadline = sealDeadline;
        auth.authorized = true;
        auth.consumed = false;
        auth.exceptional = exceptional;
        if (!exceptional) lastAuthorizedMonthId = monthId;
        emit MonthAuthorized(monthId, maxWinnerPool, sealAfter, sealDeadline, exceptional);
    }

    function revokeMonth(uint256 monthId) external onlyMultisig {
        MonthAuthorization storage auth = monthAuthorization[monthId];
        if (!auth.authorized || auth.consumed) revert MonthAuthRevoked();
        auth.authorized = false;
        emit MonthAuthorizationRevoked(monthId);
    }

    /// @notice Native balance that is not reserved for already sealed, unclaimed winner roots.
    function unallocatedBalance() public view returns (uint256) {
        uint256 balance = address(this).balance;
        if (balance < totalOutstandingClaims) revert ReservedBalanceInvariant();
        return balance - totalOutstandingClaims;
    }

    function sealMonth(uint256 monthId, bytes32 winnersRoot, uint256 winnerTotal) external onlyRootPosterOrMultisig nonReentrant {
        if (winnersRoot == bytes32(0)) revert RootZero();
        if (monthSeal[monthId].isSealed) revert MonthAlreadySealed();
        MonthAuthorization storage auth = monthAuthorization[monthId];
        if (!auth.authorized || auth.consumed) revert MonthNotAuthorized();
        if (block.timestamp < auth.sealAfter) revert SealTooEarly();
        if (block.timestamp > auth.sealDeadline) revert SealAuthExpired();
        if (winnerTotal > auth.maxWinnerPool) revert WinnerTotalAboveAuthorizedMax();
        auth.consumed = true;

        uint256 oraclePrice = oracle.nativeUsdPrice();
        uint256 capNative = Math.mulDiv(monthlyCapUsd, WAD, oraclePrice, Math.Rounding.Ceil);
        if (winnerTotal > capNative) revert WinnerTotalAboveCap();

        uint256 available = unallocatedBalance();
        uint256 playerPool = available > capNative ? capNative : available;
        if (winnerTotal > playerPool) revert WinnerTotalAbovePlayerPool();

        uint256 overflow = available - playerPool;
        monthSeal[monthId] = MonthSeal({
            isSealed: true,
            winnersRoot: winnersRoot,
            oraclePrice: oraclePrice,
            capUsd: monthlyCapUsd,
            capNative: capNative,
            playerPool: playerPool,
            winnerTotal: winnerTotal,
            overflow: overflow,
            sealedAt: block.timestamp
        });
        monthOutstandingClaims[monthId] = winnerTotal;
        totalOutstandingClaims += winnerTotal;

        if (overflow != 0) {
            (bool ok, ) = payable(charityTreasury).call{value: overflow}("");
            if (!ok) revert NativeTransferFailed();
        }

        emit MonthSealed(monthId, winnersRoot, monthlyCapUsd, capNative, playerPool, winnerTotal, overflow);
        emit ClaimReserveUpdated(monthId, winnerTotal, totalOutstandingClaims);
    }

    function claim(
        uint256 monthId,
        bytes32 category,
        uint8 rank,
        address payable recipient,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        MonthSeal memory seal = monthSeal[monthId];
        if (!seal.isSealed) revert MonthNotSealed();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();

        bytes32 leaf = keccak256(abi.encode(monthId, category, rank, recipient, amount));
        if (monthLeafClaimed[monthId][leaf]) revert AlreadyClaimed();
        if (!MerkleProof.verify(proof, seal.winnersRoot, leaf)) revert BadProof();

        uint256 newClaimedTotal = monthClaimedTotal[monthId] + amount;
        if (newClaimedTotal > seal.winnerTotal || amount > monthOutstandingClaims[monthId]) revert ClaimExceedsWinnerTotal();
        if (amount > address(this).balance) revert InsufficientBalance();

        monthClaimedTotal[monthId] = newClaimedTotal;
        monthOutstandingClaims[monthId] -= amount;
        totalOutstandingClaims -= amount;
        monthLeafClaimed[monthId][leaf] = true;

        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit ClaimReserveUpdated(monthId, monthOutstandingClaims[monthId], totalOutstandingClaims);
        emit Claimed(monthId, recipient, amount, leaf);
    }

    /// @notice Multisig-only emergency/manual withdrawal for unallocated residuals or migration.
    /// @dev Sealed but unclaimed winner reserves cannot be withdrawn.
    function withdrawNative(address payable to, uint256 amount) external onlyMultisig nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > unallocatedBalance()) revert InsufficientBalance();

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeWithdrawn(to, amount);
    }
}
