import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying FactorySafeTimeModule with the account:", deployer.address);

  const FactorySafeTimeModuleFactory = await ethers.getContractFactory("FactorySafeTimeModule");
  const factory = await FactorySafeTimeModuleFactory.deploy(deployer.address, 1000);

  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  console.log("FactorySafeTimeModule deployed to:", factoryAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 