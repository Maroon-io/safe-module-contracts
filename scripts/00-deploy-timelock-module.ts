import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("SafeTimelockModule Contract Deployer:", deployer.address);

  const platformSigner = new ethers.Wallet(
    process.env.PLATFORM_PRIVATE_KEY as string,
    ethers.provider,
  );
  const initialTimelockDelay = 60;

  const SafeTimelockModule =
    await ethers.getContractFactory("SafeTimelockModule");

  const moduleInstance = await SafeTimelockModule.deploy(
    platformSigner.address,
    initialTimelockDelay,
  );
  await moduleInstance.waitForDeployment();

  const safeTimelockModuleAddress = await moduleInstance.getAddress();
  console.log(
    "SafeTimelockModule Contract Address:",
    safeTimelockModuleAddress,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
