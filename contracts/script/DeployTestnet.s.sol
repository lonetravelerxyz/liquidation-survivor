// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SurvivalGuard} from "../src/SurvivalGuard.sol";
import {MockPool} from "../src/mocks/MockPool.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice X Layer testnet (1952): Aave is not deployed there, so deploy MockPool + mock reserves + guard.
///         Reserve set mirrors mainnet Aave on X Layer: USDT (6), xETH (18), WOKB (18), xBTC (8).
contract DeployTestnet is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        MockPool pool = new MockPool();
        MockERC20 usdt = new MockERC20("Tether USD (mock)", "USDT", 6);
        MockERC20 xeth = new MockERC20("X Layer ETH (mock)", "xETH", 18);
        MockERC20 wokb = new MockERC20("Wrapped OKB (mock)", "WOKB", 18);
        MockERC20 xbtc = new MockERC20("X Layer BTC (mock)", "xBTC", 8);

        pool.listReserve(address(usdt), 1e8, 7800, 7500);
        pool.listReserve(address(xeth), 1900e8, 8000, 7500);
        pool.listReserve(address(wokb), 120e8, 6500, 6000);
        pool.listReserve(address(xbtc), 115_000e8, 7800, 7300);

        SurvivalGuard guard = new SurvivalGuard(address(pool), address(pool));

        // seed USDT liquidity so demo borrows can be served
        usdt.mint(vm.addr(pk), 10_000_000e6);
        usdt.approve(address(pool), type(uint256).max);
        pool.seed(address(usdt), 5_000_000e6);

        vm.stopBroadcast();

        console.log("POOL_ADDRESS_TESTNET=%s", address(pool));
        console.log("GUARD_ADDRESS_TESTNET=%s", address(guard));
        console.log("USDT=%s", address(usdt));
        console.log("xETH=%s", address(xeth));
        console.log("WOKB=%s", address(wokb));
        console.log("xBTC=%s", address(xbtc));
    }
}
