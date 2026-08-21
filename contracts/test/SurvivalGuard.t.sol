// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SurvivalGuard} from "../src/SurvivalGuard.sol";
import {MockPool} from "../src/mocks/MockPool.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract SurvivalGuardTest is Test {
    MockPool pool;
    MockERC20 usdt; // 6 dec, $1
    MockERC20 weth; // 18 dec, $2000
    SurvivalGuard guard;

    address alice = makeAddr("alice");
    address keeper = makeAddr("keeper");
    address lp = makeAddr("lp");

    uint256 constant WAD = 1e18;

    function setUp() public {
        pool = new MockPool();
        usdt = new MockERC20("Tether USD", "USDT", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        pool.listReserve(address(usdt), 1e8, 8000, 7500);
        pool.listReserve(address(weth), 2000e8, 8000, 7500);
        guard = new SurvivalGuard(address(pool), address(pool));

        // liquidity
        usdt.mint(lp, 1_000_000e6);
        vm.startPrank(lp);
        usdt.approve(address(pool), type(uint256).max);
        pool.seed(address(usdt), 1_000_000e6);
        vm.stopPrank();

        // alice: 1 WETH collateral ($2000, LT 80% => $1600 borrow power), borrows 1200 USDT => HF 1.333
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(pool), type(uint256).max);
        pool.supply(address(weth), 1e18, alice, 0);
        pool.borrow(address(usdt), 1200e6, 2, 0, alice);
        // buffer: keep 500 USDT extra and approve guard
        usdt.approve(address(guard), type(uint256).max);
        vm.stopPrank();
        usdt.mint(alice, 500e6);
    }

    function _plan() internal view returns (SurvivalGuard.Plan memory p) {
        p = SurvivalGuard.Plan({
            debtAsset: address(usdt),
            triggerHF: 1.15e18,
            targetHF: 1.4e18,
            maxRepayPerProtect: 1000e6,
            cooldown: 600,
            active: false
        });
    }

    function _hf(address u) internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(u);
    }

    function test_initialHF() public view {
        assertApproxEqRel(_hf(alice), 1.3333e18, 1e15);
    }

    function test_enroll_and_disable() public {
        vm.prank(alice);
        guard.enroll(_plan());
        SurvivalGuard.Plan memory p = guard.plans(alice);
        assertTrue(p.active);
        assertEq(p.triggerHF, 1.15e18);
        vm.prank(alice);
        guard.disable();
        assertFalse(guard.plans(alice).active);
    }

    function test_enroll_rejectsBadPlans() public {
        SurvivalGuard.Plan memory p = _plan();
        p.triggerHF = 0.9e18;
        vm.prank(alice);
        vm.expectRevert();
        guard.enroll(p);
        p = _plan();
        p.targetHF = p.triggerHF;
        vm.prank(alice);
        vm.expectRevert();
        guard.enroll(p);
        p = _plan();
        p.debtAsset = address(0xBEEF);
        vm.prank(alice);
        vm.expectRevert();
        guard.enroll(p);
    }

    function test_protect_revertsAboveTrigger() public {
        vm.prank(alice);
        guard.enroll(_plan());
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(SurvivalGuard.HealthFactorAboveTrigger.selector, _hf(alice), 1.15e18)
        );
        guard.protect(alice);
    }

    function test_protect_repaysToTarget_andPaysKeeper() public {
        vm.prank(alice);
        guard.enroll(_plan());
        // ETH dips 20%: $1600 collateral => HF = 1600*0.8/1200 = 1.0667
        pool.setPrice(address(weth), 1600e8);
        uint256 hfBefore = _hf(alice);
        assertLt(hfBefore, 1.15e18);

        (bool eligible,, uint256 hf, uint256 amt) = guard.previewProtect(alice);
        assertTrue(eligible);
        assertEq(hf, hfBefore);
        // needed: debt_target = 1600*0.8/1.4 = 914.29 => repay 285.71 USDT
        assertApproxEqAbs(amt, 285_714_285, 2);

        uint256 aliceBefore = usdt.balanceOf(alice);
        vm.prank(keeper);
        uint256 repaid = guard.protect(alice);

        uint256 fee = (amt * 10) / 10_000;
        assertEq(repaid, amt - fee);
        assertEq(usdt.balanceOf(keeper), fee);
        assertEq(aliceBefore - usdt.balanceOf(alice), amt);
        assertEq(usdt.balanceOf(address(guard)), 0, "guard holds nothing");
        // HF ~ target (slightly below because fee was skimmed from the pulled amount)
        assertGt(_hf(alice), 1.38e18);
        assertLe(_hf(alice), 1.4e18 + 1e15);
        assertEq(guard.lastProtectAt(alice), block.timestamp);
    }

    function test_protect_cooldown() public {
        vm.prank(alice);
        guard.enroll(_plan());
        pool.setPrice(address(weth), 1600e8);
        vm.prank(keeper);
        guard.protect(alice);
        // another dip right away
        pool.setPrice(address(weth), 1300e8);
        vm.prank(keeper);
        vm.expectRevert();
        guard.protect(alice);
        vm.warp(block.timestamp + 601);
        vm.prank(keeper);
        guard.protect(alice);
    }

    function test_protect_cappedByMaxRepay() public {
        SurvivalGuard.Plan memory p = _plan();
        p.maxRepayPerProtect = 100e6;
        vm.prank(alice);
        guard.enroll(p);
        pool.setPrice(address(weth), 1600e8);
        vm.prank(keeper);
        uint256 repaid = guard.protect(alice);
        assertEq(repaid, 100e6 - (100e6 * 10) / 10_000);
        assertGt(_hf(alice), 1.0667e18);
        assertLt(_hf(alice), 1.4e18);
    }

    function test_protect_cappedByAllowanceAndBalance() public {
        vm.prank(alice);
        guard.enroll(_plan());
        vm.prank(alice);
        usdt.approve(address(guard), 50e6);
        pool.setPrice(address(weth), 1600e8);
        vm.prank(keeper);
        uint256 repaid = guard.protect(alice);
        assertEq(repaid, 50e6 - (50e6 * 10) / 10_000);

        // zero allowance => NothingToRepay
        vm.prank(alice);
        usdt.approve(address(guard), 0);
        vm.warp(block.timestamp + 601);
        pool.setPrice(address(weth), 1500e8);
        (bool eligible, string memory reason,,) = guard.previewProtect(alice);
        assertFalse(eligible);
        assertEq(reason, "no allowance");
        vm.prank(keeper);
        vm.expectRevert();
        guard.protect(alice);
    }

    function test_protect_revertsWhenDisabledOrPaused() public {
        vm.prank(alice);
        guard.enroll(_plan());
        pool.setPrice(address(weth), 1600e8);
        guard.setPaused(true);
        vm.prank(keeper);
        vm.expectRevert(SurvivalGuard.PausedError.selector);
        guard.protect(alice);
        guard.setPaused(false);
        vm.prank(alice);
        guard.disable();
        vm.prank(keeper);
        vm.expectRevert(SurvivalGuard.NotActive.selector);
        guard.protect(alice);
    }

    function test_ownerControls() public {
        vm.prank(alice);
        vm.expectRevert(SurvivalGuard.NotOwner.selector);
        guard.setFeeBps(20);
        vm.expectRevert(SurvivalGuard.FeeTooHigh.selector);
        guard.setFeeBps(51);
        guard.setFeeBps(0);
        assertEq(guard.feeBps(), 0);
    }

    function test_fundsOnlyFlowToRepayAndKeeper() public {
        vm.prank(alice);
        guard.enroll(_plan());
        pool.setPrice(address(weth), 1600e8);
        uint256 poolBefore = usdt.balanceOf(address(pool));
        uint256 aliceBefore = usdt.balanceOf(alice);
        vm.prank(keeper);
        guard.protect(alice);
        uint256 pulled = aliceBefore - usdt.balanceOf(alice);
        uint256 toPool = usdt.balanceOf(address(pool)) - poolBefore;
        uint256 toKeeper = usdt.balanceOf(keeper);
        assertEq(pulled, toPool + toKeeper);
        assertEq(usdt.balanceOf(address(guard)), 0);
        assertEq(usdt.balanceOf(guard.owner()), 0);
    }

    function testFuzz_protectNeverOvershootsTarget(uint256 price) public {
        price = bound(price, 1300e8, 1700e8); // HF between 0.87 and 1.13
        vm.prank(alice);
        guard.enroll(_plan());
        pool.setPrice(address(weth), price);
        vm.prank(keeper);
        guard.protect(alice);
        assertLe(_hf(alice), 1.4e18 + 1e15);
        assertGt(_hf(alice), _hfAt(price));
    }

    function _hfAt(uint256 price) internal pure returns (uint256) {
        // collateral 1 ETH * price, LT 80%, debt 1200
        return (price * 8000 * WAD) / (10_000 * 1200e8);
    }
}
