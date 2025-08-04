// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

import { Enum, Module } from "@gnosis-guild/zodiac-core/contracts/core/Module.sol";
import { SafeMath } from "./SafeMath.sol";

interface IGnosisSafe {
    function getOwners() external view returns (address[] memory);
}

interface ISafeTimelockModuleFactory {
    function getTimelockDelay() external view returns (uint256);
}

contract SafeTimelockModule is Module {
    using SafeMath for uint;

    event SafeTimelockModuleSetup(address indexed owner, address indexed avatar, address indexed target, uint256 initialDelay);
    event NewDelay(uint indexed newDelay);
    event CancelTransaction(bytes32 indexed txHash, address indexed target, uint value, string signature, bytes data, uint eta, address avatar);
    event ExecuteTransaction(bytes32 indexed txHash, address indexed target, uint value, string signature, bytes data, uint eta, address avatar);
    event QueueTransaction(bytes32 indexed txHash, address indexed target, uint value, string signature, bytes data, uint eta, address avatar);

    uint public timelockDelay;

    address public factory;

    mapping (bytes32 => bool) public queuedTransactions;

    constructor(
        address _owner,
        address _avatar,
        address _target,
        uint256 _initialDelay,
        address _factory
    ) {
        bytes memory initParams = abi.encode(
            _owner,
            _avatar,
            _target
        );
        setUp(initParams);

        factory = _factory;
        timelockDelay = _initialDelay;
        emit SafeTimelockModuleSetup(_owner, _avatar, _target, _initialDelay);
    }

    function setUp(bytes memory initParams) public override {
        (
            address _owner,
            address _newAvatar,
            address _newTarget
        ) = abi.decode(
                initParams,
                (address, address, address)
            );
        
        _transferOwnership(_owner);

        require(_newAvatar != address(0), "SafeTimelockModule::setUp: Avatar cannot be zero address");
        avatar = _newAvatar;
        target = _newTarget; 
    }

    modifier onlySafeOwner() {
        require(avatar != address(0), "SafeTimelockModule: Avatar not set");
        IGnosisSafe safe = IGnosisSafe(avatar);
        address[] memory owners = safe.getOwners();
        bool isOwner = false;
        for (uint i = 0; i < owners.length; i++) {
            if (owners[i] == msg.sender) {
                isOwner = true;
                break;
            }
        }
        require(isOwner, "SafeTimelockModule: Caller is not a Safe owner");
        _;
    }

    function setTimelockDelay(uint256 _newDelay) public {
        require(msg.sender == avatar, "SafeTimelockModule::setTimelockDelay: Call must come from avatar (Safe).");
        timelockDelay = _newDelay;
        emit NewDelay(timelockDelay);
    }

    function queueTransaction(address _target, uint256 _value, string memory _signature, bytes memory _data, uint256 _eta) public onlySafeOwner returns (bytes32) {
        require(_eta >= getBlockTimestamp().add(timelockDelay), "SafeTimelockModule::queueTransaction: ETA too early.");

        bytes32 txHash = keccak256(abi.encode(_target, _value, _signature, _data, _eta));
        queuedTransactions[txHash] = true;

        emit QueueTransaction(txHash, _target, _value, _signature, _data, _eta, avatar);
        return txHash;
    }

    function cancelTransaction(address _target, uint256 _value, string memory _signature, bytes memory _data, uint256 _eta) public onlySafeOwner {
        bytes32 txHash = keccak256(abi.encode(_target, _value, _signature, _data, _eta));
        queuedTransactions[txHash] = false;

        emit CancelTransaction(txHash, _target, _value, _signature, _data, _eta, avatar);
    }

    function executeTransaction(address _target, uint256 _value, string memory _signature, bytes memory _data, uint256 _eta) public onlySafeOwner returns (bool) {
        bytes32 txHash = keccak256(abi.encode(_target, _value, _signature, _data, _eta));
        require(queuedTransactions[txHash], "SafeTimelockModule::executeTransaction: Transaction not queued.");
        require(getBlockTimestamp() >= _eta, "SafeTimelockModule::executeTransaction: ETA not reached.");

        queuedTransactions[txHash] = false;

        bytes memory callDataPayload;
        callDataPayload = _data;

        Enum.Operation operation = Enum.Operation.Call;

        bool success = exec(_target, _value, callDataPayload, operation);
        
        require(success, "SafeTimelockModule::executeTransaction: Transaction execution reverted.");

        emit ExecuteTransaction(txHash, _target, _value, _signature, _data, _eta, avatar);
        return success;
    }
    
    function getBlockTimestamp() internal view returns (uint) {
        return block.timestamp;
    }
} 