import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract, Signer } from "ethers";

import SafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";
import SafeFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";

// Safe contract addresses on mainnet
const SAFE_SINGLETON_ADDRESS = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const SAFE_FACTORY_ADDRESS = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";

describe("Fork tests with DirectModule and Safe", function () {
  let owner: Signer;
  let ownerAddress: string;
  let safeFactory: Contract;
  let safeL2: Contract;
  let directModule: any;
  let safe: Contract;
  let safeAddress: string;
  let directModuleAddress: string;

  beforeEach(async function () {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://mainnet.infura.io/v3/${process.env.INFURA_KEY || "ed367b18beef427e9d30387760f0d583"}`,
            blockNumber: 19000000,
          },
        },
      ],
    });

    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("50", "gwei"),
    };

    [owner] = await ethers.getSigners();
    ownerAddress = await owner.getAddress();

    safeFactory = new ethers.Contract(SAFE_FACTORY_ADDRESS, SafeFactoryArtifact.abi, owner);
    safeL2 = new ethers.Contract(SAFE_SINGLETON_ADDRESS, SafeArtifact.abi, owner);

    const owners = [ownerAddress];
    const threshold = 1;
    const saltNonce = Date.now();

    const setupData = safeL2.interface.encodeFunctionData("setup", [owners, threshold, ethers.ZeroAddress, "0x", ethers.ZeroAddress, ethers.ZeroAddress, 0, ethers.ZeroAddress]);

    safeAddress = await safeFactory.createProxyWithNonce.staticCall(SAFE_SINGLETON_ADDRESS, setupData, saltNonce);

    const tx1 = await safeFactory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, setupData, saltNonce, overrides);
    await tx1.wait();

    safe = new ethers.Contract(safeAddress, SafeArtifact.abi, owner);

    const DirectModuleFactory = await ethers.getContractFactory("DirectModule");
    directModule = await DirectModuleFactory.deploy(ownerAddress, safeAddress, safeAddress);
    directModuleAddress = await directModule.getAddress();

    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [directModuleAddress]);
    const nonce = await safe.nonce();

    const to = safeAddress;
    const value = 0;
    const data = enableModuleData;
    const operation = 0;
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.ZeroAddress;
    const refundReceiver = ethers.ZeroAddress;

    const txHash = await safe.getTransactionHash(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);

    const signatureBytes = await owner.signMessage(ethers.getBytes(txHash));
    let signature = signatureBytes;
    const sig = ethers.Signature.from(signatureBytes);
    if (sig.v === 27 || sig.v === 28) {
      signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]);
    } else if (sig.v === 0 || sig.v === 1) {
      signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 27 + 4, 1)]);
    }

    const txEnableModule = await safe.execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signature, overrides);
    await txEnableModule.wait();

    const isEnabled = await safe.isModuleEnabled(directModuleAddress);
    expect(isEnabled).to.be.true;
  });

  it("should execute a transaction from DirectModule to Safe", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };

    // Optional: Fund the Safe (not strictly necessary for changeThreshold but good practice)
    const fundTx = await (owner as Signer).sendTransaction({
      to: safeAddress,
      value: ethers.parseEther("0.1"), // Sent a smaller amount as it's not the focus
      ...overrides,
    });
    await fundTx.wait();

    // 1. Verify initial threshold
    const initialThreshold = await safe.getThreshold();
    expect(initialThreshold).to.equal(1, "Initial threshold should be 1");

    // 2. Prepare the call to safe.changeThreshold(1)
    const newThreshold = 1;
    const targetTxTo = safeAddress;
    const targetTxValue = 0;
    const targetTxData = safe.interface.encodeFunctionData("changeThreshold", [newThreshold]);
    const targetTxOperation = 0;

    const tx = await directModule.executeTransaction(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides);

    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1, "Transaction to DirectModule should succeed");

    //Check for events
    let foundTransactionExecuted = false;
    let foundChangedThreshold = false;

    for (const log of receipt.logs) {
      try {
        const directModuleEvent = directModule.interface.parseLog(log as any);
        if (directModuleEvent && directModuleEvent.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          expect(directModuleEvent.args.to).to.equal(targetTxTo);
          expect(directModuleEvent.args.value).to.equal(targetTxValue);
          expect(directModuleEvent.args.data).to.equal(targetTxData);
          expect(directModuleEvent.args.operation).to.equal(targetTxOperation);
        }
      } catch (e) {
        console.log(e);
      }

      try {
        const safeEvent = safe.interface.parseLog(log as any);
        if (safeEvent && safeEvent.name === "ChangedThreshold") {
          foundChangedThreshold = true;
          expect(safeEvent.args.threshold).to.equal(newThreshold);
        }
      } catch (e) {
        console.log(e);
      }
    }

    expect(foundTransactionExecuted, "TransactionExecuted event from DirectModule not found").to.be.true;
    expect(foundChangedThreshold, "ChangedThreshold event from Safe not found").to.be.true;

    // Verify final threshold
    const finalThreshold = await safe.getThreshold();
    expect(finalThreshold).to.equal(newThreshold, "Final threshold should be updated (or remain the same if no change)");
  });

  it("should REVERT if a non-owner calls executeTransaction", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };

    const [, nonOwnerSigner] = await ethers.getSigners();
    const directModuleFromNonOwner = directModule.connect(nonOwnerSigner);

    const recipientAddress = await nonOwnerSigner.getAddress();
    const transferAmount = ethers.parseEther("0.1");
    const targetTxTo = recipientAddress;
    const targetTxValue = transferAmount;
    const targetTxData = "0x";
    const targetTxOperation = 0;

    await expect(directModuleFromNonOwner.executeTransaction(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides)).to.be.revertedWith("DirectModule: Caller is not a Safe owner");
  });

  it("should allow Safe to send ETH to an EOA via DirectModule", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };
    const [, recipientSigner] = await ethers.getSigners();
    const recipientAddress = await recipientSigner.getAddress();
    const transferAmount = ethers.parseEther("0.5");

    const fundTx = await (owner as Signer).sendTransaction({
      to: safeAddress,
      value: ethers.parseEther("1.0"),
      ...overrides,
    });
    await fundTx.wait();
    const initialSafeBalance = await ethers.provider.getBalance(safeAddress);
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);

    const targetTxTo = recipientAddress;
    const targetTxValue = transferAmount;
    const targetTxData = "0x";
    const targetTxOperation = 0;

    const execTx = await directModule.connect(owner).executeTransaction(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides);
    const receipt = await execTx.wait();

    expect(receipt.status).to.equal(1, "Transaction to DirectModule should succeed");

    let foundTransactionExecuted = false;
    for (const log of receipt.logs) {
      try {
        const parsedLog = directModule.interface.parseLog(log as any);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          expect(parsedLog.args.to).to.equal(targetTxTo);
          expect(parsedLog.args.value).to.equal(targetTxValue);
          expect(parsedLog.args.data).to.equal(targetTxData);
          expect(parsedLog.args.operation).to.equal(targetTxOperation);
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "TransactionExecuted event from DirectModule not found").to.be.true;

    const finalSafeBalance = await ethers.provider.getBalance(safeAddress);
    const finalRecipientBalance = await ethers.provider.getBalance(recipientAddress);

    expect(finalRecipientBalance).to.equal(initialRecipientBalance + transferAmount);
    expect(finalSafeBalance).to.be.lessThan(initialSafeBalance);
  });

  it("should allow Safe to add a new owner with new threshold via DirectModule", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };
    const [, , newOwnerSigner] = await ethers.getSigners();
    const newOwnerAddress = await newOwnerSigner.getAddress();
    const newThreshold = 2;

    expect(await safe.isOwner(newOwnerAddress)).to.be.false;

    const targetTxTo = safeAddress;
    const targetTxValue = 0;
    const targetTxData = safe.interface.encodeFunctionData("addOwnerWithThreshold", [newOwnerAddress, newThreshold]);
    const targetTxOperation = 0;

    const execTx = await directModule.connect(owner).executeTransaction(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides);
    const receipt = await execTx.wait();
    expect(receipt.status).to.equal(1, "addOwnerWithThreshold transaction via DirectModule should succeed");

    let foundTransactionExecuted = false;
    for (const log of receipt.logs) {
      try {
        const parsedLog = directModule.interface.parseLog(log as any);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "TransactionExecuted event from DirectModule not found").to.be.true;

    let foundAddedOwner = false;
    let foundChangedThreshold = false;
    for (const log of receipt.logs) {
      try {
        const parsedLog = safe.interface.parseLog(log as any);
        if (parsedLog) {
          if (parsedLog.name === "AddedOwner" && parsedLog.args.owner === newOwnerAddress) {
            foundAddedOwner = true;
          }
          if (parsedLog.name === "ChangedThreshold" && parsedLog.args.threshold.toString() === newThreshold.toString()) {
            foundChangedThreshold = true;
          }
        }
      } catch (e) {}
    }
    expect(foundAddedOwner, "AddedOwner event from Safe not found or wrong owner").to.be.true;
    expect(foundChangedThreshold, "ChangedThreshold event from Safe not found or wrong threshold").to.be.true;

    expect(await safe.isOwner(newOwnerAddress)).to.be.true;
    expect(await safe.getThreshold()).to.equal(newThreshold);

    const newThresholdBack = 1;
    const targetTxData2 = safe.interface.encodeFunctionData("changeThreshold", [newThresholdBack]);
    const execTx2 = await directModule.connect(newOwnerSigner).executeTransaction(targetTxTo, targetTxValue, targetTxData2, targetTxOperation, overrides);
    const receipt2 = await execTx2.wait();
    expect(receipt2.status).to.equal(1, "New owner should be able to execute transaction via DirectModule");
    expect(await safe.getThreshold()).to.equal(newThresholdBack);
  });

  it("should allow Safe to remove an owner via DirectModule and verify access", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };
    const [, , tempOwnerSigner] = await ethers.getSigners();
    const tempOwnerAddress = await tempOwnerSigner.getAddress();

    const addOwnerTxData = safe.interface.encodeFunctionData("addOwnerWithThreshold", [tempOwnerAddress, 2]);
    const addOwnerExecTx = await directModule.connect(owner).executeTransaction(safeAddress, 0, addOwnerTxData, 0, overrides);
    await addOwnerExecTx.wait();
    expect(await safe.isOwner(tempOwnerAddress)).to.be.true;
    expect(await safe.getThreshold()).to.equal(2);

    // Original owner is `ownerAddress`, new one is `tempOwnerAddress`.
    let prevOwner: string;
    if (ownerAddress.toLowerCase() < tempOwnerAddress.toLowerCase()) {
      prevOwner = ownerAddress;
    } else {
      prevOwner = tempOwnerAddress;
    }

    const currentOwners = await safe.getOwners();
    let ownerToRemove = ownerAddress;
    let prevOwnerForRemoval: string = "";

    if (currentOwners[0].toLowerCase() === ownerToRemove.toLowerCase()) {
      prevOwnerForRemoval = "0x0000000000000000000000000000000000000001";
    } else {
      for (let i = 0; i < currentOwners.length; i++) {
        if (currentOwners[i].toLowerCase() === ownerToRemove.toLowerCase()) {
          prevOwnerForRemoval = currentOwners[i - 1];
          break;
        }
      }
      if (prevOwnerForRemoval === "") {
        throw new Error("Could not determine prevOwner for removal logic. Owner to remove not found in current owners list, or it was the first owner and not handled by SENTINEL logic correctly.");
      }
    }

    const newThresholdAfterRemoval = 1;
    const removeOwnerTxData = safe.interface.encodeFunctionData("removeOwner", [prevOwnerForRemoval!, ownerToRemove, newThresholdAfterRemoval]);

    // tempOwnerSigner (now a valid owner) executes the removal of original `owner`
    const removeOwnerExecTx = await directModule.connect(tempOwnerSigner).executeTransaction(safeAddress, 0, removeOwnerTxData, 0, overrides);
    await removeOwnerExecTx.wait();

    expect(await safe.isOwner(ownerAddress)).to.be.false;
    expect(await safe.isOwner(tempOwnerAddress)).to.be.true;
    expect(await safe.getThreshold()).to.equal(newThresholdAfterRemoval);

    // Original owner (owner) should NOT be able to use DirectModule
    await expect(directModule.connect(owner).executeTransaction(safeAddress, 0, "0x", 0, overrides)).to.be.revertedWith("DirectModule: Caller is not a Safe owner");

    const finalThresholdTxData = safe.interface.encodeFunctionData("changeThreshold", [1]);
    const finalExecTx = await directModule.connect(tempOwnerSigner).executeTransaction(safeAddress, 0, finalThresholdTxData, 0, overrides);
    await finalExecTx.wait();
    expect(await safe.getThreshold()).to.equal(1);
  });

  it("should return false and not emit TransactionExecuted if Safe's internal tx fails", async function () {
    const overrides = {
      gasLimit: 30000000,
      gasPrice: ethers.parseUnits("30", "gwei"),
    };

    const initialThreshold = await safe.getThreshold();
    const initialOwnerCount = (await safe.getOwners()).length;

    const invalidThreshold = 0;
    const targetTxTo = safeAddress;
    const targetTxValue = 0;
    const targetTxData = safe.interface.encodeFunctionData("changeThreshold", [invalidThreshold]);
    const targetTxOperation = 0;

    const returnedSuccess = await directModule.connect(owner).executeTransaction.staticCall(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides);
    expect(returnedSuccess).to.be.false;

    const tx = await directModule.connect(owner).executeTransaction(targetTxTo, targetTxValue, targetTxData, targetTxOperation, overrides);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1, "Transaction to DirectModule should still succeed at EVM level");

    let foundTransactionExecuted = false;
    for (const log of receipt.logs) {
      try {
        const parsedLog = directModule.interface.parseLog(log as any);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "TransactionExecuted event from DirectModule should NOT be found when internal Safe tx fails").to.be.false;

    expect(await safe.getThreshold()).to.equal(initialThreshold, "Safe threshold should not have changed");

    const invalidThreshold2 = initialOwnerCount + 1;
    const targetTxData2 = safe.interface.encodeFunctionData("changeThreshold", [invalidThreshold2]);

    const returnedSuccess2 = await directModule.connect(owner).executeTransaction.staticCall(targetTxTo, targetTxValue, targetTxData2, targetTxOperation, overrides);
    expect(returnedSuccess2).to.be.false;

    const tx2 = await directModule.connect(owner).executeTransaction(targetTxTo, targetTxValue, targetTxData2, targetTxOperation, overrides);
    const receipt2 = await tx2.wait();
    expect(receipt2.status).to.equal(1);

    let foundTransactionExecuted2 = false;
    for (const log of receipt2.logs) {
      try {
        const parsedLog = directModule.interface.parseLog(log as any);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted2 = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted2, "TransactionExecuted event should not be emitted on second invalid threshold change").to.be.false;
    expect(await safe.getThreshold()).to.equal(initialThreshold, "Safe threshold should still not have changed");
  });
});
