import { ethers, network } from "hardhat";
import * as fs from "fs";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Valid operations: queue, cancel, execute
const operation = process.env.OPERATION || "queue";

// Load safe details from disk
const safeDeploymentLocation = "safe-deployment.json";
const deployScriptLocation = "scripts/00-deploy-timelock-module.ts";
let safeDeploymentDetails: any;

try {
  safeDeploymentDetails = JSON.parse(
    fs.readFileSync(safeDeploymentLocation, "utf8"),
  );
  console.log("Loaded Safe deployment details");
} catch (error) {
  console.warn(
    `Unable to load Safe deployment. Run ${deployScriptLocation} first`,
  );
  process.exit(1);
}

async function main() {
  const signer1 = new ethers.Wallet(
    process.env.OWNER1_PRIVATE_KEY as string,
    ethers.provider,
  );

  const signer2 = new ethers.Wallet(
    process.env.OWNER2_PRIVATE_KEY as string,
    ethers.provider,
  );

  const timelockModule = await ethers.getContractAt(
    "SafeTimelockModule",
    safeDeploymentDetails.safeTimelockModuleAddress,
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
    safeDeploymentDetails.safeAddress,
  );

  try {
    const owners: any[] = await safe.getOwners();
    return owners
      .map((o) => o.toLowerCase())
      .includes(signerAddress.toLowerCase());
  } catch (error) {
    console.error(
      "ERROR: Signer is not a Safe owner. Only Safe owners can interact with the SafeTimelockModule.",
    );
    process.exit(1);
  }
}

const getETA = async (timelockDelay: any) => {
  let currentTimestampSeconds;

  if (["hardhat", "localhost"].includes(network.name)) {
    currentTimestampSeconds = await time.latest();
  } else {
    const latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock) {
      throw new Error("Could not fetch the latest block from the provider.");
    }
    currentTimestampSeconds = latestBlock.timestamp;
  }
  console.log(
    "Current block timestamp (seconds):",
    currentTimestampSeconds.toString(),
  );

  const eta = currentTimestampSeconds + Number(timelockDelay);
  console.log("Calculated ETA (timestamp):", eta.toString());
  console.log(
    "Calculated ETA (Date):",
    new Date(Number(eta) * 1000).toUTCString(),
  );

  return eta;
};

const getTxEventDetails = (timelockModule: any, receipt: any, type: string) => {
  for (const log of receipt.logs) {
    try {
      const parsedLog = timelockModule.interface.parseLog(log);
      if (
        parsedLog &&
        ((type === "queue" && parsedLog.name === "QueueTransaction") ||
          (type === "cancel" && parsedLog.name === "CancelTransaction") ||
          (type === "execute" && parsedLog.name === "ExecuteTransaction"))
      ) {
        return {
          loggedEvent: parsedLog,
        };
      }
    } catch (e) {
      /* Skip logs that aren't from our module */
    }
  }
};

