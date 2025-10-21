// @ts-ignore
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(
    "Deploying SafeTimelockModule with the account:",
    deployer.address,
  );

  const SafeTimelockModule =
    await ethers.getContractFactory("SafeTimelockModule");
  const safeTimelockModule = await SafeTimelockModule.deploy(
    new ethers.Wallet(process.env.PLATFORM_PRIVATE_KEY, ethers.provider).address,
    60,
  );

  await safeTimelockModule.waitForDeployment();

  const safeTimelockModuleAddress = await safeTimelockModule.getAddress();
  console.log("SafeTimelockModule deployed to:", safeTimelockModuleAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
