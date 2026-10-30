// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title MwzBarkFeeBooks: the pure book arithmetic of MwzBarkLauncher's money side
/// @notice Every array here has the book order [creator bonding, router bonding, creator post, router post], the order
/// of MwzBarkPlugin.FeeTotals (bonding.creator, bonding.router, post.creator, post.router). Pure functions, no state, no
/// external call. Audit: docs/dogeos/barkswap-audit.md (MwzBarkLauncher, "Fee books" and the collect / convert entries).
library MwzBarkFeeBooks {
    uint256 internal constant CREATOR_BONDING = 0;
    uint256 internal constant ROUTER_BONDING = 1;
    uint256 internal constant CREATOR_POST = 2;
    uint256 internal constant ROUTER_POST = 3;

    /// @notice Splits `amount`, what one collect actually received in one token, over the four books, steered by `d`,
    /// the plugin's per-book fee totals booked since the previous collect (same token). The result sums to `amount`
    /// exactly (books == balances), whatever `d` is:
    /// 1. creators first, each capped at its plugin amount (B10: the creator's amount is the plugin's, computed on the
    ///    gross fee; it is cut only if the whole collect is smaller, which needs an outside LP sharing our fees);
    /// 2. the router gets the rest: router bonding its plugin amount if the rest covers both router books, otherwise
    ///    its pro-rata share of the rest (floor); router post everything else. So Algebra's rounding (either sign) and
    ///    any unbooked surplus (flash fees, tokens sent straight to the pool, fees of a period in which an admin had
    ///    turned our hooks off) land in router post, which the splitter routes as protocol remainder (no band grows).
    /// @dev No overflow: every value is a sum of uint128 amounts; mulDiv(rest, d1, dR) <= d1 because rest < dR there.
    function apportion(uint256 amount, uint256[4] memory d) public pure returns (uint256[4] memory b) {
        uint256 rest = amount;
        b[CREATOR_BONDING] = d[CREATOR_BONDING] < rest ? d[CREATOR_BONDING] : rest;
        rest -= b[CREATOR_BONDING];
        b[CREATOR_POST] = d[CREATOR_POST] < rest ? d[CREATOR_POST] : rest;
        rest -= b[CREATOR_POST];
        uint256 dR = d[ROUTER_BONDING] + d[ROUTER_POST];
        b[ROUTER_BONDING] = rest >= dR ? d[ROUTER_BONDING] : FullMath.mulDiv(rest, d[ROUTER_BONDING], dR);
        b[ROUTER_POST] = rest - b[ROUTER_BONDING];
    }

    /// @notice The conversion's pro-rata draw: `used` coins (what the pool took, <= `pending` = the sum of `books`) are
    /// drawn as the same fraction used / pending from every pending coin book, and `out` (the WDOGE the pool paid) is
    /// returned to the books in proportion to what each gave. `taken` sums to `used` and `got` to `out`, exactly.
    /// @dev Floors leave at most 3 coins of `used` unassigned; they are placed on the books with room left, router post
    /// first (total room = pending - sum(floors) >= the leftover because used <= pending), so no book goes negative.
    /// The native floors leave at most 3 wei, which go to router post. `used == pending` draws every book whole.
    /// Reverts (checked arithmetic) only if used > pending, which the pool cannot return for an exact-input swap.
    function draw(uint256[4] memory books, uint256 used, uint256 pending, uint256 out)
        public
        pure
        returns (uint256[4] memory taken, uint256[4] memory got)
    {
        uint256 sumTaken;
        uint256 sumGot;
        for (uint256 i; i < 4; ++i) {
            taken[i] = used == pending ? books[i] : FullMath.mulDiv(books[i], used, pending);
            sumTaken += taken[i];
        }
        uint256 left = used - sumTaken;
        for (uint256 i = 4; left != 0 && i != 0;) {
            --i;
            uint256 room = books[i] - taken[i];
            uint256 add = room < left ? room : left;
            taken[i] += add;
            left -= add;
        }
        if (used != 0) {
            for (uint256 i; i < 4; ++i) {
                got[i] = FullMath.mulDiv(out, taken[i], used);
                sumGot += got[i];
            }
        }
        got[ROUTER_POST] += out - sumGot;
    }
}
