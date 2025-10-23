// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.10;

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