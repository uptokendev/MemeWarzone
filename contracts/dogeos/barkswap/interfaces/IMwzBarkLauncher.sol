// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IMwzBarkLauncher: the launcher surface MwzBarkPlugin calls
/// @notice MwzBarkPlugin (the one shared Algebra Integral 1.2.1 plugin for every MemeWarzone Barkswap custom pool)
/// calls the launcher for exactly two things: to tell a coin-fee conversion swap from the launcher's other swap, and to
/// take the one-time graduation fee inline in the latching swap. Everything else the plugin needs (start and
/// graduation price, openAt, the coin) is handed to it once per pool through `MwzBarkPlugin.registerPool`, so a normal
/// trade makes no call to the launcher at all. Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md
/// section 3; audit: docs/dogeos/barkswap-audit.md (MwzBarkPlugin, "Launcher obligations").
///
/// Launcher obligations the plugin relies on (MwzBarkLauncher, t32/t4, must uphold every one; the audit checks them):
/// - O1 Registration: `plugin.registerPool(pool, coin, tickStart, tickGrad, openAt)` before the pool exists (before
///   `EP.createCustomPool`, or inside `beforeCreatePoolHook`), with the coin as token0 and WDOGE as token1, then
///   `pool.initialize(plugin.pools(pool).sqrtStart)` by the launcher itself. tickStart is A's lower tick and tickGrad
///   A's upper tick = B's lower tick, so sqrtStart == getSqrtRatioAtTick(bottomTick of A) and
///   sqrtGrad == getSqrtRatioAtTick(topTick of A) == getSqrtRatioAtTick(bottomTick of B) (the plugin derives both
///   prices from these ticks; its mint/burn range checks and F2 rely on it).
/// - O2 Swaps: the launcher sends exactly two kinds of swap: the creator first buy inside `launch` (bonding rate, may
///   run before openAt) and the coin-fee conversion sell inside `convert`. It never swaps anywhere else.
/// - O3 Liquidity: the launcher mints A and B only inside `launch`, with itself as the recipient; its only burn with a
///   non-zero amount is the one graduation-fee burn; collects poke with zero-amount burns.
/// - O4 Fee setting: `EP.setFee(pool, 0)` while the dynamic-fee flag is off, then the plugin config
///   `MwzBarkPlugin.PLUGIN_CONFIG` (135), at launch and in `restore`, so `lastFee` is 0 and a conversion is fee-free.
interface IMwzBarkLauncher {
    /// @notice True only while the launcher's own coin-fee conversion swap on `pool` runs: the launcher sets a transient
    /// flag for `pool` inside `convert` immediately before its `pool.swap` and clears it immediately after. False at
    /// every other moment, including during the creator first buy inside `launch`.
    /// @dev Called by the plugin from `beforeSwap` (and, only if a Barkswap admin disabled the before-swap hook, from
    /// `afterSwap`), and only when the swap's sender is the launcher. MUST be a plain view with no reentrancy guard:
    /// it is called while the launcher's own guard is held (inside `launch` and `convert`). MUST NOT revert.
    function conversionInProgress(address pool) external view returns (bool);

    /// @notice The graduation-fee entry the plugin calls inline, from `afterSwap` of the swap that set `pool`'s
    /// graduation latch, after every plugin state change of that swap (last call). The pool is unlocked at that point
    /// (Algebra runs `_unlock()` before `afterSwap`), the plugin's latch is set and the pool price is at or past the
    /// graduation price, so position A holds WDOGE only.
    /// @dev The plugin calls this with a low-level call that copies no return data and ignores failure (try/catch
    /// semantics): a revert here never reverts the trade; an out-of-gas may (the 1/64 the plugin keeps may not finish
    /// the swap), which reverts the whole swap. After a failure the launcher's guarded permissionless fallback takes
    /// the fee later. The launcher MUST: take the fee at most once per pool (I6); never take it while the price is
    /// below the graduation price; when `msg.sender` is not the plugin, apply its fallback guards (pool unlocked, latch
    /// set, price at or past the graduation price). It MAY implement the fallback as this function or a separate one.
    function takeGraduationFee(address pool) external;
}
