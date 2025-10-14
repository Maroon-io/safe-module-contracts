const { ethers, network } = require("hardhat");
const fs = require("fs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Command line arguments for operation mode
const args = process.argv.slice(2);
const operation = args[0] || "execute"; // Default to queue if no operation specified
// Valid operations: queue, cancel, execute

// Load timelock module address from file
let MODULE_INFO;
try {
  MODULE_INFO = JSON.parse(fs.readFileSync("module-deployment.json"));
  console.log("Loaded addresses from module-deployment.json");
} catch (error) {
  console.warn("Could not load module-deployment.json. Please make sure to run 02-deploy-timelock-module.ts first");
  console.warn("Using default placeholder addresses - modify these with your actual addresses");
  MODULE_INFO = {
    timelockModuleAddress: "0xAcD3d2442299DfF4d1a449dfcFa6dAE551DE150F",
    safeAddress: "0xb345A5eC60EE45eBac20849f7043f1141A8810B7",
    initialDelay: 60 * 3 // 3 minutes
  };
}

// Transaction configuration for queuing
// const TARGET_ADDRESS = MODULE_INFO.safeAddress; // Target the Safe by default
const TARGET_ADDRESS = '0x94Fc2245d6699BbfA71B4698e40a0b76AcD582D8';
const VALUE_ETH = "0";

// Example transaction: Calling changeThreshold on a Gnosis Safe
// const FUNCTION_SIGNATURE = "changeThreshold(uint256)";
// const FUNCTION_ARGS = [2]; // Change threshold to 2

// Example transaction: Calling transfer on a Gnosis Safe
const FUNCTION_SIGNATURE = "transfer(address,uint256)";
const FUNCTION_ARGS = ['0xe37fa5978b4C776B7d314d9B4a384ef342F97a23', ethers.parseUnits('0.01', 18)]; // Change threshold to 2

const ETA_BUFFER_SECONDS = 60; // Add extra buffer time beyond minimum delay

// Store transaction info for cancellation/execution
let queuedTx = {
  txHash: "",
  target: "",
  value: 0,
  signature: "",
  data: "",
  eta: 0,
  queuedAt: "",
  executesAfter: "",
  tx: ""
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);

  const timelockModule = await ethers.getContractAt(
    "SafeTimelockModule",
    MODULE_INFO.timelockModuleAddress
  );

  // Check that signer is a Safe owner
  const isSafeOwner = await checkIsSafeOwner(signer.address, MODULE_INFO.safeAddress);
  if (!isSafeOwner) {
    console.error("ERROR: Signer is not a Safe owner. Only Safe owners can interact with the TimelockModule.");
    process.exit(1);
  }

  switch (operation.toLowerCase()) {
    case "queue":
      await queueTransaction(timelockModule, signer);
      break;
    case "cancel":
      await cancelTransaction(timelockModule, signer);
      break;
    case "execute":
      await executeTransaction(timelockModule, signer);
      break;
    default:
      console.error(`Invalid operation: ${operation}. Valid operations are: queue, cancel, execute`);
      process.exit(1);
  }
}

async function checkIsSafeOwner(signerAddress, safeAddress) {
  const safe = await ethers.getContractAt("contracts/SafeTimelockModule.sol:IGnosisSafe", safeAddress);
  try {
    return await safe.isOwner(signerAddress);
  } catch (error) {
    console.warn("Error checking Safe ownership, will proceed anyway:", error.message);
    return true; // Assume it's an owner if we can't check
  }
}

