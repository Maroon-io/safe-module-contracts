// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

import {SafeTimelockModule} from "./SafeTimelockModule.sol";

interface IGnosisSafe {
    function getOwners() external view returns (address[] memory);
}

contract FactorySafeTimeModule {
    address public admin;
    address public pendingAdmin;
    uint public delay;

    event SafeTimelockModuleCreated(
        address owner,
        address indexed avatar,
        address indexed target,
        uint256 initialDelay,
        address indexed module_Address
    );

    mapping(address => address) public safeTimelockModules;

    address[] public safeTimelockModuleAddresses;

    constructor(address _admin, uint256 _delay) {
        admin = _admin;
        pendingAdmin = _admin;
        delay = _delay;
    }

    function setPendingAdmin(address _pendingAdmin) public {
        require(msg.sender == admin, "FactorySafeTimeModule: Only admin can set pending admin");
        pendingAdmin = _pendingAdmin;
    }

    function setDelay(uint256 _delay) public {
        require(msg.sender == admin, "FactorySafeTimeModule: Only admin can set delay");
        delay = _delay;
    }

    function acceptAdmin() public {
        require(msg.sender == pendingAdmin, "FactorySafeTimeModule: Only pending admin can accept admin");
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function createSafeTimelockModule(address _avatar, address _target, uint256 _initialDelay)
        public
        returns (address)
    {
        SafeTimelockModule timelock = new SafeTimelockModule(msg.sender, _avatar, _target, _initialDelay, address(this));
        safeTimelockModuleAddresses.push(address(timelock));
        emit SafeTimelockModuleCreated(msg.sender, _avatar, _target, _initialDelay, address(timelock));
        return address(timelock);
    }

    function getSafeTimelockModuleAddresses() public view returns (address[] memory) {
        return safeTimelockModuleAddresses;
    }
}
