// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.8.0;

import {Enum, Module} from "@gnosis-guild/zodiac-core/contracts/core/Module.sol";

interface IGnosisSafe {
    function getOwners() external view returns (address[] memory);
}

contract DirectModule is Module {
    event DirectModuleSetup(
        address indexed owner,
        address indexed avatar,
        address indexed target
    );
    event TransactionExecuted(
        address to,
        uint256 value,
        bytes data,
        Enum.Operation operation
    );

    constructor(
        address _owner,
        address _avatar,
        address _target
    ) {
        bytes memory initParams = abi.encode(
            _owner,
            _avatar,
            _target
        );
        setUp(initParams);
    }

    function setUp(bytes memory initParams) public override {
        (
            address _owner,
            address _avatar,
            address _target
        ) = abi.decode(
                initParams,
                (address, address, address)
            );
        require(_avatar != address(0), "Avatar can not be zero address");
        require(_target != address(0), "Target can not be zero address");

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;

        emit DirectModuleSetup(_owner, _avatar, _target);
    }

    modifier onlySafeOwner() {
        require(avatar != address(0), "DirectModule: Avatar not set");
        IGnosisSafe safe = IGnosisSafe(avatar);
        address[] memory owners = safe.getOwners();
        bool isOwner = false;
        for (uint i = 0; i < owners.length; i++) {
            if (owners[i] == msg.sender) {
                isOwner = true;
                break;
            }
        }
        require(isOwner, "DirectModule: Caller is not a Safe owner");
        _;
    }
    function executeTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) public onlySafeOwner returns (bool success) {
        success = exec(to, value, data, operation);
        if (success) {
            emit TransactionExecuted(to, value, data, operation);
        }
        return success;
    }
} 