async function queueTransaction(timelockModule, signer) {
  console.log("\n=== Queueing Transaction ===");
  
  // 1. Get timelock delay from the module
  const timelockDelay = await timelockModule.timelockDelay();
  console.log("Current timelock delay:", timelockDelay.toString(), "seconds");

  // 2. Calculate ETA
  let currentTimestampSeconds;
  if (network.name === "hardhat" || network.name === "localhost") {
    currentTimestampSeconds = BigInt(await time.latest());
  } else {
    const latestBlock = await ethers.provider.getBlock('latest');
    if (!latestBlock) {
      throw new Error("Could not fetch the latest block from the provider.");
    }
    currentTimestampSeconds = BigInt(latestBlock.timestamp);
  }
  console.log("Current block timestamp (seconds):", currentTimestampSeconds.toString());
  
  const eta = currentTimestampSeconds + timelockDelay + BigInt(ETA_BUFFER_SECONDS);
  console.log("Calculated ETA (timestamp):", eta.toString());
  console.log("Calculated ETA (Date):", new Date(Number(eta) * 1000).toUTCString());

  // 3. Encode Call Data
  let callData;
  if (FUNCTION_SIGNATURE && FUNCTION_SIGNATURE.length > 0) {
    const iface = new ethers.Interface([`function ${FUNCTION_SIGNATURE}`]);
    if (FUNCTION_ARGS.length === 0) {
      callData = "0x";
    } else {
      const paramTypes = iface.getFunction(FUNCTION_SIGNATURE.split('(')[0])?.inputs.map(input => input.type);
      if (!paramTypes) {
        throw new Error(`Could not parse parameter types from signature: ${FUNCTION_SIGNATURE}`);
      }
      console.log('paramTypes', paramTypes, 'split', FUNCTION_SIGNATURE.split('(')[0])
      // callData = ethers.AbiCoder.defaultAbiCoder().encode(paramTypes, FUNCTION_ARGS);
      callData = iface.encodeFunctionData(
        FUNCTION_SIGNATURE.split('(')[0], // "transfer"
        FUNCTION_ARGS // [address, amount]
      );
    }
    console.log("Encoded Call Data:", callData);
  } else {
    callData = "0x";
    console.log("Using empty calldata");
  }
  
  const valueToSend = ethers.parseEther(VALUE_ETH);

  // 4. Queue the transaction
  console.log("\nQueueing transaction with parameters:");
  console.log("  Target:", TARGET_ADDRESS);
  console.log("  Value:", valueToSend.toString(), `(${VALUE_ETH} ETH)`);
  console.log("  Signature:", FUNCTION_SIGNATURE);
  console.log("  Data:", callData);
  console.log("  ETA:", eta.toString());

  try {
    // Get txHash first (static call)
    const txHash = await timelockModule.queueTransaction.staticCall(
      TARGET_ADDRESS,
      valueToSend,
      FUNCTION_SIGNATURE, 
      callData,
      eta
    );

    // Queue the actual transaction
    const tx = await timelockModule.queueTransaction(
      TARGET_ADDRESS,
      valueToSend,
      FUNCTION_SIGNATURE, 
      callData,
      eta
    );

    console.log("Transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Transaction mined successfully.");

    let queuedTxHash;
    let queueEvent;
    if (receipt && receipt.logs) {
      for (const log of receipt.logs) {
        const logItem = log;
        try {
          const parsedLog = timelockModule.interface.parseLog(logItem);
          if (parsedLog && parsedLog.name === "QueueTransaction") {
            queuedTxHash = parsedLog.args.txHash;
            queueEvent = parsedLog;
            break;
          }
        } catch (e) { /* Skip logs that aren't from our module */ }
      }
    }

    if (queuedTxHash) {
      console.log("\n✅ Transaction Queued successfully!");
      console.log("  Queued Tx Hash:", queuedTxHash);
      console.log("  Target:", queueEvent.args.target);
      console.log("  Value:", ethers.formatEther(queueEvent.args.value), "ETH");
      console.log("  Signature:", queueEvent.args.signature);
      console.log("  Data:", queueEvent.args.data);
      console.log("  ETA:", new Date(Number(queueEvent.args.eta) * 1000).toUTCString());

      // Save this transaction info to a file for later execution or cancellation
      queuedTx = {
        txHash: queuedTxHash,
        target: TARGET_ADDRESS,
        value: valueToSend.toString(),
        signature: FUNCTION_SIGNATURE,
        data: callData,
        eta: eta.toString(),
        queuedAt: new Date().toISOString(),
        executesAfter: new Date(Number(eta) * 1000).toISOString(),
        tx: tx.hash
      };

      fs.writeFileSync(
        "queued-tx.json", 
        JSON.stringify(queuedTx, null, 2)
      );
    } else {
      console.warn("⚠️ QueueTransaction event not found in receipt. Check contract events manually.");
    }
  } catch (error) {
    console.error("❌ Error queueing transaction:", error);
    process.exit(1);
  }
}

async function cancelTransaction(timelockModule, signer) {
  console.log("\n=== Cancelling Transaction ===");
  
  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error("Could not load queued-tx.json. Please queue a transaction first or specify details manually.");
    process.exit(1);
  }

  console.log("\nCancelling transaction with details:");
  console.log("  Target:", queuedTxData.target);
  console.log("  Value:", queuedTxData.value, `(${ethers.formatEther(queuedTxData.value)} ETH)`);
  console.log("  Signature:", queuedTxData.signature);
  console.log("  Data:", queuedTxData.data);
  console.log("  ETA:", queuedTxData.eta);

  try {
    // Check if transaction is still queued
    const isQueued = await timelockModule.queuedTransactions(queuedTxData.txHash);
    if (!isQueued) {
      console.log("⚠️ Transaction is not in the queue (may have already been executed or cancelled)");
      process.exit(0);
    }

    // Cancel the transaction
    const tx = await timelockModule.cancelTransaction(
      queuedTxData.target,
      queuedTxData.value,
      queuedTxData.signature,
      queuedTxData.data,
      queuedTxData.eta
    );

    console.log("Cancel transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Cancel transaction mined successfully.");

    let cancelEvent;
    if (receipt && receipt.logs) {
      for (const log of receipt.logs) {
        try {
          const parsedLog = timelockModule.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "CancelTransaction") {
            cancelEvent = parsedLog;
            break;
          }
        } catch (e) { /* Skip logs that aren't from our module */ }
      }
    }

    if (cancelEvent) {
      console.log("\n✅ Transaction Cancelled successfully!");
      // Verify it's actually cancelled by checking the queued status
      const isStillQueued = await timelockModule.queuedTransactions(queuedTxData.txHash);
      console.log("  Is still queued:", isStillQueued);
      
      // Update the queued-tx file with cancellation info
      queuedTxData.cancelled = true;
      queuedTxData.cancelledAt = new Date().toISOString();
      queuedTxData.cancelTx = tx.hash;
      
      fs.writeFileSync(
        "queued-tx.json", 
        JSON.stringify(queuedTxData, null, 2)
      );
      console.log("\nUpdated transaction details in queued-tx.json");
    } else {
      console.warn("⚠️ CancelTransaction event not found in receipt. Check contract events manually.");
    }
  } catch (error) {
    console.error("❌ Error cancelling transaction:", error);
    process.exit(1);
  }
}

