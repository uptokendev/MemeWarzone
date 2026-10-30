// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// TEST ONLY. Makes hardhat (hardhat.gen8.config.ts) build the canonical v4-core PoolManager for local unit tests, and
// the unchanged gen-7 contracts gen-8 is wired to (GraduationOracle, CommunityRewardsVault), and the gen-7
// RewardDistributor code the fork suite deploys as the stand-in for the gen-8 holder distributor (D8).
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {GraduationOracle} from "../../GraduationOracle.sol";
import {CommunityRewardsVault} from "../../CommunityRewardsVault.sol";
import {RewardDistributor} from "../../RewardDistributor.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