async function queueTransaction(timelockModule: any, signer: any) {
  console.log("Queueing Transaction...");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Get timelock delay from the module
  const timelockDelay = await timelockModule.getTimelockDelay();
  console.log("Current timelock delay (seconds): ", timelockDelay.toString());

  // Calculate ETA
  const eta = await getETA(timelockDelay);

  // Encode Call Data
  const iface = new ethers.Interface(["function transfer(address,uint256)"]);
  const callData = iface.encodeFunctionData("transfer", [
    "0xe37fa5978b4C776B7d314d9B4a384ef342F97a23",
    ethers.parseUnits("100", 18),
  ]);

  // Set tx target
  const targetAddress = "0x94Fc2245d6699BbfA71B4698e40a0b76AcD582D8";

  // Set tx value
  const valueEth = "0";
  const valueToSend = ethers.parseEther(valueEth);

  // Queue the transaction
  try {
    const unsignedTx =
      await timelockModule.queueTransaction.populateTransaction(
        safeDeploymentDetails.safeAddress,
        targetAddress,
        valueToSend,
        callData,
        eta + 60, // add buffer to account for time diff when reading block timestamp
      );
    console.log("Unsigned QueueTransaction:", unsignedTx);

    // Sign and send tx
    const tx = await signer.sendTransaction(unsignedTx);
    console.log("QueueTransaction sent, hash:", tx.hash);

    const receipt = await tx.wait();
    console.log("QueueTransaction mined successfully.");

    if (receipt && receipt.logs) {
      const { loggedEvent } = getTxEventDetails(
        timelockModule,
        receipt,
        "queue",
      ) as {
        loggedEvent: any;
      };

      if (loggedEvent) {
        console.log("Transaction Queued successfully");

        const queuedTxDetails = {
          safeAddress: loggedEvent.args.safe,
          txHash: loggedEvent.args.txHash,
          target: loggedEvent.args.to,
          value: valueToSend.toString(),
          data: callData,
          eta: eta.toString(),
          queuedAt: new Date().toISOString(),
          executesAfter: new Date(Number(eta) * 1000).toISOString(),
          tx: tx.hash,
        };

        fs.writeFileSync(
          "queued-tx.json",
          JSON.stringify(queuedTxDetails, null, 2),
        );
        console.log("Added transaction details to queued-tx.json");
      } else {
        console.warn(
          "QueueTransaction event not found in receipt. Check contract events manually.",
        );
      }
    }
  } catch (error) {
    console.error("Error queueing transaction:", error);
    process.exit(1);
  }
}

async function cancelTransaction(timelockModule: any, signer: any) {
  console.log("Cancelling Transaction");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json", "utf8"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error(
      "Could not load queued-tx.json. Please queue a transaction first or specify details manually.",
    );
    process.exit(1);
  }

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

    if (receipt && receipt.logs) {
      const { loggedEvent } = getTxEventDetails(
        timelockModule,
        receipt,
        "cancel",
      ) as {
        loggedEvent: any;
      };

      if (loggedEvent) {
        console.log("Transaction Cancelled successfully");

        // Update the queued-tx file with cancellation info
        queuedTxData.cancelled = true;
        queuedTxData.cancelledAt = new Date().toISOString();
        queuedTxData.cancelTx = tx.hash;

        fs.writeFileSync(
          "queued-tx.json",
          JSON.stringify(queuedTxData, null, 2),
        );
        console.log("Updated transaction details in queued-tx.json");
      } else {
        console.warn(
          "CancelTransaction event not found in receipt. Check contract events manually.",
        );
      }
    }
  } catch (error) {
    console.error("Error cancelling transaction:", error);
    process.exit(1);
  }
}

async function executeTransaction(timelockModule: any, signer: any) {
  console.log("Executing Transaction");

  await checkIsSafeOwner(signer.address);
  console.log("Using account:", signer.address);

  // Load the queued transaction from file
  let queuedTxData;
  try {
    queuedTxData = JSON.parse(fs.readFileSync("queued-tx.json", "utf8"));
    console.log("Loaded transaction from queued-tx.json");
  } catch (error) {
    console.error(
      "Could not load queued-tx.json. Please queue a transaction first or specify details manually.",
    );
    process.exit(1);
  }

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

    if (receipt && receipt.logs) {
      const { loggedEvent } = getTxEventDetails(
        timelockModule,
        receipt,
        "execute",
      ) as {
        loggedEvent: any;
      };

      if (loggedEvent) {
        console.log("Transaction Executed successfully");

        // Update the queued-tx file with execution info
        queuedTxData.executed = true;
        queuedTxData.executedAt = new Date().toISOString();
        queuedTxData.executeTx = tx.hash;

        fs.writeFileSync(
          "queued-tx.json",
          JSON.stringify(queuedTxData, null, 2),
        );
        console.log("Updated transaction details in queued-tx.json");
      } else {
        console.warn(
          "ExecuteTransaction event not found in receipt. Check contract events manually.",
        );
      }
    }
  } catch (error: any) {
    console.error("Error executing transaction:", error);
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