async function executeTransaction(timelockModule, signer) {
  console.log("\n=== Executing Transaction ===");
  
  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error("Could not load queued-tx.json. Please queue a transaction first or specify details manually.");
    process.exit(1);
  }

  if (queuedTxData.cancelled) {
    console.error("This transaction was already cancelled on", queuedTxData.cancelledAt);
    process.exit(1);
  }

  if (queuedTxData.executed) {
    console.error("This transaction was already executed on", queuedTxData.executedAt);
    process.exit(1);
  }

  console.log("\nExecuting transaction with details:");
  console.log("  Target:", queuedTxData.target);
  console.log("  Value:", queuedTxData.value, `(${ethers.formatEther(queuedTxData.value)} ETH)`);
  console.log("  Signature:", queuedTxData.signature);
  console.log("  Data:", queuedTxData.data);
  console.log("  ETA:", queuedTxData.eta, `(${queuedTxData.executesAfter})`);

  // Check if we've reached the ETA
  let currentTimestampSeconds;
  if (network.name === "hardhat" || network.name === "localhost") {
    currentTimestampSeconds = BigInt(await time.latest());
  } else {
    const latestBlock = await ethers.provider.getBlock('latest');
    if (!latestBlock) {
      throw new Error("Could not fetch the latest block from the provider.");
    }
    currentTimestampSeconds = BigInt(latestBlock.timestamp);
  }

  const eta = BigInt(queuedTxData.eta);
  if (currentTimestampSeconds < eta) {
    console.log("\n⚠️ The ETA has not been reached yet.");
    console.log("  Current time:", new Date(Number(currentTimestampSeconds) * 1000).toUTCString());
    console.log("  ETA:", new Date(Number(eta) * 1000).toUTCString());
    console.log(`  Time remaining: ${Number(eta - currentTimestampSeconds) / 60} minutes`);
    
    if (network.name === "hardhat") {
      console.log("\nAdvancing time to ETA for testing...");
      await time.increaseTo(eta + 1n);
      console.log("Time advanced to:", new Date((Number(eta) + 1) * 1000).toUTCString());
    } else {
      console.log("\nPlease wait until the ETA is reached before executing the transaction.");
      process.exit(1);
    }
  }

  try {
    // Check if transaction is still queued
    const isQueued = await timelockModule.queuedTransactions(queuedTxData.txHash);
    if (!isQueued) {
      console.log("⚠️ Transaction is not in the queue (may have already been executed or cancelled)");
      process.exit(0);
    }

    // Execute the transaction
    const tx = await timelockModule.executeTransaction(
      queuedTxData.target,
      queuedTxData.value,
      queuedTxData.signature,
      queuedTxData.data,
      queuedTxData.eta
    );

    console.log("Execute transaction sent, hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Execute transaction mined successfully.");

    let executeEvent;
    if (receipt && receipt.logs) {
      for (const log of receipt.logs) {
        try {
          const parsedLog = timelockModule.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "ExecuteTransaction") {
            executeEvent = parsedLog;
            break;
          }
        } catch (e) { /* Skip logs that aren't from our module */ }
      }
    }

    if (executeEvent) {
      console.log("\n✅ Transaction Executed successfully!");
      
      // Update the queued-tx file with execution info
      queuedTxData.executed = true;
      queuedTxData.executedAt = new Date().toISOString();
      queuedTxData.executeTx = tx.hash;
      
      fs.writeFileSync(
        "queued-tx.json", 
        JSON.stringify(queuedTxData, null, 2)
      );
      console.log("\nUpdated transaction details in queued-tx.json");
    } else {
      console.warn("⚠️ ExecuteTransaction event not found in receipt. Check contract events manually.");
    }
  } catch (error) {
    console.error("❌ Error executing transaction:", error);
    console.error(error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
