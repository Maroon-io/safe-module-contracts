// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Enum
 * @notice Collection of enums used in Safe Smart Account contracts.
 * @author @safe-global/safe-protocol
 */
library Enum {
    /**
     * @notice A Safe transaction operation.
     * @custom:variant Call The Safe transaction is executed with the `CALL` opcode.
     * @custom:variant Delegatecall The Safe transaction is executed with the `DELEGATECALL` opcode.
     */
    enum Operation {
        Call,
        DelegateCall
    }
}

interface IGnosisSafe {
    /// @dev Returns the list of owners of the Safe.
    /// @return The list of owners of the Safe.
    function getOwners() external view returns (address[] memory);

    /**
     * @notice Returns if `owner` is an owner of the Safe.
     * @return Boolean if `owner` is an owner of the Safe.
     */
    function isOwner(address owner) external view returns (bool);

    /// @dev Allows a Module to execute a Safe transaction without any further confirmations.
    /// @param to Destination address of module transaction.
    /// @param value Ether value of module transaction.
    /// @param data Data payload of module transaction.
    /// @param operation Operation type of module transaction.
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success);
}

contract SafeTimelockModule is Ownable {
    event NewDelay(uint indexed newDelay);
    event PlatformSet(address indexed platform);
    event QueueTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);
    event CancelTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);
    event ExecuteTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);

    uint public timelockDelay;
    address public platform;  // Platform EOA
    mapping (bytes32 => bool) public queuedTransactions;

    constructor(address _platform, uint256 _initialDelay) Ownable(msg.sender) {
        require(_platform != address(0), "Invalid platform address");
        platform = _platform;
        timelockDelay = _initialDelay;
        emit NewDelay(_initialDelay);
        emit PlatformSet(_platform);
    }

    modifier onlyNonPlatformOwner(address _safe) {
        address[] memory owners = IGnosisSafe(_safe).getOwners();
        bool isOwner = false;
        for (uint i = 0; i < owners.length; i++) {
            if (owners[i] == msg.sender) {
                isOwner = true;
                break;
            }
        }
        require(isOwner, "Caller not Safe owner");
        require(msg.sender != platform, "Caller is the platform");
        _;
    }

    function setTimelockDelay(uint256 _newDelay) external onlyOwner {
        timelockDelay = _newDelay;
        emit NewDelay(_newDelay);
    }

    function setPlatform(address _platform) external onlyOwner {
        platform = _platform;
        emit PlatformSet(_platform);
    }

    function queueTransaction(
        address _safe,
        address _to,
        uint256 _value,
        bytes memory _data,
        uint256 _eta
    ) external onlyNonPlatformOwner(_safe) returns (bytes32) {
        require(_eta >= getBlockTimestamp() + timelockDelay, "ETA too early");

        bytes32 txHash = keccak256(abi.encode(_safe, _to, _value, _data, _eta));
        queuedTransactions[txHash] = true;

        emit QueueTransaction(txHash, _safe, msg.sender, _to, _value, _data, _eta);
        return txHash;
    }

    function cancelTransaction(
        address _safe,
        address _to,
        uint256 _value,
        bytes memory _data,
        uint256 _eta
    ) external onlyNonPlatformOwner(_safe) {
        bytes32 txHash = keccak256(abi.encode(_safe, _to, _value, _data, _eta));
        queuedTransactions[txHash] = false;

        emit CancelTransaction(txHash, _safe, msg.sender, _to, _value, _data, _eta);
    }

    function executeTransaction(
        address _safe,
        address _to,
        uint256 _value,
        bytes memory _data,
        uint256 _eta
    ) external onlyNonPlatformOwner(_safe) returns (bool) {
        bytes32 txHash = keccak256(abi.encode(_safe, _to, _value, _data, _eta));
        require(queuedTransactions[txHash], "Transaction not queued");
        require(getBlockTimestamp() >= _eta, "ETA not reached");

        queuedTransactions[txHash] = false;

        bool success = IGnosisSafe(_safe).execTransactionFromModule(
            _to,
            _value,
            _data,
            Enum.Operation.Call
        );

        require(success, "Transaction execution failed");
        emit ExecuteTransaction(txHash, _safe, msg.sender, _to, _value, _data, _eta);
        return success;
    }

    function getPlatform() external view returns (address) {
        return platform;
    }

    function getTimelockDelay() external view returns (uint) {
        return timelockDelay;
    }

    function getBlockTimestamp() internal view returns (uint256) {
        return block.timestamp;
    }
}