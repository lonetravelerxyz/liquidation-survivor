// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {SurvivalGuard} from "../../src/SurvivalGuard.sol";
import {IPool, IAaveOracle} from "../../src/interfaces/IAaveV3.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

interface IPoolExt is IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;
}

/// @notice Runs only with a fork: `XLAYER_RPC_URL=https://rpc.xlayer.tech forge test --match-path 'test/fork/*' --fork-url $XLAYER_RPC_URL`
///         Stages a real Aave V3 X Layer position (xETH collateral, USDT debt), mocks the oracle price lower,
///         and asserts SurvivalGuard repays the user's own debt and lifts HF.
contract AaveXLayerForkTest is Test {
    address constant POOL = 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116;
    address constant ORACLE = 0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6;
    address constant USDT = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address constant XETH = 0xE7B000003A45145decf8a28FC755aD5eC5EA025A;

    SurvivalGuard guard;
    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");

    function setUp() public {
        guard = new SurvivalGuard(POOL, ORACLE);
    }

    function _hf(address u) internal view returns (uint256 hf) {
        (,,,,, hf) = IPool(POOL).getUserAccountData(u);
    }

    function test_fork_protectOnRealAave() public {
        // 1) give alice 1 xETH + USDT buffer via storage cheat
        deal(XETH, alice, 1e18);
        deal(USDT, alice, 2_000e6);
        vm.startPrank(alice);
        IERC20(XETH).approve(POOL, type(uint256).max);
        IPoolExt(POOL).supply(XETH, 1e18, alice, 0);
        uint256 ethPrice = IAaveOracle(ORACLE).getAssetPrice(XETH); // 8 dec
        (,,,, uint256 ltv,) = IPool(POOL).getUserAccountData(alice);
        // borrow ~95% of LTV-allowed USDT
        uint256 borrowUsd = (ethPrice * ltv * 95) / (10_000 * 100); // 8-dec USD
        uint256 borrowAmt = borrowUsd / 1e2; // USDT 6 dec
        IPoolExt(POOL).borrow(USDT, borrowAmt, 2, 0, alice);
        IERC20(USDT).approve(address(guard), type(uint256).max);
        (, uint256 debtBase,,,,) = IPool(POOL).getUserAccountData(alice);
        assertGt(debtBase, 0);
        (,,, uint256 lt,,) = IPool(POOL).getUserAccountData(alice);
        console.log("lt", lt, "ltv", ltv);
        console.log("HF after borrow", _hf(alice));
        guard.enroll(
            SurvivalGuard.Plan({
                debtAsset: USDT,
                triggerHF: 1.1e18,
                targetHF: 1.3e18,
                maxRepayPerProtect: 1_000e6,
                cooldown: 0,
                active: false
            })
        );
        vm.stopPrank();

        // 2) not eligible yet
        (bool eligible,,,) = guard.previewProtect(alice);
        assertFalse(eligible);

        // 3) mock the oracle: ETH -20%
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, XETH),
            abi.encode((ethPrice * 80) / 100)
        );
        uint256 hfBefore = _hf(alice);
        console.log("HF after dip", hfBefore);
        assertLt(hfBefore, 1.1e18);
        (eligible,,,) = guard.previewProtect(alice);
        assertTrue(eligible);

        // 4) protect
        uint256 keeperBefore = IERC20(USDT).balanceOf(keeper);
        vm.prank(keeper);
        uint256 repaid = guard.protect(alice);
        uint256 hfAfter = _hf(alice);
        console.log("repaid", repaid, "HF after protect", hfAfter);
        assertGt(hfAfter, hfBefore);
        assertGt(IERC20(USDT).balanceOf(keeper), keeperBefore);
        assertEq(IERC20(USDT).balanceOf(address(guard)), 0);
        assertApproxEqRel(hfAfter, 1.3e18, 2e16); // within 2% of target
    }
}
