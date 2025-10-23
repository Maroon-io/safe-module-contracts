import { ethers } from "hardhat";
import * as fs from "fs";

// Get provider
const provider = ethers.provider;

// Gnosis Safe deployment dependencies
import SafeProxyFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";

// Safe Configuration
const SAFE_THRESHOLD = 2;
const SAFE_OWNER1 = new ethers.Wallet(
  process.env.OWNER1_PRIVATE_KEY as string,
  provider,
);
const SAFE_OWNER2 = new ethers.Wallet(
  process.env.OWNER2_PRIVATE_KEY as string,
  provider,
);
const SAFE_OWNERS = [SAFE_OWNER1, SAFE_OWNER2];

// Load addresses from disk
const safeConfigLocation = "deployed-addresses/somnia-safe-contracts.json";
let globalSafeConfig: any;

try {
  globalSafeConfig = JSON.parse(fs.readFileSync(safeConfigLocation, "utf8"));
  console.log("Loaded Safe config");
} catch (error) {
  console.warn(`Unable to load Safe config`);
  process.exit(1);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using Deployer:", deployer.address);

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
  console.log("Creating New Safe Instance");

  const safeOwners = SAFE_OWNERS.map((owner) => owner.address);
  console.log("Safe Owners:", safeOwners.join(","));

  const initData = safeSingleton.interface.encodeFunctionData("enableModules", [
    [globalSafeConfig.erc4337module, globalSafeConfig.safeTimelockModule],
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
    globalSafeConfig.safeTimelockModule,
  );
  console.log("Is Module Enabled on Predicted Safe Address:", isModuleEnabled);

  // Save the addresses to a JSON file for use in other scripts
  const network = await ethers.provider.getNetwork();
  const deploymentInfo = {
    safeAddress: expectedSafeAddress,
    safeOwner: safeOwners,
    safeSingletonAddress: globalSafeConfig.safeSingleton,
    safeFactoryAddress: globalSafeConfig.proxyFactory,
    safeTimelockModuleAddress: globalSafeConfig.safeTimelockModule,
    isSafeTimelockModuleEnabled: isModuleEnabled,
    network: network.name,
    chainId: network.chainId.toString(),
  };

  fs.writeFileSync(
    "safe-deployment.json",
    JSON.stringify(deploymentInfo, null, 2),
  );
  console.log("Deployment info saved to safe-deployment.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
