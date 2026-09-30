// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { IPoolManager } from "@v4-core/interfaces/IPoolManager.sol";
import { PoolKey } from "@v4-core/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@v4-core/types/PoolId.sol";
import { StateLibrary } from "@v4-core/libraries/StateLibrary.sol";
import { Currency } from "@v4-core/types/Currency.sol";
import "../src/DopplerRobinhood.sol";
import { Swapper } from "../src/Swapper.sol";

interface IOwned {
    function owner() external view returns (address);
}

interface ITopUp {
    function canPullUp(address) external view returns (bool);
    function setPullUp(address migrator, bool canPull) external;
}

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/**
 * Option B of the Robinhood launch type (founder, 2026-09-30): a Doppler multicurve coin that trades
 * from block one with our fee hook (50% falling to 2% over 60 s, every fee to our collector), then
 * graduates at a fixed amount raised: 22% of the raise to our splitter, the rest plus the unsold tail
 * into a 0.25% Uniswap v4 pool locked for good, LP fees creator 80 / us 15 / Whetstone 5.
 *
 * Runs against the Doppler contracts deployed on Robinhood Chain through a fork. Nothing is sent.
 *   forge test --fork-url https://rpc.mainnet.chain.robinhood.com -vv
 */
contract RobinhoodGraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IAirlock airlock = IAirlock(RH.AIRLOCK);
    IDopplerHookInitializer initializer = IDopplerHookInitializer(RH.INITIALIZER);
    IRehype rehype = IRehype(RH.REHYPE);
    IPoolManager manager = IPoolManager(RH.POOL_MANAGER);
    Swapper swapper;

    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address collector = makeAddr("mwzCollector"); // fee beneficiary + our 15% LP share
    address splitter = makeAddr("mwzGraduationSplitter"); // receives the 22% of the raise

    uint24 constant START_FEE = 500_000; // 50% (1e6 = 100%)
    uint24 constant END_FEE = 20_000; // 2%
    uint32 constant DECAY_SECONDS = 60;
    uint256 constant PROCEEDS_SHARE = 0.22e18;
    uint24 constant GRADUATED_FEE = 2500; // 0.25%

    function setUp() public {
        require(block.chainid == 4663, "run on a Robinhood Chain fork");
        swapper = new Swapper(RH.POOL_MANAGER);
        vm.deal(trader, 1_000 ether);
    }

    function _sorted(BeneficiaryData[] memory b) internal pure returns (BeneficiaryData[] memory) {
        for (uint256 i = 0; i < b.length; i++) {
            for (uint256 j = i + 1; j < b.length; j++) {
                if (b[j].beneficiary < b[i].beneficiary) (b[i], b[j]) = (b[j], b[i]);
            }
        }
        return b;
    }

    function _create() internal returns (address asset, PoolKey memory key, int24 farTick) {
        Curve[] memory curves = new Curve[](1);
        // One curve; the part between the far tick and its top end is the unsold tail that seeds the
        // graduated pool.
        curves[0] = Curve({ tickLower: -210_000, tickUpper: -150_000, numPositions: 10, shares: 1e18 });

        BeneficiaryData[] memory feeBeneficiaries = new BeneficiaryData[](1);
        feeBeneficiaries[0] = BeneficiaryData({ beneficiary: collector, shares: 1e18 });
        bytes memory rehypeData = abi.encode(
            RehypeInitData({
                numeraire: address(0),
                buybackDst: collector,
                startFee: START_FEE,
                endFee: END_FEE,
                durationSeconds: DECAY_SECONDS,
                startingTime: 0,
                feeRoutingMode: FeeRoutingMode.RouteToBeneficiaryFees,
                // Token-side fees are sold for ETH in the pool; ETH-side fees are kept: every fee
                // reaches us in ETH, like SOL on the Solana curve.
                feeDistributionInfo: FeeDistributionInfo({
                    assetFeesToAssetBuybackWad: 0,
                    assetFeesToNumeraireBuybackWad: 1e18,
                    assetFeesToBeneficiaryWad: 0,
                    assetFeesToLpWad: 0,
                    numeraireFeesToAssetBuybackWad: 0,
                    numeraireFeesToNumeraireBuybackWad: 0,
                    numeraireFeesToBeneficiaryWad: 1e18,
                    numeraireFeesToLpWad: 0
                }),
                feeBeneficiaries: feeBeneficiaries
            })
        );
        bytes memory initData = abi.encode(
            InitData({
                fee: 0,
                tickSpacing: 8,
                farTick: -180_000,
                curves: curves,
                beneficiaries: new BeneficiaryData[](0), // empty = migratable (not locked)
                dopplerHook: RH.REHYPE,
                onInitializationDopplerHookCalldata: rehypeData,
                graduationDopplerHookCalldata: ""
            })
        );

        // The migrator requires the Airlock owner at >= 5% and the locker requires its own owner at
        // >= 5%; they are different addresses on Robinhood, so Whetstone takes 10% of LP fees.
        BeneficiaryData[] memory lp = new BeneficiaryData[](4);
        lp[0] = BeneficiaryData({ beneficiary: creator, shares: 0.75e18 });
        lp[1] = BeneficiaryData({ beneficiary: collector, shares: 0.15e18 });
        lp[2] = BeneficiaryData({ beneficiary: airlock.owner(), shares: 0.05e18 });
        lp[3] = BeneficiaryData({ beneficiary: IOwned(RH.LOCKER).owner(), shares: 0.05e18 });
        bytes memory migratorData = abi.encode(
            GRADUATED_FEE, false, int24(50), uint32(365 days), _sorted(lp), address(0), bytes(""), splitRecipient,
            splitRecipient == address(0) ? 0 : PROCEEDS_SHARE
        );

        bytes memory tokenData = abi.encode(
            "MWZ Rehearsal", "MWZR", new VestingSchedule[](0), new address[](0), new uint256[](0), new uint256[](0),
            "", uint256(0), uint48(0), address(0), new address[](0)
        );

        vm.prank(creator);
        (asset,,,,) = airlock.create(
            CreateParams({
                initialSupply: 1e27,
                numTokensToSell: 1e27,
                numeraire: address(0),
                tokenFactory: RH.TOKEN_FACTORY,
                tokenFactoryData: tokenData,
                governanceFactory: RH.NO_OP_GOVERNANCE,
                governanceFactoryData: "",
                poolInitializer: RH.INITIALIZER,
                poolInitializerData: initData,
                liquidityMigrator: RH.MIGRATOR,
                liquidityMigratorData: migratorData,
                integrator: collector,
                salt: keccak256(abi.encode("mwz-rehearsal", block.timestamp))
            })
        );
        PoolStatus status;
        (,,,, status, key, farTick) = initializer.getState(asset);
        assertEq(uint8(status), uint8(PoolStatus.Initialized), "curve is migratable");
        assertEq(address(key.hooks), RH.INITIALIZER);
    }

    /// Gross fee rate of one swap from the airlock owner's 5% cut, in 1e6 units.
    function _buy(PoolKey memory key, uint256 ethIn) internal returns (uint256 tokensOut, uint256 feeRatePpm) {
        (,,,, uint128 own0Before, uint128 own1Before,) = rehype.getHookFees(PoolId.unwrap(key.toId()));
        vm.prank(trader);
        tokensOut = swapper.swapExactIn{ value: ethIn }(key, true, ethIn);
        if (PoolId.unwrap(key.toId()) == PoolId.unwrap(curveKey.toId())) netEthIntoCurve += ethIn;
        (,,,, uint128 own0After, uint128 own1After,) = rehype.getHookFees(PoolId.unwrap(key.toId()));
        // exact-ETH-in buy: the fee is taken in the token (currency1)
        uint256 grossTokenFee = uint256(own1After - own1Before) * 20;
        own0After; own0Before;
        feeRatePpm = grossTokenFee * 1e6 / (tokensOut + grossTokenFee);
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }

    // Shared between the phases (one function would not fit the stack).
    address asset;
    PoolKey curveKey;
    PoolKey gradKey;
    int24 farTickStored;
    uint256 toSplitterStored;
    uint256 netEthIntoCurve; // ETH traders put into the curve minus ETH they took out
    address splitRecipient; // set per test: our splitter, or zero for no proceeds split
    address constant TOP_UP_DISTRIBUTOR = 0x46adee7595d48b1Ec53090e9bc78e1E69Fa0eF06; // DHM.TOP_UP_DISTRIBUTOR()

    function _launchAndTrade() internal {
        int24 farTick;
        (asset, curveKey, farTick) = _create();
        farTickStored = farTick;
        console2.log("asset", asset);
        console2.log("start tick", _tick(curveKey));
        console2.log("far tick", farTick);
        _phaseLaunchFees();
        _phaseSell();
        _buyToFarTick();
    }

    /// As deployed today: the migrator is not allowed to pull from its TopUpDistributor, and it calls
    /// it whenever a proceeds split is configured, so a graduation that pays us 22% reverts.
    function test_B_today_graduationWithSplitReverts() public {
        assertFalse(ITopUp(TOP_UP_DISTRIBUTOR).canPullUp(RH.MIGRATOR), "migrator not allowed to pull up");
        splitRecipient = splitter;
        _launchAndTrade();
        vm.expectRevert(bytes4(keccak256("SenderCannotPullUp()")));
        airlock.migrate(asset);
    }

    /// Whetstone's owner Safe calls setPullUp(migrator, true) once; then the whole of option B holds.
    function test_B_afterWhetstoneEnablesPullUp_fullFlow() public {
        vm.prank(airlock.owner());
        ITopUp(TOP_UP_DISTRIBUTOR).setPullUp(RH.MIGRATOR, true);
        splitRecipient = splitter;
        _launchAndTrade();
        _phaseGraduate();
        _phaseLockAndLpFees();
    }

    /// Without a proceeds split, graduation works today; the 22% would have to be taken another way.
    function test_B_noSplit_graduatesToday() public {
        splitRecipient = address(0);
        _launchAndTrade();
        _phaseGraduate();
        _phaseLockAndLpFees();
    }

    function _phaseLaunchFees() internal {
        (uint256 out0, uint256 rate0) = _buy(curveKey, 0.01 ether);
        console2.log("buy at t+0: tokens", out0, "fee ppm", rate0);
        assertApproxEqAbs(rate0, START_FEE, 20_000, "launch fee ~50%");

        vm.warp(block.timestamp + 30);
        (, uint256 rateMid) = _buy(curveKey, 0.01 ether);
        console2.log("buy at t+30s: fee ppm", rateMid);
        assertApproxEqAbs(rateMid, (START_FEE + END_FEE) / 2, 20_000, "fee halfway down at 30 s");

        vm.warp(block.timestamp + 31);
        (uint256 out1, uint256 rate1) = _buy(curveKey, 0.5 ether);
        console2.log("buy after 60 s: tokens", out1, "fee ppm", rate1);
        assertApproxEqAbs(rate1, END_FEE, 500, "2% after the window");
    }

    /// Sell a quarter back: exact-token-in, the fee is taken in ETH.
    function _phaseSell() internal {
        bytes32 id = PoolId.unwrap(curveKey.toId());
        uint256 sellAmount = IERC20View(asset).balanceOf(trader) / 4;
        (,,,, uint128 own0Before,,) = rehype.getHookFees(id);
        vm.startPrank(trader);
        IERC20View(asset).approve(address(swapper), sellAmount);
        uint256 ethOut = swapper.swapExactIn(curveKey, false, sellAmount);
        netEthIntoCurve -= ethOut;
        vm.stopPrank();
        (,,,, uint128 own0After,,) = rehype.getHookFees(id);
        uint256 grossEthFee = uint256(own0After - own0Before) * 20;
        uint256 sellRate = grossEthFee * 1e6 / (ethOut + grossEthFee);
        console2.log("sell: eth out", ethOut, "fee ppm", sellRate);
        assertApproxEqAbs(sellRate, END_FEE, 500, "2% on sells, taken in ETH");
    }

    /// Buy until the curve reaches the far tick; migrate is refused until then.
    /// ETH is currency0 and the asset currency1, so buying lowers the tick toward the far tick.
    function _buyToFarTick() internal {
        uint256 spent;
        for (uint256 rounds = 0; rounds < 400 && _tick(curveKey) > farTickStored; rounds++) {
            _buy(curveKey, 0.05 ether);
            spent += 0.05 ether;
        }
        console2.log("eth spent reaching the far tick (after the first 0.52)", spent);
        console2.log("tick", _tick(curveKey));
    }

    function _phaseGraduate() internal {
        uint256 splitterBefore = splitter.balance;
        uint256 pmBefore = RH.POOL_MANAGER.balance;
        airlock.migrate(asset);
        uint256 toSplitter = splitter.balance - splitterBefore;
        toSplitterStored = toSplitter;
        console2.log("to splitter", toSplitter);
        console2.log("pool manager ETH delta at migrate (curve out, pool in, split out)", pmBefore - RH.POOL_MANAGER.balance);
        if (splitRecipient != address(0)) assertGt(toSplitter, 0, "splitter paid");

        (, gradKey,,,,,,) = IDopplerHookMigrator(RH.MIGRATOR).getAssetData(address(0), asset);
        assertEq(gradKey.fee, GRADUATED_FEE, "graduated pool charges 0.25%");
        console2.log("graduated pool manager ETH (all pools)", RH.POOL_MANAGER.balance);

        // Our fees survive graduation: collect them after migrate.
        uint256 before = collector.balance;
        vm.prank(collector);
        rehype.collectFees(asset);
        uint256 fees = collector.balance - before;
        console2.log("collector curve fees claimed after graduation", fees);
        assertGt(fees, 0, "fees claimable after graduation");
        // What the curve held at graduation is what traders left in it minus the fees the hook kept.
        if (splitRecipient != address(0)) {
            uint256 raised = netEthIntoCurve - fees;
            console2.log("raised at graduation", raised);
            assertApproxEqRel(toSplitterStored, raised * 22 / 100, 0.002e18, "splitter got 22% of the raise");
        }
    }

    function _phaseLockAndLpFees() internal {
        bytes32 gradId = PoolId.unwrap(gradKey.toId());
        (PoolKey memory streamKey, address recipient,, uint32 lockDuration, bool isUnlocked) =
            IStreamableFeesLocker(RH.LOCKER).streams(gradId);
        console2.log("lock duration", lockDuration);
        assertEq(recipient, RH.DEAD, "LP recipient is 0xdead: locked for good");
        assertFalse(isUnlocked);
        assertEq(address(streamKey.hooks), RH.MIGRATOR);

        vm.warp(block.timestamp + 1 days);
        vm.prank(trader);
        swapper.swapExactIn{ value: 2 ether }(gradKey, true, 2 ether);
        uint256 half = IERC20View(asset).balanceOf(trader) / 2;
        vm.startPrank(trader);
        IERC20View(asset).approve(address(swapper), half);
        swapper.swapExactIn(gradKey, false, half);
        vm.stopPrank();

        uint256 c0 = creator.balance;
        uint256 u0 = collector.balance;
        vm.prank(creator);
        IStreamableFeesLocker(RH.LOCKER).collectFees(gradId);
        vm.prank(collector);
        IStreamableFeesLocker(RH.LOCKER).collectFees(gradId);
        uint256 creatorEth = creator.balance - c0;
        uint256 usEth = collector.balance - u0;
        console2.log("LP fees ETH: creator", creatorEth);
        console2.log("LP fees ETH: us", usEth);
        assertGt(creatorEth, 0);
        assertApproxEqRel(creatorEth * 15, usEth * 75, 0.001e18, "75/15 between creator and us");

        vm.warp(block.timestamp + 3650 days);
        (, recipient,,, isUnlocked) = IStreamableFeesLocker(RH.LOCKER).streams(gradId);
        assertEq(recipient, RH.DEAD);
        assertFalse(isUnlocked);
    }
}
