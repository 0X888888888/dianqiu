// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// Re-export the regular IAccessControl so that FLAP's IPortal.sol
// (which imports the upgradeable variant) can compile in this project.
import {IAccessControl as IAccessControlUpgradeable} from "@openzeppelin/contracts/access/IAccessControl.sol";
