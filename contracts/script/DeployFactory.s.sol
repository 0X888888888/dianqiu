// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {PenaltyShootoutVaultFactory} from "../src/PenaltyShootoutVaultFactory.sol";

/// @notice 部署工厂合约
/// @dev    使用方式：
///   forge script script/DeployFactory.s.sol:DeployFactory \
///     --rpc-url $RPC_URL \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract DeployFactory is Script {
    function run() external returns (PenaltyShootoutVaultFactory factory) {
        vm.startBroadcast();
        factory = new PenaltyShootoutVaultFactory();
        vm.stopBroadcast();

        console2.log("PenaltyShootoutVaultFactory deployed at:", address(factory));
        console2.log("Version:", factory.VERSION());
    }
}
