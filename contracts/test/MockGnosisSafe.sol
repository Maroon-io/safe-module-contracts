// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

import { Enum } from "../lib/Enum.sol";

/**
 * @title MockGnosisSafe
 * @notice Mock implementation for testing SafeTimelockModule
 */
contract MockGnosisSafe {
    address[] private owners;
    bool private executionResult = true;

    constructor(address[] memory _owners) {
        owners = _owners;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function isOwner(address owner) external view returns (bool) {
        for (uint i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                return true;
            }
        }
        return false;
    }

    function execTransactionFromModule(
        address,
        uint256,
        bytes calldata,
        Enum.Operation
    ) external view returns (bool) {
        return executionResult;
    }

    function setExecutionResult(bool _result) external {
        executionResult = _result;
    }
}