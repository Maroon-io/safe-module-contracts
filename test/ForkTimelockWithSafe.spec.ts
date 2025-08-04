import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract, Signer, AbiCoder, Log } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Import ABIs
import SafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";
import SafeFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";
// We'll get Timelock and DirectModule artifacts via ethers.getContractFactory

// Safe contract addresses on mainnet (used for forking setup)
const SAFE_SINGLETON_ADDRESS = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const SAFE_FACTORY_ADDRESS = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";

const TIMELOCK_MIN_DELAY_FOR_TESTING = 10; // seconds

describe("Fork tests: Timelock with Safe via DirectModule", function () {
  let owner: Signer;
  let recipient: Signer;
  let ownerAddress: string;
  let recipientAddress: string;

  let safeFactory: Contract;
  let safeSingleton: Contract;
  let safe: Contract; // GnosisSafe instance
  let directModule: any; // Changed to any to bypass specific type issue for now
  let timelock: any;     // Changed to any to bypass specific type issue for now

  let safeAddress: string;
  let directModuleAddress: string;
  let timelockAddress: string;

  const overrides = {
    gasLimit: 30000000, // High gas limit for fork tests
    gasPrice: ethers.parseUnits('30', 'gwei'),
  };

  beforeEach(async function () {
    // 1. Forking Setup
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://mainnet.infura.io/v3/${process.env.INFURA_KEY || "ed367b18beef427e9d30387760f0d583"}`,
            blockNumber: 19000000, // Use a recent block
          },
        },
      ],
    });

    // 2. Get Signers
    [owner, recipient] = await ethers.getSigners();
    ownerAddress = await owner.getAddress();
    recipientAddress = await recipient.getAddress();

    // 3. Get Safe Factory and Singleton
    safeFactory = new ethers.Contract(SAFE_FACTORY_ADDRESS, SafeFactoryArtifact.abi, owner);
    safeSingleton = new ethers.Contract(SAFE_SINGLETON_ADDRESS, SafeArtifact.abi, owner);

    // 4. Deploy Gnosis Safe
    const owners = [ownerAddress];
    const threshold = 1;
    const saltNonce = Date.now();
    const setupData = safeSingleton.interface.encodeFunctionData("setup", [
      owners,
      threshold,
      ethers.ZeroAddress, "0x", ethers.ZeroAddress, ethers.ZeroAddress, 0, ethers.ZeroAddress,
    ]);
    safeAddress = await safeFactory.createProxyWithNonce.staticCall(SAFE_SINGLETON_ADDRESS, setupData, saltNonce);
    const txSafeDeploy = await safeFactory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, setupData, saltNonce, overrides);
    await txSafeDeploy.wait();
    safe = new ethers.Contract(safeAddress, SafeArtifact.abi, owner);

    // 5. Deploy DirectModule
    const DirectModuleFactory = await ethers.getContractFactory("DirectModule", owner);
    directModule = await DirectModuleFactory.deploy(ownerAddress, safeAddress, safeAddress, overrides);
    directModuleAddress = await directModule.getAddress();
    
    // 6. Enable DirectModule on Safe
    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [directModuleAddress]);
    const nonce = await safe.nonce();
    const txHashEnable = await safe.getTransactionHash(
      safeAddress, 0, enableModuleData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
    );
    const signatureBytes = await owner.signMessage(ethers.getBytes(txHashEnable));
    let signature = signatureBytes;
    const sig = ethers.Signature.from(signatureBytes);
    if (sig.v === 27 || sig.v === 28) {
      signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]);
    } else if (sig.v === 0 || sig.v === 1) {
      signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 27 + 4, 1)]);
    }
    const txEnableModule = await safe.execTransaction(
      safeAddress, 0, enableModuleData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature, overrides
    );
    await txEnableModule.wait();
    expect(await safe.isModuleEnabled(directModuleAddress)).to.be.true;

    // 7. Deploy Timelock with Safe as admin and short delay
    // For this deployment, we assume Timelock's MINIMUM_DELAY allows TIMELOCK_MIN_DELAY_FOR_TESTING
    // If not, Timelock.sol needs adjustment for tests or use a test-specific version.
    const TimelockFactory = await ethers.getContractFactory("Timelock", owner);
    timelock = await TimelockFactory.deploy(safeAddress, TIMELOCK_MIN_DELAY_FOR_TESTING, overrides);
    timelockAddress = await timelock.getAddress();
    expect(await timelock.admin()).to.equal(safeAddress);
    expect(await timelock.delay()).to.equal(TIMELOCK_MIN_DELAY_FOR_TESTING);
  });

  it("Safe should queue and execute an ETH transfer via Timelock using DirectModule", async function () {
    const transferAmount = ethers.parseEther("0.1");

    // Fund Timelock so it can make the transfer
    const fundTimelockTx = await owner.sendTransaction({ to: timelockAddress, value: transferAmount, ...overrides });
    await fundTimelockTx.wait();
    const initialTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    expect(initialTimelockBalance).to.equal(transferAmount);
    
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);

    // --- Queue Transaction ---
    const currentTimestamp = await time.latest();
    const eta = currentTimestamp + TIMELOCK_MIN_DELAY_FOR_TESTING + 5; // eta = now + delay + buffer

    const timelockQueueTxData = timelock.interface.encodeFunctionData("queueTransaction", [
      recipientAddress, // target for the Timelock's transaction
      transferAmount,   // value for the Timelock's transaction
      "",               // signature (empty for direct ETH transfer)
      "0x",             // data (empty for direct ETH transfer)
      eta
    ]);

    // DirectModule tells Safe to call Timelock.queueTransaction
    const queueTxThroughSafe = await directModule.connect(owner).executeTransaction(
      timelockAddress,    // target of Safe's transaction is Timelock
      0,                  // value for Safe's transaction
      timelockQueueTxData,// data for Safe's transaction
      0,                  // operation CALL
      overrides
    );
    const queueReceipt = await queueTxThroughSafe.wait();
    expect(queueReceipt.status).to.equal(1, "Queue transaction via DirectModule failed");

    // Check for QueueTransaction event from Timelock
    let queuedTxHash: string | undefined;
    for (const log of queueReceipt.logs as Log[]) {
      try {
        const parsedLog = timelock.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "QueueTransaction") {
          queuedTxHash = parsedLog.args.txHash;
          expect(parsedLog.args.target).to.equal(recipientAddress);
          expect(parsedLog.args.value).to.equal(transferAmount);
          expect(parsedLog.args.eta).to.equal(eta);
          break;
        }
      } catch (e) { /* Not a Timelock event */ }
    }
    expect(queuedTxHash, "QueueTransaction event not found or txHash missing").to.exist;
    expect(await timelock.queuedTransactions(queuedTxHash!)).to.be.true;
    
    // --- Wait for Delay ---
    await time.increaseTo(eta);

    // --- Execute Transaction ---
    const timelockExecuteTxData = timelock.interface.encodeFunctionData("executeTransaction", [
      recipientAddress,
      transferAmount,
      "",
      "0x",
      eta
    ]);

    // DirectModule tells Safe to call Timelock.executeTransaction
    const executeTxThroughSafe = await directModule.connect(owner).executeTransaction(
      timelockAddress,
      0,
      timelockExecuteTxData,
      0,
      overrides
    );
    const executeReceipt = await executeTxThroughSafe.wait();
    expect(executeReceipt.status).to.equal(1, "Execute transaction via DirectModule failed");

    // Check for ExecuteTransaction event from Timelock
    let executedEventFound = false;
    for (const log of executeReceipt.logs as Log[]) {
      try {
        const parsedLog = timelock.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "ExecuteTransaction") {
          expect(parsedLog.args.txHash).to.equal(queuedTxHash);
          expect(parsedLog.args.target).to.equal(recipientAddress);
          executedEventFound = true;
          break;
        }
      } catch (e) { /* Not a Timelock event */ }
    }
    expect(executedEventFound, "ExecuteTransaction event not found").to.be.true;
    expect(await timelock.queuedTransactions(queuedTxHash!)).to.be.false; // Should be cleared

    // Verify ETH transfer
    const finalRecipientBalance = await ethers.provider.getBalance(recipientAddress);
    expect(finalRecipientBalance).to.equal(initialRecipientBalance + transferAmount);
    const finalTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    expect(finalTimelockBalance).to.equal(0); // Timelock sent all its ETH
  });

  it("should NOT execute and return false if trying to execute a queued transaction before ETA", async function () {
    const transferAmount = ethers.parseEther("0.05");
    // Capture initial balances before any operations related to this specific test's tx
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);
    const preTestTimelockBalance = await ethers.provider.getBalance(timelockAddress);

    // Fund Timelock specifically for this transaction attempt
    await owner.sendTransaction({ to: timelockAddress, value: transferAmount, ...overrides });
    const postFundingTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    expect(postFundingTimelockBalance).to.equal(preTestTimelockBalance + transferAmount);

    const currentTimestamp = await time.latest();
    const eta = currentTimestamp + TIMELOCK_MIN_DELAY_FOR_TESTING + 5;

    const queueTarget = recipientAddress;
    const queueValue = transferAmount;
    const queueSignature = "";
    const queueData = "0x";

    const timelockQueueTxData = timelock.interface.encodeFunctionData("queueTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);
    const queueTx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockQueueTxData, 0, overrides);
    const queueReceipt = await queueTx.wait();
    expect(queueReceipt.status).to.equal(1);

    const txHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "string", "bytes", "uint256"],
        [queueTarget, queueValue, queueSignature, queueData, eta]
      )
    );
    expect(await timelock.queuedTransactions(txHash)).to.be.true;
    
    const timelockExecuteTxData = timelock.interface.encodeFunctionData("executeTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);

    const returnedSuccess = await directModule.connect(owner).executeTransaction.staticCall(
      timelockAddress, 0, timelockExecuteTxData, 0, overrides
    );
    expect(returnedSuccess).to.be.false;

    const tx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockExecuteTxData, 0, overrides);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    let foundTransactionExecuted = false;
    for (const log of receipt.logs as Log[]) {
      try {
        const parsedLog = directModule.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "DirectModule.TransactionExecuted should not be emitted").to.be.false;
    
    expect(await timelock.queuedTransactions(txHash)).to.be.true; // Still queued
    // Verify balances are unchanged after failed execution attempt
    expect(await ethers.provider.getBalance(recipientAddress)).to.equal(initialRecipientBalance, "Recipient balance should be unchanged");
    expect(await ethers.provider.getBalance(timelockAddress)).to.equal(postFundingTimelockBalance, "Timelock balance should be unchanged after failed exec");
  });

  it("should NOT execute and return false if trying to execute a queued transaction after GRACE_PERIOD (stale)", async function () {
    const transferAmount = ethers.parseEther("0.05");
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);
    const preTestTimelockBalance = await ethers.provider.getBalance(timelockAddress);

    await owner.sendTransaction({ to: timelockAddress, value: transferAmount, ...overrides });
    const postFundingTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    expect(postFundingTimelockBalance).to.equal(preTestTimelockBalance + transferAmount);

    const currentTimestamp = await time.latest();
    const eta = currentTimestamp + TIMELOCK_MIN_DELAY_FOR_TESTING + 5;
    const gracePeriod = await timelock.GRACE_PERIOD();

    const queueTarget = recipientAddress;
    const queueValue = transferAmount;
    const queueSignature = "";
    const queueData = "0x";
    
    const timelockQueueTxData = timelock.interface.encodeFunctionData("queueTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);
    await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockQueueTxData, 0, overrides);
    
    const txHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "string", "bytes", "uint256"],
        [queueTarget, queueValue, queueSignature, queueData, eta]
      )
    );
    expect(await timelock.queuedTransactions(txHash)).to.be.true;

    await time.increaseTo(eta + Number(gracePeriod) + 1);

    const timelockExecuteTxData = timelock.interface.encodeFunctionData("executeTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);

    const returnedSuccess = await directModule.connect(owner).executeTransaction.staticCall(
      timelockAddress, 0, timelockExecuteTxData, 0, overrides
    );
    expect(returnedSuccess).to.be.false;

    const tx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockExecuteTxData, 0, overrides);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    let foundTransactionExecuted = false;
    for (const log of receipt.logs as Log[]) {
      try {
        const parsedLog = directModule.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "DirectModule.TransactionExecuted should not be emitted").to.be.false;
    expect(await timelock.queuedTransactions(txHash)).to.be.true; // Still queued, not cleared by failed execution
    // Verify balances are unchanged after failed execution attempt
    expect(await ethers.provider.getBalance(recipientAddress)).to.equal(initialRecipientBalance, "Recipient balance should be unchanged");
    expect(await ethers.provider.getBalance(timelockAddress)).to.equal(postFundingTimelockBalance, "Timelock balance should be unchanged after failed exec");
  });

  it("should allow admin (Safe) to cancel a transaction and then execution should fail (return false)", async function () {
    const transferAmount = ethers.parseEther("0.05");
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);
    const preTestTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    
    await owner.sendTransaction({ to: timelockAddress, value: transferAmount, ...overrides });
    const postFundingTimelockBalance = await ethers.provider.getBalance(timelockAddress);
    expect(postFundingTimelockBalance).to.equal(preTestTimelockBalance + transferAmount);

    const currentTimestamp = await time.latest();
    const eta = currentTimestamp + TIMELOCK_MIN_DELAY_FOR_TESTING + 5;

    const queueTarget = recipientAddress;
    const queueValue = transferAmount;
    const queueSignature = "";
    const queueData = "0x";

    const timelockQueueTxData = timelock.interface.encodeFunctionData("queueTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);
    const queueTx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockQueueTxData, 0, overrides);
    await queueTx.wait();
    
    const txHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "string", "bytes", "uint256"],
        [queueTarget, queueValue, queueSignature, queueData, eta]
      )
    );
    expect(await timelock.queuedTransactions(txHash)).to.be.true;

    const timelockCancelTxData = timelock.interface.encodeFunctionData("cancelTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);
    const cancelTx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockCancelTxData, 0, overrides);
    const cancelReceipt = await cancelTx.wait();
    expect(cancelReceipt.status).to.equal(1);
    // DirectModule should emit TransactionExecuted for the successful cancellation call to Timelock
    let foundCancelExecuted = false;
     for (const log of cancelReceipt.logs as Log[]) {
      try {
        const parsedLog = directModule.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundCancelExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundCancelExecuted, "DirectModule.TransactionExecuted should be emitted for cancel").to.be.true;
    expect(await timelock.queuedTransactions(txHash)).to.be.false;


    await time.increaseTo(eta);
    const timelockExecuteTxData = timelock.interface.encodeFunctionData("executeTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);
    
    const returnedSuccess = await directModule.connect(owner).executeTransaction.staticCall(
        timelockAddress, 0, timelockExecuteTxData, 0, overrides
    );
    expect(returnedSuccess).to.be.false;

    const execTx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockExecuteTxData, 0, overrides);
    const execReceipt = await execTx.wait();
    expect(execReceipt.status).to.equal(1);
    
    let foundExecExecuted = false;
    for (const log of execReceipt.logs as Log[]) {
     try {
       const parsedLog = directModule.interface.parseLog(log);
       if (parsedLog && parsedLog.name === "TransactionExecuted") {
        foundExecExecuted = true;
         break;
       }
     } catch (e) {}
   }
   expect(foundExecExecuted, "DirectModule.TransactionExecuted should NOT be emitted for failed exec").to.be.false;
   // Verify balances are unchanged after failed execution attempt
   expect(await ethers.provider.getBalance(recipientAddress)).to.equal(initialRecipientBalance, "Recipient balance should be unchanged");
   // After cancellation, the funds are still in the Timelock if they were sent for this specific tx.
   expect(await ethers.provider.getBalance(timelockAddress)).to.equal(postFundingTimelockBalance, "Timelock balance should be unchanged after cancel and failed exec");
  });

  it("should NOT execute and return false if trying to execute a transaction that was never queued", async function () {
    const transferAmount = ethers.parseEther("0.05"); // This amount is not actually sent anywhere
    const currentTimestamp = await time.latest();
    const eta = currentTimestamp + TIMELOCK_MIN_DELAY_FOR_TESTING + 5;
    const initialRecipientBalance = await ethers.provider.getBalance(recipientAddress);
    const initialTimelockBalance = await ethers.provider.getBalance(timelockAddress); // Timelock not funded for this tx

    const queueTarget = recipientAddress;
    const queueValue = transferAmount;
    const queueSignature = "";
    const queueData = "0x";

    await time.increaseTo(eta); 

    const timelockExecuteTxData = timelock.interface.encodeFunctionData("executeTransaction", [
      queueTarget, queueValue, queueSignature, queueData, eta
    ]);

    const returnedSuccess = await directModule.connect(owner).executeTransaction.staticCall(
      timelockAddress, 0, timelockExecuteTxData, 0, overrides
    );
    expect(returnedSuccess).to.be.false;
    
    const tx = await directModule.connect(owner).executeTransaction(timelockAddress, 0, timelockExecuteTxData, 0, overrides);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    let foundTransactionExecuted = false;
    for (const log of receipt.logs as Log[]) {
      try {
        const parsedLog = directModule.interface.parseLog(log);
        if (parsedLog && parsedLog.name === "TransactionExecuted") {
          foundTransactionExecuted = true;
          break;
        }
      } catch (e) {}
    }
    expect(foundTransactionExecuted, "DirectModule.TransactionExecuted should not be emitted").to.be.false;
    // Verify balances are unchanged
    expect(await ethers.provider.getBalance(recipientAddress)).to.equal(initialRecipientBalance, "Recipient balance should be unchanged");
    expect(await ethers.provider.getBalance(timelockAddress)).to.equal(initialTimelockBalance, "Timelock balance should be unchanged as no tx was processed");
  });
}); 