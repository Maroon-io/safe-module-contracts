const { ethers } = require("hardhat");
import * as fs from "fs";

// Gnosis Safe deployment dependencies
import SafeProxyFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";

// Configuration
const DEFAULT_TIMELOCK_DELAY = 60 * 3; // 3 minutes in seconds
const SAFE_THRESHOLD = 1; // Single owner for simplicity in testing

// Use the provided addresses
const SAFE_SINGLETON_ADDRESS = "0x0474d2f1538F604d9A4f1766cf80eBB0051eDC8f";
const SAFE_FACTORY_ADDRESS = "0x6a7575076C9A178771b096953544021Bd259Dec9";
const ADD_MODULES_LIB_ADDRESS = "0x7Da32Af82b35CEc5c88249BdC8232056e762DaB2";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Deploy FactorySafeTimeModule
  console.log("\n=== Deploying FactorySafeTimeModule ===");
  const FactorySafeTimeModuleFactory = await ethers.getContractFactory("FactorySafeTimeModule");
  const factory = await FactorySafeTimeModuleFactory.deploy(
    deployer.address, 
    DEFAULT_TIMELOCK_DELAY,
    { gasPrice: ethers.parseUnits('50', 'gwei') }
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("FactorySafeTimeModule deployed to:", factoryAddress);

  // Connect to existing Safe contracts using the provided addresses
  console.log("\n=== Connecting to Gnosis Safe Contracts ===");  
  console.log("Safe Singleton address:", SAFE_SINGLETON_ADDRESS);
  console.log("Safe Factory address:", SAFE_FACTORY_ADDRESS);
  
  const safeFactory = new ethers.Contract(
    SAFE_FACTORY_ADDRESS, 
    SafeProxyFactoryArtifact.abi, 
    deployer
  );
  
  const safeSingleton = new ethers.Contract(
    SAFE_SINGLETON_ADDRESS,
    GnosisSafeArtifact.abi,
    deployer
  );

  // Create a Safe proxy instance
  console.log("\n=== Creating New Safe Instance ===");
  const owners = [deployer.address];
  console.log("Safe Owner:", deployer.address);
  
  const setupData = safeSingleton.interface.encodeFunctionData("setup", [
    owners,                     // _owners
    SAFE_THRESHOLD,             // _threshold
    ethers.ZeroAddress,         // to
    "0x",                       // data
    ethers.ZeroAddress,         // fallbackHandler
    ethers.ZeroAddress,         // paymentToken
    0,                          // payment
    ethers.ZeroAddress          // paymentReceiver
  ]);

  const saltNonce = Date.now();
  const proxyAddress = await safeFactory.createProxyWithNonce.staticCall(
    SAFE_SINGLETON_ADDRESS,
    setupData,
    saltNonce,
    { gasPrice: ethers.parseUnits('50', 'gwei') }
  );
  
  console.log("Predicted Safe address:", proxyAddress);
  
  const createProxyTx = await safeFactory.createProxyWithNonce(
    SAFE_SINGLETON_ADDRESS,
    setupData,
    saltNonce,
    { gasPrice: ethers.parseUnits('50', 'gwei') }
  );
  
  console.log("Creating Safe, transaction hash:", createProxyTx.hash);
  const receipt = await createProxyTx.wait();
  console.log("Safe creation confirmed");
  
  // Get the proxy address from the event (FIXED)
  const proxyCreationEvent = receipt?.logs.find(
    log => log.topics[0] === safeFactory.interface.getEvent("ProxyCreation")?.topicHash
  );
  
  if (!proxyCreationEvent) {
    throw new Error("Could not find ProxyCreation event");
  }
  
  // Fixed address extraction - use the predicted address since we already have it
  const safeProxyAddress = proxyAddress;
  
  console.log("Safe Proxy deployed to:", safeProxyAddress);
  
  // Save the addresses to a JSON file for use in other scripts
  const network = await ethers.provider.getNetwork();

  console.log("Deploying Module through factory and attaching it to safe")

  const tx = await factory.createSafeTimelockModule(
    safeProxyAddress, 
    safeProxyAddress, 
    DEFAULT_TIMELOCK_DELAY, 
    { gasPrice: ethers.parseUnits('50', 'gwei') }
  );
  
  console.log("Module deployment transaction sent, hash:", tx.hash);
  await tx.wait();
  console.log("Module deployment transaction mined.");
  
  // Get the module address from the factory
  const moduleAddresses = await factory.getSafeTimelockModuleAddresses();
  if (moduleAddresses.length === 0) {
    throw new Error("No modules found in factory after deployment attempt.");
  }
  
  // The last address in the array should be the newly deployed module
  const safeModule = moduleAddresses[moduleAddresses.length - 1];
  console.log("SafeTimelockModule deployed to:", safeModule);

  const safe = new ethers.Contract(safeProxyAddress, GnosisSafeArtifact.abi, deployer);

  let isModuleEnabled = await safe.isModuleEnabled(safeModule);
  if (isModuleEnabled) {
    console.log("Module is already enabled on the Safe");
  } else {
    console.log("Enabling module on Safe...");
    
    // Prepare enableModule transaction data
    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [safeModule]);
    
    // Execute the transaction on the Safe
    const safeNonce = await safe.nonce();
    
    // Create transaction hash that needs to be signed
    const txHash = await safe.getTransactionHash(
      safeProxyAddress,
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
      safeProxyAddress, 
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
    isModuleEnabled = await safe.isModuleEnabled(safeModule);
    console.log("Module enabled on Safe:", isModuleEnabled);
  }

  console.log("Safe Module deployed to:", safeModule);

  const deploymentInfo = {
    factoryAddress,
    safeAddress: safeProxyAddress,
    safeOwner: deployer.address,
    safeSingletonAddress: SAFE_SINGLETON_ADDRESS,
    safeFactoryAddress: SAFE_FACTORY_ADDRESS, 
    deployedBy: deployer.address,
    deploymentTime: new Date().toISOString(),
    network: network.name,
    chainId: network.chainId.toString(),
    safeModuleAddress: safeModule,
    isModuleEnabled: isModuleEnabled
  };


  fs.writeFileSync(
    "safe-factory-deployment.json", 
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("\nDeployment addresses saved to safe-factory-deployment.json");

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });