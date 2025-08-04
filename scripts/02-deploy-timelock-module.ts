const { ethers } = require("hardhat");
const fs = require("fs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";

// Configuration
const INITIAL_DELAY_SECONDS = 60 * 30; // 30 minutes

// Load deployment addresses from file or use defaults
let FACTORY_ADDRESS;
let AVATAR_ADDRESS;
let TARGET_ADDRESS;

FACTORY_ADDRESS = "0x0bF2d7514DD93c07201A1e37E8392FCDa5Ad39b5";
AVATAR_ADDRESS = "0xb345A5eC60EE45eBac20849f7043f1141A8810B7";
TARGET_ADDRESS = "0xb345A5eC60EE45eBac20849f7043f1141A8810B7";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address, "to deploy SafeTimelockModule via factory");

  // Get the FactorySafeTimeModule contract interface
  const factory = await ethers.getContractAt("FactorySafeTimeModule", FACTORY_ADDRESS);

  console.log(`\n=== Deploying SafeTimelockModule ===`);
  console.log(`Avatar: ${AVATAR_ADDRESS}`);
  console.log(`Target: ${TARGET_ADDRESS}`);
  console.log(`Initial Delay: ${INITIAL_DELAY_SECONDS} seconds`);

  // Call createSafeTimelockModule on the factory
  const tx = await factory.createSafeTimelockModule(
    AVATAR_ADDRESS,
    TARGET_ADDRESS,
    INITIAL_DELAY_SECONDS
  );
  
  console.log("\nTransaction sent, hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Transaction mined.");

  // Get the module address
  const moduleAddresses = await factory.getSafeTimelockModuleAddresses();
  if (moduleAddresses.length === 0) {
    console.error("No modules found in factory after deployment attempt. Something went wrong.");
    process.exit(1);
  }

  // The last address in the array should be the newly deployed module
  const newModuleAddress = moduleAddresses[moduleAddresses.length - 1];
  console.log("SafeTimelockModule deployed to:", newModuleAddress);

  // Connect to the Safe
  console.log("\n=== Enabling module on Safe ===");
  const safe = new ethers.Contract(AVATAR_ADDRESS, GnosisSafeArtifact.abi, deployer);

  // Check if the module is already enabled
  const isModuleEnabled = await safe.isModuleEnabled(newModuleAddress);
  if (isModuleEnabled) {
    console.log("Module is already enabled on the Safe");
  } else {
    console.log("Enabling module on Safe...");
    
    // Prepare enableModule transaction data
    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [newModuleAddress]);
    
    // Execute the transaction on the Safe
    const safeNonce = await safe.nonce();
    
    // Create transaction hash that needs to be signed
    const txHash = await safe.getTransactionHash(
      AVATAR_ADDRESS,
      0, // value
      enableModuleData,
      0, // operation (Call)
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      safeNonce
    );
    
    // Sign the transaction hash
    const signature = await deployer.signMessage(ethers.getBytes(txHash));
    
    // Adjust signature format for Safe
    let adjustedSig = signature;
    const sig = ethers.Signature.from(signature);
    if (sig.v === 27 || sig.v === 28) {
      adjustedSig = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]);
    } else if (sig.v === 0 || sig.v === 1) {
      adjustedSig = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 27 + 4, 1)]);
    }
    
    // Execute the transaction on the Safe
    const enableTx = await safe.execTransaction(
      AVATAR_ADDRESS, 
      0, // value
      enableModuleData,
      0, // operation (Call)
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      adjustedSig
    );
    
    console.log("Enable module transaction sent, hash:", enableTx.hash);
    await enableTx.wait();
    console.log("Enable module transaction mined.");
    
    // Verify the module is now enabled
    const moduleEnabledNow = await safe.isModuleEnabled(newModuleAddress);
    console.log("Module enabled on Safe:", moduleEnabledNow);
  }

  // Save module address to a file for the next script
  const moduleInfo = {
    factoryAddress: FACTORY_ADDRESS,
    safeAddress: AVATAR_ADDRESS,
    timelockModuleAddress: newModuleAddress,
    initialDelay: INITIAL_DELAY_SECONDS,
    deployedBy: deployer.address,
    deploymentTime: new Date().toISOString(),
  };

  fs.writeFileSync(
    "module-deployment.json", 
    JSON.stringify(moduleInfo, null, 2)
  );
  
  console.log("\nModule deployment info saved to module-deployment.json");
  console.log("\nUse these addresses in 03-addTransaction.ts");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 