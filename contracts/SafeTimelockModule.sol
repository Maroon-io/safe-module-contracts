// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Enum } from "./lib/Enum.sol";

/**
 * @title IGnosisSafe
 * @notice Interface for interacting with a Gnosis Safe instance.
 */
interface IGnosisSafe {
    /// @notice Returns the list of owners of the Safe.
    /// @return The list of owners of the Safe.
    function getOwners() external view returns (address[] memory);

    /**
     * @notice Returns whether a given address is an owner of the Safe.
     * @param owner The address to check ownership for.
     * @return Boolean value indicating if `owner` is an owner.
     */
    function isOwner(address owner) external view returns (bool);

    /**
     * @notice Allows a Module to execute a Safe transaction without further confirmations.
     * @param to Destination address of the module transaction.
     * @param value Ether value of the module transaction.
     * @param data Data payload of the module transaction.
     * @param operation Type of operation (`Call` or `DelegateCall`).
     * @return success Boolean indicating if the execution was successful.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external returns (bool success);
}

/**
 * @title SafeTimelockModule
 * @notice Timelock module for Gnosis Safe that enforces a delay before queued transactions can be executed.
 */
contract SafeTimelockModule is Ownable {
    event NewDelay(uint indexed newDelay);
    event PlatformSet(address indexed platform);
    event QueueTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);
    event CancelTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);
    event ExecuteTransaction(bytes32 indexed txHash, address indexed safe, address indexed caller, address to, uint value, bytes data, uint eta);

    /// @notice Current timelock delay in seconds.
    uint public timelockDelay;

    /// @notice Platform EOA address that can be updated by Safe owner.
    address public platform;

    /// @notice Mapping of queued transaction hashes to their active status.
    mapping (bytes32 => bool) public queuedTransactions;

    /**
     * @notice Initializes the timelock module with a platform address and initial delay.
     * @param _platform The address of the platform EOA.
     * @param _initialDelay The initial timelock delay in seconds.
     */
    constructor(address _platform, uint256 _initialDelay) Ownable(msg.sender) {
        require(_platform != address(0), "Invalid platform address");
        platform = _platform;
        timelockDelay = _initialDelay;
        emit NewDelay(_initialDelay);
        emit PlatformSet(_platform);
    }

    /**
     * @notice Modifier that ensures the caller is an owner of the Safe but not the platform address.
     * @param _safe Address of the Gnosis Safe being interacted with.
     */
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

    /// @notice Queues a transaction that can be executed after the timelock delay.
    /// @dev Emits a {QueueTransaction} event.
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

    /// @notice Cancels a previously queued transaction.
    /// @dev Emits a {CancelTransaction} event.
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

    /// @notice Executes a queued transaction after the delay has passed.
    /// @dev Calls {IGnosisSafe.execTransactionFromModule}. Emits {ExecuteTransaction}.
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