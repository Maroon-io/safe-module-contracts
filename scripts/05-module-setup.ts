// @ts-ignore
import { ethers } from "hardhat";
import * as fs from "fs";

// Get provider
const provider = ethers.provider;

// Gnosis Safe deployment dependencies
// @ts-ignore
import SafeProxyFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";
// @ts-ignore
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";

// Safe Configuration
const SAFE_THRESHOLD = 2;
const SAFE_OWNERS = [
  new ethers.Wallet(process.env.OWNER1_PRIVATE_KEY, provider),
  new ethers.Wallet(process.env.OWNER2_PRIVATE_KEY, provider),
];

// Deployed Safe helper contracts
const globalSafeConfig = {
  safeSingleton: "0x3cEDc198b6a27E5881458b8f3d5907acAb0BA2AD",
  erc4337module: "0xDC390b4194Cd23c82E55047e9AF558572E7e6eFD",
  proxyFactory: "0x34F452053423bb32717cC7c63ce7F60a60da6B78",
  addModulesLib: "0xDbCB040c7aED1c927B8E3dAEDa1e0133363e991F",
};

// Deployed Module Address
const SAFE_TIMELOCK_MODULE_ADDRESS =
  "0x47ff6dec29BF0AD4D650129fa37920d09245da61";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Connect to existing Safe contracts using the provided addresses
  console.log("\n=== Connecting to Gnosis Safe Contracts ===");
  console.log("Safe Singleton address:", globalSafeConfig.safeSingleton);
  console.log("Safe Factory address:", globalSafeConfig.proxyFactory);
  console.log("Add Modules Lib address:", globalSafeConfig.addModulesLib);

  const safeFactory = new ethers.Contract(
    globalSafeConfig.proxyFactory,
    SafeProxyFactoryArtifact.abi,
    deployer,
  );

  const safeSingleton = new ethers.Contract(
    globalSafeConfig.safeSingleton,
    [...GnosisSafeArtifact.abi, "function enableModules(address[])"],
    deployer,
  );

  // Create a Safe proxy instance
  console.log("\n=== Creating New Safe Instance ===");

  const safeOwners = SAFE_OWNERS.map((owner) => owner.address);
  console.log("Safe Owners:", safeOwners.join(","));

  const initData = safeSingleton.interface.encodeFunctionData("enableModules", [
    [globalSafeConfig.erc4337module, SAFE_TIMELOCK_MODULE_ADDRESS],
  ]);

  const setupData = safeSingleton.interface.encodeFunctionData("setup", [
    safeOwners, // _owners
    SAFE_THRESHOLD, // _threshold
    globalSafeConfig.addModulesLib, // to
    initData, // data
    globalSafeConfig.erc4337module, // fallbackHandler
    ethers.ZeroAddress, // paymentToken
    0, // payment
    ethers.ZeroAddress, // paymentReceiver
  ]);

  const setupNonce = Date.now();

  // Predict the Safe Address
  const expectedSafeAddress = await safeFactory.createProxyWithNonce.staticCall(
    globalSafeConfig.safeSingleton,
    setupData,
    setupNonce,
  );
  console.log("Predicted Safe Address:", expectedSafeAddress);

  // Deploy the Safe
  const deploySafeTx = await safeFactory.createProxyWithNonce(
    globalSafeConfig.safeSingleton,
    setupData,
    setupNonce,
    { gasPrice: ethers.parseUnits("10", "gwei") },
  );
  console.log("Deploying Safe, transaction hash:", deploySafeTx.hash);

  await deploySafeTx.wait();
  console.log("Safe creation confirmed");

  const safe = new ethers.Contract(
    expectedSafeAddress,
    GnosisSafeArtifact.abi,
    deployer,
  );
  const isModuleEnabled = await safe.isModuleEnabled(
    SAFE_TIMELOCK_MODULE_ADDRESS,
  );

  console.log("Is Module Enabled on Predicted Safe Address:", isModuleEnabled);

  // Save the addresses to a JSON file for use in other scripts
  const network = await ethers.provider.getNetwork();
  const deploymentInfo = {
    safeAddress: expectedSafeAddress,
    safeOwner: safeOwners,
    safeSingletonAddress: globalSafeConfig.safeSingleton,
    safeFactoryAddress: globalSafeConfig.proxyFactory,
    deployedBy: deployer.address,
    deploymentTime: new Date().toISOString(),
    network: network.name,
    chainId: network.chainId.toString(),
    timelockModuleAddress: SAFE_TIMELOCK_MODULE_ADDRESS,
    isModuleEnabled: isModuleEnabled,
  };

  fs.writeFileSync(
    "safe-factory-deployment.json",
    JSON.stringify(deploymentInfo, null, 2),
  );
  console.log("\nDeployment addresses saved to safe-factory-deployment.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
