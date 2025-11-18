// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Enum} from "./lib/Enum.sol";

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
contract SafeTimelockModule is Ownable2Step {
    event NewDelay(uint indexed newDelay);
    event PlatformSet(address indexed platform);
    event QueueTransaction(
        bytes32 indexed txHash,
        address indexed safe,
        address indexed caller,
        address to,
        uint value,
        bytes data,
        uint eta,
        uint nonce
    );
    event CancelTransaction(
        bytes32 indexed txHash,
        address indexed safe,
        address indexed caller,
        address to,
        uint value,
        bytes data,
        uint eta,
        uint nonce
    );
    event ExecuteTransaction(
        bytes32 indexed txHash,
        address indexed safe,
        address indexed caller,
        address to,
        uint value,
        bytes data,
        uint eta,
        uint nonce
    );

    /// @notice Minimum value (in seconds) that the timelock delay can be set to.
    uint public immutable MIN_TIMELOCK_DELAY;

    /// @notice Maximum value (in seconds) that the timelock delay can be set to.
    uint public immutable MAX_TIMELOCK_DELAY;

    /// @notice Absolute maximum value that the timelock delay can be set to.
    uint public constant ABSOLUTE_MAX_DELAY = 30 days;

    /// @notice Current timelock delay (in seconds).
    uint public timelockDelay;

    /// @notice Grace period (in seconds) after which transactions cannot be executed.
    uint public immutable GRACE_PERIOD;

    /// @notice Platform EOA address that can be updated by Safe owner.
    address public platform;

    /// @notice Mapping of Safe addresses to their nonces.
    mapping(address => uint256) public safeNonces;

    /// @notice Mapping of queued transaction hashes to their active status.
    mapping(bytes32 => bool) public queuedTransactions;

    /**
     * @notice Initializes the timelock module with a platform address and initial delay
     * @param _platform The address of the platform EOA
     * @param _initialDelay The initial timelock delay in seconds
     * @param _minDelay The minimum allowed timelock delay in seconds
     * @param _maxDelay The maximum allowed timelock delay in seconds
     * @param _gracePeriod The grace period in seconds during which queued transactions can be executed
     */
    constructor(
        address _platform,
        uint256 _initialDelay,
        uint256 _minDelay,
        uint256 _maxDelay,
        uint256 _gracePeriod
    ) Ownable(msg.sender) {
        require(_platform != address(0), "Invalid platform address");

        require(_minDelay > 0, "Invalid min delay");
        require(_minDelay <= _maxDelay, "Min delay > max delay");

        require(
            _maxDelay <= ABSOLUTE_MAX_DELAY,
            "Max delay exceeds absolute limit"
        );

        require(
            _initialDelay >= _minDelay && _initialDelay <= _maxDelay,
            "Initial delay out of bounds"
        );

        require(_gracePeriod >= 1 days, "Grace period too short");

        platform = _platform;

        MIN_TIMELOCK_DELAY = _minDelay;
        MAX_TIMELOCK_DELAY = _maxDelay;
        timelockDelay = _initialDelay;

        GRACE_PERIOD = _gracePeriod;

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

    /// @notice Updates the timelock delay for queued transactions.
    /// @dev Emits a {NewDelay} event.
    function setTimelockDelay(uint256 _newDelay) external onlyOwner {
        require(_newDelay >= MIN_TIMELOCK_DELAY, "Delay too short");
        require(_newDelay <= MAX_TIMELOCK_DELAY, "Delay too long");

        timelockDelay = _newDelay;
        emit NewDelay(_newDelay);
    }

    /// @notice Updates the Updates the platform address.
    /// @dev Emits a {PlatformSet} event.
    function setPlatform(address _platform) external onlyOwner {
        require(_platform != address(0), "Invalid platform address");
        require(_platform != platform, "Platform already set to this address");

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

        uint256 nonce = safeNonces[_safe]++;
        bytes32 txHash = keccak256(
            abi.encode(_safe, _to, _value, _data, _eta, nonce)
        );

        queuedTransactions[txHash] = true;

        emit QueueTransaction(
            txHash,
            _safe,
            msg.sender,
            _to,
            _value,
            _data,
            _eta,
            nonce
        );
        return txHash;
    }

    /// @notice Cancels a queued transaction.
    /// @dev Emits a {CancelTransaction} event.
    function cancelTransaction(
        address _safe,
        address _to,
        uint256 _value,
        bytes memory _data,
        uint256 _eta,
        uint256 _nonce
    ) external onlyNonPlatformOwner(_safe) {
        bytes32 txHash = keccak256(
            abi.encode(_safe, _to, _value, _data, _eta, _nonce)
        );
        queuedTransactions[txHash] = false;

        emit CancelTransaction(
            txHash,
            _safe,
            msg.sender,
            _to,
            _value,
            _data,
            _eta,
            _nonce
        );
    }

    /// @notice Executes a queued transaction after the delay has passed.
    /// @dev Calls {IGnosisSafe.execTransactionFromModule}. Emits {ExecuteTransaction}.
    function executeTransaction(
        address _safe,
        address _to,
        uint256 _value,
        bytes memory _data,
        uint256 _eta,
        uint256 _nonce
    ) external onlyNonPlatformOwner(_safe) returns (bool) {
        bytes32 txHash = keccak256(
            abi.encode(_safe, _to, _value, _data, _eta, _nonce)
        );
        require(queuedTransactions[txHash], "Transaction not queued");
        require(getBlockTimestamp() >= _eta, "ETA not reached");
        require(
            getBlockTimestamp() <= _eta + GRACE_PERIOD,
            "Transaction stale"
        );

        queuedTransactions[txHash] = false;

        bool success = IGnosisSafe(_safe).execTransactionFromModule(
            _to,
            _value,
            _data,
            Enum.Operation.Call
        );

        require(success, "Transaction execution failed");
        emit ExecuteTransaction(
            txHash,
            _safe,
            msg.sender,
            _to,
            _value,
            _data,
            _eta,
            _nonce
        );
        return success;
    }

    /// @notice Returns the current platform address.
    function getPlatform() external view returns (address) {
        return platform;
    }

    /// @notice Returns the current timelock delay in seconds.
    function getTimelockDelay() external view returns (uint) {
        return timelockDelay;
    }

    /// @notice Returns the current block timestamp.
    function getBlockTimestamp() internal view returns (uint256) {
        return block.timestamp;
    }
}
