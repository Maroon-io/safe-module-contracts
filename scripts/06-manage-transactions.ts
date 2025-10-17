const { ethers, network } = require("hardhat");
const fs = require("fs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
console.log("args:", process.argv.slice(2));

// Command line arguments for operation mode
const args = process.argv.slice(2);

const operation = process.env.OPERATION || "queue";
// const operation = args[0] || "queue"; // Default to queue if no operation specified
// Valid operations: queue, cancel, execute

// Load timelock module address from file
let MODULE_INFO;
try {
  MODULE_INFO = JSON.parse(fs.readFileSync("module-deployment.json"));
  console.log("Loaded addresses from module-deployment.json");
} catch (error) {
  console.warn(
    "Could not load module-deployment.json. Please make sure to run 02-deploy-timelock-module.ts first",
  );
  console.warn(
    "Using default placeholder addresses - modify these with your actual addresses",
  );
  MODULE_INFO = {
    timelockModuleAddress: "0xAcD3d2442299DfF4d1a449dfcFa6dAE551DE150F",
    safeAddress: "0xb345A5eC60EE45eBac20849f7043f1141A8810B7",
    initialDelay: 60 * 3, // 3 minutes
  };
}

const queuedTxConfig = {
  safeAddress: "0x765a409ae91E667B31f57165b006C738a06612f3",
  targetAddress: "0x94Fc2245d6699BbfA71B4698e40a0b76AcD582D8",
  value: "0",
};

// Store transaction info for cancellation/execution
let queuedTx = {
  txHash: "",
  target: "",
  value: 0,
  data: "",
  eta: 0,
  queuedAt: "",
  executesAfter: "",
  tx: "",
};

async function main() {
  const signer1 = new ethers.Wallet(
    process.env.OWNER1_PRIVATE_KEY,
    ethers.provider,
  );

  const signer2 = new ethers.Wallet(
    process.env.OWNER2_PRIVATE_KEY,
    ethers.provider,
  );

  const timelockModule = await ethers.getContractAt(
    "SafeTimelockModule",
    "0x47ff6dec29BF0AD4D650129fa37920d09245da61",
  );

  switch (operation.toLowerCase()) {
    case "queue":
      await queueTransaction(timelockModule, signer1);
      break;
    case "cancel":
      await cancelTransaction(timelockModule, signer2);
      break;
    case "execute":
      await executeTransaction(timelockModule, signer2);
      break;
    default:
      console.error(
        `Invalid operation: ${operation}. Valid operations are: queue, cancel, execute`,
      );
      process.exit(1);
  }
}

async function checkIsSafeOwner(signerAddress: string) {
  const safe = await ethers.getContractAt(
    "contracts/SafeTimelockModule.sol:IGnosisSafe",
    queuedTxConfig.safeAddress,
  );

  try {
    return await safe.isOwner(signerAddress);
  } catch (error) {
    console.error(
      "ERROR: Signer is not a Safe owner. Only Safe owners can interact with the SafeTimelockModule.",
    );
    process.exit(1);
  }
}

const getETA = async (timelockDelay) => {
  let currentTimestampSeconds: BigInt;

  if (network.name === "hardhat" || network.name === "localhost") {
    currentTimestampSeconds = BigInt(await time.latest());
  } else {
    const latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock) {
      throw new Error("Could not fetch the latest block from the provider.");
    }
    currentTimestampSeconds = BigInt(latestBlock.timestamp);
  }
  console.log(
    "Current block timestamp (seconds):",
    currentTimestampSeconds.toString(),
  );

  const eta = currentTimestampSeconds + timelockDelay;
  console.log("Calculated ETA (timestamp):", eta.toString());
  console.log(
    "Calculated ETA (Date):",
    new Date(Number(eta) * 1000).toUTCString(),
  );

  return eta;
};

