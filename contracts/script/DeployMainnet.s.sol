// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SurvivalGuard} from "../src/SurvivalGuard.sol";

/// @notice X Layer mainnet (196): real Aave V3 Pool + AaveOracle.
contract DeployMainnet is Script {
    address constant AAVE_POOL = 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116;
    address constant AAVE_ORACLE = 0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        SurvivalGuard guard = new SurvivalGuard(AAVE_POOL, AAVE_ORACLE);
        vm.stopBroadcast();
        console.log("GUARD_ADDRESS_MAINNET=%s", address(guard));
    }
}