async function queueTransaction(timelockModule: any, signer: any) {
  console.log("\n=== Queueing Transaction ===");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Debug: Check contract state
  const platform = await timelockModule.platform();
  const owner = await timelockModule.owner();
  console.log("Platform address:", platform);
  console.log("Contract owner:", owner);
  console.log("Signer address:", signer.address);

  // 1. Get timelock delay from the module
  const timelockDelay = await timelockModule.getTimelockDelay();
  console.log("Current timelock delay (seconds): ", timelockDelay.toString());

  // 2. Calculate ETA
  const eta = await getETA(timelockDelay);

  // 3. Encode Call Data
  const iface = new ethers.Interface(["function transfer(address,uint256)"]);
  const callData = iface.encodeFunctionData("transfer", [
    "0xe37fa5978b4C776B7d314d9B4a384ef342F97a23",
    ethers.parseUnits("100", 18),
  ]);

  const valueEth = queuedTxConfig.value;
  const valueToSend = ethers.parseEther(valueEth);

  // 4. Queue the transaction
  console.log("\nQueueing transaction with parameters:");
  console.log("  Target:", queuedTxConfig.targetAddress);
  console.log("  Value:", valueToSend.toString(), `(${valueEth} ETH)`);
  console.log("  Data:", callData);
  console.log("  ETA:", eta.toString());

  try {
    const unsignedTx =
      await timelockModule.queueTransaction.populateTransaction(
        queuedTxConfig.safeAddress,
        queuedTxConfig.targetAddress,
        valueToSend,
        callData,
        eta + BigInt(60),
      );
    console.log("Transaction to sign:", unsignedTx);

    // Sign and send tx
    const tx = await signer.sendTransaction(unsignedTx);
    console.log("Transaction sent, hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("Transaction mined successfully.");

    let queuedTxHash;
    let queueEvent;
    if (receipt && receipt.logs) {
      for (const log of receipt.logs) {
        try {
          const parsedLog = timelockModule.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "QueueTransaction") {
            queuedTxHash = parsedLog.args.txHash;
            queueEvent = parsedLog;
            break;
          }
        } catch (e) {
          /* Skip logs that aren't from our module */
        }
      }
    }

    if (queuedTxHash) {
      console.log("\n✅ Transaction Queued successfully!");
      console.log("  Queued Tx Hash:", queuedTxHash);
      console.log("  Target:", queueEvent.args.to);
      console.log("  Value:", ethers.formatEther(queueEvent.args.value), "ETH");
      console.log("  Data:", queueEvent.args.data);
      console.log(
        "  ETA:",
        new Date(Number(queueEvent.args.eta) * 1000).toUTCString(),
      );

      // Save this transaction info to a file for later execution or cancellation
      queuedTx = {
        txHash: queuedTxHash,
        target: queuedTxConfig.targetAddress,
        value: valueToSend.toString(),
        data: callData,
        eta: eta.toString(),
        queuedAt: new Date().toISOString(),
        executesAfter: new Date(Number(eta) * 1000).toISOString(),
        tx: tx.hash,
      };

      fs.writeFileSync("queued-tx.json", JSON.stringify(queuedTx, null, 2));
    } else {
      console.warn(
        "⚠️ QueueTransaction event not found in receipt. Check contract events manually.",
      );
    }
  } catch (error) {
    console.error("❌ Error queueing transaction:", error);
    process.exit(1);
  }
}

async function cancelTransaction(timelockModule, signer) {
  console.log("\n=== Cancelling Transaction ===");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error(
      "Could not load queued-tx.json. Please queue a transaction first or specify details manually.",
    );
    process.exit(1);
  }

  console.log("\nCancelling transaction with details:");
  console.log("  Target:", queuedTxData.target);
  console.log(
    "  Value:",
    queuedTxData.value,
    `(${ethers.formatEther(queuedTxData.value)} ETH)`,
  );
  console.log("  Data:", queuedTxData.data);
  console.log("  ETA:", queuedTxData.eta);

  try {
    const unsignedTx =
      await timelockModule.cancelTransaction.populateTransaction(
        queuedTxData.safeAddress,
        queuedTxData.target,
        queuedTxData.value,
        queuedTxData.data,
        queuedTxData.eta,
      );
    console.log("Transaction to sign:", unsignedTx);

    // Sign and send tx
    const tx = await signer.sendTransaction(unsignedTx);
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
        } catch (e) {
          /* Skip logs that aren't from our module */
        }
      }
    }

    if (cancelEvent) {
      console.log("\n✅ Transaction Cancelled successfully!");

      // Update the queued-tx file with cancellation info
      queuedTxData.cancelled = true;
      queuedTxData.cancelledAt = new Date().toISOString();
      queuedTxData.cancelTx = tx.hash;

      fs.writeFileSync("queued-tx.json", JSON.stringify(queuedTxData, null, 2));
      console.log("\nUpdated transaction details in queued-tx.json");
    } else {
      console.warn(
        "⚠️ CancelTransaction event not found in receipt. Check contract events manually.",
      );
    }
  } catch (error) {
    console.error("❌ Error cancelling transaction:", error);
    process.exit(1);
  }
}

async function executeTransaction(timelockModule, signer) {
  console.log("\n=== Executing Transaction ===");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error(
      "Could not load queued-tx.json. Please queue a transaction first or specify details manually.",
    );
    process.exit(1);
  }

  console.log("\nExecuting transaction with details:");
  console.log("  Target:", queuedTxData.target);
  console.log(
    "  Value:",
    queuedTxData.value,
    `(${ethers.formatEther(queuedTxData.value)} ETH)`,
  );
  console.log("  Data:", queuedTxData.data);
  console.log("  ETA:", queuedTxData.eta, `(${queuedTxData.executesAfter})`);

  try {
    const unsignedTx =
      await timelockModule.executeTransaction.populateTransaction(
        queuedTxData.safeAddress,
        queuedTxData.target,
        queuedTxData.value,
        queuedTxData.data,
        BigInt(queuedTxData.eta) + BigInt(60),
      );
    console.log("Transaction to sign:", unsignedTx);

    // Sign and send tx
    const tx = await signer.sendTransaction(unsignedTx);
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
        } catch (e) {
          /* Skip logs that aren't from our module */
        }
      }
    }

    if (executeEvent) {
      console.log("\n✅ Transaction Executed successfully!");

      // Update the queued-tx file with execution info
      queuedTxData.executed = true;
      queuedTxData.executedAt = new Date().toISOString();
      queuedTxData.executeTx = tx.hash;

      fs.writeFileSync("queued-tx.json", JSON.stringify(queuedTxData, null, 2));
      console.log("\nUpdated transaction details in queued-tx.json");
    } else {
      console.warn(
        "⚠️ ExecuteTransaction event not found in receipt. Check contract events manually.",
      );
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
