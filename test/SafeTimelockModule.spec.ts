import { ethers, network } from "hardhat";
import { expect } from "chai";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
    SafeTimelockModule, SafeTimelockModule__factory, 
    FactorySafeTimeModule, FactorySafeTimeModule__factory
} from "../typechain-types";
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";
import GnosisSafeProxyFactoryArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/proxies/GnosisSafeProxyFactory.sol/GnosisSafeProxyFactory.json";
import { Contract, Interface, Log } from "ethers";

const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
const MIN_DELAY_SECONDS = 5;

// Mainnet Gnosis Safe addresses
const SAFE_SINGLETON_ADDRESS = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const SAFE_FACTORY_ADDRESS = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";

const gasOverrides = {
    gasLimit: 30000000, // High gas limit for fork tests
    gasPrice: ethers.parseUnits('30', 'gwei'), // Explicit gas price for fork stability
};

describe("SafeTimelockModule Forked Tests", function () {
    async function deploySafeAndTimelockFixture() {
        const [deployer, owner1, owner2, nonOwner, recipient, newAdmin, pendingAdminCandidate] = await ethers.getSigners();

        // Deploy FactorySafeTimeModule
        const factorySafeTimeModuleFactory = await ethers.getContractFactory("FactorySafeTimeModule", deployer) as FactorySafeTimeModule__factory;
        const factorySafeTimeModule = await factorySafeTimeModuleFactory.deploy(deployer.address, MIN_DELAY_SECONDS, gasOverrides); // deployer is admin of factory
        await factorySafeTimeModule.waitForDeployment();
        const factoryAddress = await factorySafeTimeModule.getAddress();

        // Connect to existing mainnet Gnosis Safe Factory and Singleton
        const safeFactory = new ethers.Contract(SAFE_FACTORY_ADDRESS, GnosisSafeProxyFactoryArtifact.abi, deployer);
        const safeSingleton = new ethers.Contract(SAFE_SINGLETON_ADDRESS, GnosisSafeArtifact.abi, deployer);
        
        const saltNonce = Date.now();
        const owners = [owner1.address, owner2.address];
        const threshold = 1;

        const setupData = safeSingleton.interface.encodeFunctionData("setup", [
            owners,
            threshold,
            ethers.ZeroAddress, // to
            "0x", // data
            ethers.ZeroAddress, // fallback handler
            ethers.ZeroAddress, // payment token
            0, // payment
            ethers.ZeroAddress, // payment receiver
        ]);

        const proxyAddress = await safeFactory.createProxyWithNonce.staticCall(SAFE_SINGLETON_ADDRESS, setupData, saltNonce, gasOverrides);
        const createProxyTx = await safeFactory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, setupData, saltNonce, gasOverrides);
        await createProxyTx.wait();
        
        const safe: Contract = new ethers.Contract(proxyAddress, GnosisSafeArtifact.abi, deployer);

        // Deploy SafeTimelockModule using the FactorySafeTimeModule
        // The deployer (admin of FactorySafeTimeModule) calls createSafeTimelockModule.
        // msg.sender (deployer) inside createSafeTimelockModule will be the owner of SafeTimelockModule.
        const avatar = await safe.getAddress();
        const target = await safe.getAddress();
        await factorySafeTimeModule.connect(deployer).createSafeTimelockModule(
            avatar, // _avatar
            target, // _target
            MIN_DELAY_SECONDS,       // _initialDelay
            gasOverrides
        );
        
        let timelockModuleAddress = "";
        // Get the last deployed module address from the factory
        const deployedModules = await factorySafeTimeModule.getSafeTimelockModuleAddresses();
        timelockModuleAddress = deployedModules[deployedModules.length - 1];
        if (!timelockModuleAddress || timelockModuleAddress === ethers.ZeroAddress) throw new Error("Failed to get module address from factory");
        
        const timelockModule = SafeTimelockModule__factory.connect(timelockModuleAddress, deployer);

        // Enable the module on the Safe (owner1 initiates as a Safe owner)
        const enableModuleData = safe.interface.encodeFunctionData("enableModule", [timelockModuleAddress]);
        const safeNonce = await safe.getFunction("nonce")(); 
        const txHashEnableModule = await safe.getFunction("getTransactionHash")( 
            await safe.getAddress(), 0, enableModuleData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, safeNonce
        );
        const signatureBytes = await owner1.signMessage(ethers.getBytes(txHashEnableModule));
        let signature = signatureBytes;
        const sig = ethers.Signature.from(signatureBytes);
        if (sig.v === 27 || sig.v === 28) {
            signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]);
        } else if (sig.v === 0 || sig.v === 1) { 
            signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 27 + 4, 1)]);
        }
        await safe.connect(owner1).getFunction("execTransaction")(
            await safe.getAddress(), 0, enableModuleData, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature, gasOverrides
        );

        expect(await safe.getFunction("isModuleEnabled")(timelockModuleAddress)).to.be.true;
        await deployer.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther("10"), ...gasOverrides });

        return { safe: safe as any, factorySafeTimeModule, timelockModule, owner1, owner2, nonOwner, recipient, deployer, newAdmin, pendingAdminCandidate };
    }

    describe("Deployment and Setup", function () {
        it("Should deploy the Safe and SafeTimelockModule correctly and enable the module", async function () {
            const { safe, timelockModule, owner1, deployer } = await loadFixture(deploySafeAndTimelockFixture);
            expect(await safe.isOwner(owner1.address)).to.be.true;
            expect(await timelockModule.owner()).to.equal(deployer.address); // Module owner is deployer
            expect(await timelockModule.timelockDelay()).to.equal(MIN_DELAY_SECONDS);
            expect(await safe.isModuleEnabled(await timelockModule.getAddress())).to.be.true;
        });
    });

    describe("Queueing and Executing ETH Transfer", function () {
        it("Owner should be able to queue and execute an ETH transfer to recipient", async function () {
            const { safe, timelockModule, owner1, recipient, deployer } = await loadFixture(deploySafeAndTimelockFixture);
            
            const initialThreshold = await safe.getFunction("getThreshold")();
            expect(initialThreshold).to.equal(1); // Fixture sets threshold to 1
            const newThreshold = 2; // Fixture has 2 owners

            const targetAddress = await safe.getAddress(); // Target is the Safe itself
            const value = 0; // No ETH transferred
            const data = safe.interface.encodeFunctionData("changeThreshold", [newThreshold]);
            const signature = "changeThreshold(uint256)"; // Explicitly provide the function signature

            const currentTimestamp = await time.latest();
            const eta = currentTimestamp + MIN_DELAY_SECONDS + 10; 

            const txHashStatic = await timelockModule.connect(owner1).queueTransaction.staticCall(targetAddress, value, signature, data, eta, gasOverrides);
            
            const queueTx = await timelockModule.connect(owner1).queueTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const queueReceipt = await queueTx.wait();
            
            let queuedLogDetails;
            if (queueReceipt?.logs) {
                for (const log of queueReceipt.logs) {
                    const logItem = log as any; // Keep as any for flexibility with Ethers v5/v6 Log/EventLog types
                    try {
                        const parsedLog = timelockModule.interface.parseLog(logItem);
                        if (parsedLog && parsedLog.name === "QueueTransaction") {
                            const eventArgs = parsedLog.args;
                            queuedLogDetails = {
                                id: `${logItem.transactionHash}-${logItem.index}`, // Used logItem.index
                                txHash: eventArgs.txHash,
                                target: eventArgs.target,
                                value: `${ethers.formatEther(eventArgs.value)} ETH`,
                                signature: eventArgs.signature,
                                data: eventArgs.data,
                                eta: `${eventArgs.eta} (${new Date(Number(eventArgs.eta) * 1000).toUTCString()})`,
                                transaction: {
                                    hash: logItem.transactionHash,
                                    blockNumber: logItem.blockNumber,
                                    logIndex: logItem.index // Used logItem.index
                                }
                            };
                            expect(eventArgs.txHash).to.equal(txHashStatic);
                            expect(eventArgs.target).to.equal(targetAddress);
                            break;
                        }
                    } catch (e) { /* Not the event we are looking for */ }
                }
            }
            expect(queuedLogDetails, "QueueTransaction event not found or parsed incorrectly").to.not.be.undefined;
            expect(await timelockModule.queuedTransactions(txHashStatic)).to.be.true;

            await expect(timelockModule.connect(owner1).executeTransaction(targetAddress, value, signature, data, eta, gasOverrides))
                .to.be.revertedWith("SafeTimelockModule::executeTransaction: ETA not reached.");

            await time.increaseTo(eta);
            
            expect(await safe.getFunction("getThreshold")()).to.equal(initialThreshold);

            const executeTx = await timelockModule.connect(owner1).executeTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const executeReceipt = await executeTx.wait();

            let executedLogDetails;
            if (executeReceipt?.logs) {
                for (const log of executeReceipt.logs) {
                    const logItem = log as any; // Keep as any
                    try {
                        const parsedLog = timelockModule.interface.parseLog(logItem);
                        if (parsedLog && parsedLog.name === "ExecuteTransaction") {
                            const eventArgs = parsedLog.args;
                            executedLogDetails = {
                                id: `${logItem.transactionHash}-${logItem.index}`, // Used logItem.index
                                txHash: eventArgs.txHash,
                                target: eventArgs.target,
                                value: `${ethers.formatEther(eventArgs.value)} ETH`,
                                signature: eventArgs.signature,
                                data: eventArgs.data,
                                eta: `${eventArgs.eta} (${new Date(Number(eventArgs.eta) * 1000).toUTCString()})`,
                                transaction: {
                                    hash: logItem.transactionHash,
                                    blockNumber: logItem.blockNumber,
                                    logIndex: logItem.index // Used logItem.index
                                }
                            };
                            expect(eventArgs.txHash).to.equal(txHashStatic);
                            break;
                        }
                    } catch (e) { /* Not the event we are looking for */ }
                }
            }
            expect(executedLogDetails, "ExecuteTransaction event not found or parsed incorrectly").to.not.be.undefined;

            expect(await timelockModule.queuedTransactions(txHashStatic)).to.be.false;
            
            const finalThreshold = await safe.getFunction("getThreshold")();
            expect(finalThreshold).to.equal(newThreshold);
        });

        it("Owner should be able to queue and execute addOwnerWithThreshold on Safe", async function () {
            const { safe, timelockModule, owner1, owner2, recipient, deployer } = await loadFixture(deploySafeAndTimelockFixture);
            
            // Initial state from fixture: owners = [owner1, owner2], threshold = 1
            const initialOwners = await safe.getFunction("getOwners")();
            expect(initialOwners).to.include(owner1.address);
            expect(initialOwners).to.include(owner2.address);
            expect(initialOwners).to.not.include(recipient.address);
            const initialThreshold = await safe.getFunction("getThreshold")();
            expect(initialThreshold).to.equal(1);

            const newOwnerToAdd = recipient.address;
            const newThresholdForAddOwner = 2;

            const targetAddress = await safe.getAddress(); 
            const value = 0; 
            const data = safe.interface.encodeFunctionData("addOwnerWithThreshold", [newOwnerToAdd, newThresholdForAddOwner]);
            const signature = "addOwnerWithThreshold(address,uint256)";

            const currentTimestamp = await time.latest();
            const eta = currentTimestamp + MIN_DELAY_SECONDS + 10; 

            const txHash = await timelockModule.connect(owner1).queueTransaction.staticCall(targetAddress, value, signature, data, eta, gasOverrides);
            
            const queueTx = await timelockModule.connect(owner1).queueTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const queueReceipt = await queueTx.wait();
            
            let queueEventFound = false;
            if (queueReceipt && queueReceipt.logs) {
                for (const log of queueReceipt.logs) {
                    try {
                        const parsed = timelockModule.interface.parseLog(log as any);
                        if (parsed && parsed.name === "QueueTransaction") {
                            queueEventFound = true;
                            expect(parsed.args.txHash).to.equal(txHash);
                            expect(parsed.args.target).to.equal(targetAddress);
                            expect(parsed.args.value).to.equal(value);
                            expect(parsed.args.signature).to.equal(signature);
                            expect(parsed.args.data).to.equal(data);
                            expect(parsed.args.eta).to.equal(eta);
                            break;
                        }
                    } catch (e) {}
                }
            }
            expect(queueEventFound).to.be.true;
            expect(await timelockModule.queuedTransactions(txHash)).to.be.true;

            await time.increaseTo(eta);
            
            const executeTx = await timelockModule.connect(owner1).executeTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const executeReceipt = await executeTx.wait();
            
            let executeEventFound = false;
            if (executeReceipt && executeReceipt.logs) {
                for (const log of executeReceipt.logs) {
                    try {
                        const parsed = timelockModule.interface.parseLog(log as any);
                        if (parsed && parsed.name === "ExecuteTransaction") {
                            executeEventFound = true;
                            expect(parsed.args.txHash).to.equal(txHash);
                            expect(parsed.args.target).to.equal(targetAddress);
                            expect(parsed.args.value).to.equal(value);
                            expect(parsed.args.signature).to.equal(signature);
                            expect(parsed.args.data).to.equal(data);
                            expect(parsed.args.eta).to.equal(eta);
                            break;
                        }
                    } catch (e) {}
                }
            }
            expect(executeEventFound).to.be.true;
            expect(await timelockModule.queuedTransactions(txHash)).to.be.false;
            
            // After execution, verify the new owner and threshold
            const finalOwners = await safe.getFunction("getOwners")();
            expect(finalOwners).to.include(newOwnerToAdd);
            const finalThreshold = await safe.getFunction("getThreshold")();
            expect(finalThreshold).to.equal(newThresholdForAddOwner);
        });

        it("Owner should be able to queue and execute removeOwner on Safe", async function () {
            const { safe, timelockModule, owner1, owner2, recipient, deployer } = await loadFixture(deploySafeAndTimelockFixture);

            // Initial state from fixture: owners = [owner1, owner2], threshold = 1
            // Step 1: Add recipient as a third owner and set threshold to 2 for this test setup.
            // This setup is done directly by owner1 for simplicity, not via timelock.
            const newOwnerSetup = recipient.address;
            const thresholdSetup = 2;
            const addOwnerData = safe.interface.encodeFunctionData("addOwnerWithThreshold", [newOwnerSetup, thresholdSetup]);
            const safeNonce = await safe.getFunction("nonce")();
            const txHashAddOwner = await safe.getFunction("getTransactionHash")(await safe.getAddress(), 0, addOwnerData, 0, 0,0,0, ethers.ZeroAddress, ethers.ZeroAddress, safeNonce);
            const sigBytesAdd = await owner1.signMessage(ethers.getBytes(txHashAddOwner));
            let signatureAdd = sigBytesAdd;
            const sigAdd = ethers.Signature.from(sigBytesAdd);
            // Corrected signature adjustment logic
            if (sigAdd.v === 27 || sigAdd.v === 28) {
                signatureAdd = ethers.concat([sigAdd.r, sigAdd.s, ethers.toBeHex(sigAdd.v + 4, 1)]);
            } else if (sigAdd.v === 0 || sigAdd.v === 1) { 
                signatureAdd = ethers.concat([sigAdd.r, sigAdd.s, ethers.toBeHex(sigAdd.v + 27 + 4, 1)]);
            }
            await safe.connect(owner1).getFunction("execTransaction")(await safe.getAddress(), 0, addOwnerData, 0, 0,0,0, ethers.ZeroAddress, ethers.ZeroAddress, signatureAdd, gasOverrides);

            expect(await safe.isOwner(newOwnerSetup)).to.be.true;
            expect(await safe.getFunction("getThreshold")()).to.equal(thresholdSetup);
            let currentOwners = await safe.getFunction("getOwners")(); // Should be [owner1, owner2, recipient] sorted

            // Step 2: Prepare to remove recipient.address and set threshold back to 1
            const ownerToRemove = recipient.address;
            const newThresholdForRemoveOwner = 1;
            let prevOwner;
            const sortedOwners = [...currentOwners].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            const ownerIndex = sortedOwners.findIndex(o => o.toLowerCase() === ownerToRemove.toLowerCase());

            if (ownerIndex === 0) {
                prevOwner = "0x0000000000000000000000000000000000000001"; // SENTINEL_OWNERS
            } else if (ownerIndex > 0) {
                prevOwner = sortedOwners[ownerIndex - 1];
            } else {
                throw new Error("Owner to remove not found in sorted list");
            }

            const targetAddress = await safe.getAddress();
            const value = 0;
            const data = safe.interface.encodeFunctionData("removeOwner", [prevOwner, ownerToRemove, newThresholdForRemoveOwner]);
            const signature = "removeOwner(address,address,uint256)";

            const currentTimestamp = await time.latest();
            const eta = currentTimestamp + MIN_DELAY_SECONDS + 10;

            const txHashQueue = await timelockModule.connect(owner1).queueTransaction.staticCall(targetAddress, value, signature, data, eta, gasOverrides);
            
            const queueTx = await timelockModule.connect(owner1).queueTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const queueReceipt = await queueTx.wait();
            
            let queueEventFound = false;
            if (queueReceipt && queueReceipt.logs) {
                for (const log of queueReceipt.logs) {
                    try {
                        const parsed = timelockModule.interface.parseLog(log as any);
                        if (parsed && parsed.name === "QueueTransaction") {
                            queueEventFound = true;
                            expect(parsed.args.txHash).to.equal(txHashQueue);
                            expect(parsed.args.target).to.equal(targetAddress);
                            expect(parsed.args.value).to.equal(value);
                            expect(parsed.args.signature).to.equal(signature);
                            expect(parsed.args.data).to.equal(data);
                            expect(parsed.args.eta).to.equal(eta);
                            break;
                        }
                    } catch (e) {}
                }
            }
            expect(queueEventFound).to.be.true;
            expect(await timelockModule.queuedTransactions(txHashQueue)).to.be.true;

            await time.increaseTo(eta);

            const executeTx = await timelockModule.connect(owner1).executeTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            const executeReceipt = await executeTx.wait();
            
            let executeEventFound = false;
            if (executeReceipt && executeReceipt.logs) {
                for (const log of executeReceipt.logs) {
                    try {
                        const parsed = timelockModule.interface.parseLog(log as any);
                        if (parsed && parsed.name === "ExecuteTransaction") {
                            executeEventFound = true;
                            expect(parsed.args.txHash).to.equal(txHashQueue);
                            expect(parsed.args.target).to.equal(targetAddress);
                            expect(parsed.args.value).to.equal(value);
                            expect(parsed.args.signature).to.equal(signature);
                            expect(parsed.args.data).to.equal(data);
                            expect(parsed.args.eta).to.equal(eta);
                            break;
                        }
                    } catch (e) {}
                }
            }
            expect(executeEventFound).to.be.true;
            expect(await timelockModule.queuedTransactions(txHashQueue)).to.be.false;

            // Step 3: Verify owner is removed and threshold is updated
            expect(await safe.isOwner(ownerToRemove)).to.be.false;
            const finalOwners = await safe.getFunction("getOwners")();
            expect(finalOwners).to.not.include(ownerToRemove);
            expect(finalOwners.length).to.equal(sortedOwners.length - 1);
            const finalThreshold = await safe.getFunction("getThreshold")();
            expect(finalThreshold).to.equal(newThresholdForRemoveOwner);
        });
    });
    
    describe("Access Control for Queue and Execute", function () {
        it("Non-owner should NOT be able to queue a transaction", async function () {
            const { timelockModule, nonOwner, recipient } = await loadFixture(deploySafeAndTimelockFixture);
            const transferAmount = ethers.parseEther("0.1");
            const eta = (await time.latest()) + MIN_DELAY_SECONDS + 10;

            await expect(
                timelockModule.connect(nonOwner).queueTransaction(recipient.address, transferAmount, "", "0x", eta, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule: Caller is not a Safe owner");
        });

        it("Non-owner should NOT be able to execute a transaction", async function () {
            const { timelockModule, owner1, nonOwner, recipient } = await loadFixture(deploySafeAndTimelockFixture);
            const transferAmount = ethers.parseEther("0.1");
            const targetAddress = recipient.address;
            const value = transferAmount;
            const data = "0x";
            const signature = "";
            const eta = (await time.latest()) + MIN_DELAY_SECONDS + 10;

            await timelockModule.connect(owner1).queueTransaction(targetAddress, value, signature, data, eta, gasOverrides);
            await time.increaseTo(eta);

            await expect(
                timelockModule.connect(nonOwner).executeTransaction(targetAddress, value, signature, data, eta, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule: Caller is not a Safe owner");
        });
         it("Should NOT execute if ETA not reached", async () => {
            const { timelockModule, owner1, recipient } = await loadFixture(deploySafeAndTimelockFixture);
            const eta = await time.latest() + MIN_DELAY_SECONDS + 100;
            await timelockModule.connect(owner1).queueTransaction(recipient.address, 0, "", "0x", eta, gasOverrides);
            await expect(
                 timelockModule.connect(owner1).executeTransaction(recipient.address, 0, "", "0x", eta, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule::executeTransaction: ETA not reached.");
        });


        it("Should NOT execute a cancelled transaction", async () => {
            const { timelockModule, owner1, recipient } = await loadFixture(deploySafeAndTimelockFixture);
            const eta = (await time.latest()) + MIN_DELAY_SECONDS + 10;
            const target = recipient.address;
            const value = 0;
            const signature = "";
            const data = "0x";

            const txHashToQueue = await timelockModule.connect(owner1).queueTransaction.staticCall(target, value, signature, data, eta, gasOverrides);
            await timelockModule.connect(owner1).queueTransaction(target, value, signature, data, eta, gasOverrides);
            expect(await timelockModule.queuedTransactions(txHashToQueue)).to.be.true;

            const cancelTx = await timelockModule.connect(owner1).cancelTransaction(target, value, signature, data, eta, gasOverrides);
            const cancelReceipt = await cancelTx.wait();

            let cancelEventFound = false;
            if (cancelReceipt && cancelReceipt.logs) {
                for (const log of cancelReceipt.logs) {
                    try {
                        const parsed = timelockModule.interface.parseLog(log as any);
                        if (parsed && parsed.name === "CancelTransaction") {
                            cancelEventFound = true;
                            expect(parsed.args.txHash).to.equal(txHashToQueue);
                            break;
                        }
                    } catch (e) {}
                }
            }
            expect(cancelEventFound).to.be.true;
            expect(await timelockModule.queuedTransactions(txHashToQueue)).to.be.false;

            await time.increaseTo(eta);
            await expect(
                timelockModule.connect(owner1).executeTransaction(target, value, signature, data, eta, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule::executeTransaction: Transaction not queued.");
        });
    });
    
    describe("setTimelockDelay Access Control", function () {
        it("Non-avatar (even if module owner or safe owner) should NOT be able to setTimelockDelay", async function () {
            const { timelockModule, owner1, deployer } = await loadFixture(deploySafeAndTimelockFixture);
            const newDelay = MIN_DELAY_SECONDS + 100; // MIN_DELAY_SECONDS is the test constant

            // Assuming owner1 is module owner but not avatar
            await expect(
                timelockModule.connect(owner1).setTimelockDelay(newDelay, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule::setTimelockDelay: Call must come from avatar (Safe).");
            
            // deployer might be module owner if set that way, but also not avatar
            await expect(
                timelockModule.connect(deployer).setTimelockDelay(newDelay, gasOverrides)
            ).to.be.revertedWith("SafeTimelockModule::setTimelockDelay: Call must come from avatar (Safe).");
        });

        it("Avatar (Safe) should be able to setTimelockDelay", async function () {
            const { safe, timelockModule, owner1 } = await loadFixture(deploySafeAndTimelockFixture);
            const newActualModuleDelay = Number(await timelockModule.timelockDelay());
            const newDelayToSet = newActualModuleDelay + 100; 
            const timelockModuleAddress = await timelockModule.getAddress();

            const setDelayData = timelockModule.interface.encodeFunctionData("setTimelockDelay", [newDelayToSet]);
            
            const safeNonce = await safe.getFunction("nonce")();
            const txHashSetDelay = await safe.getFunction("getTransactionHash")(
                timelockModuleAddress, // to
                0,                      // value
                setDelayData,           // data
                0,                      // operation CALL
                0,0,0, ethers.ZeroAddress, ethers.ZeroAddress, // gas params
                safeNonce
            );
            
            const signatureBytes = await owner1.signMessage(ethers.getBytes(txHashSetDelay));
            let signature = signatureBytes;
            const sig = ethers.Signature.from(signatureBytes);
            if (sig.v === 27 || sig.v === 28) {
                signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 4, 1)]);
            } else if (sig.v === 0 || sig.v === 1) { 
                signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v + 27 + 4, 1)]);
            }

            await expect(safe.connect(owner1).getFunction("execTransaction")(
                timelockModuleAddress,
                0,
                setDelayData,
                0, // CALL
                0,0,0, ethers.ZeroAddress, ethers.ZeroAddress, // gas params
                signature,
                gasOverrides
            )).to.emit(timelockModule, "NewDelay").withArgs(newDelayToSet);

            expect(await timelockModule.timelockDelay()).to.equal(newDelayToSet);
        });
    });

    describe("FactorySafeTimeModule Admin Functionality", function() {
        it("Factory admin should be able to set a pending admin", async function() {
            const { factorySafeTimeModule, deployer, newAdmin } = await loadFixture(deploySafeAndTimelockFixture);
            expect(await factorySafeTimeModule.admin()).to.equal(deployer.address);
            await expect(factorySafeTimeModule.connect(deployer).setPendingAdmin(newAdmin.address))
                .to.not.be.reverted; // Basic check, can add event emission later
            expect(await factorySafeTimeModule.pendingAdmin()).to.equal(newAdmin.address);
        });

        it("Non-factory admin should NOT be able to set a pending admin", async function() {
            const { factorySafeTimeModule, owner1, newAdmin } = await loadFixture(deploySafeAndTimelockFixture);
            await expect(factorySafeTimeModule.connect(owner1).setPendingAdmin(newAdmin.address))
                .to.be.revertedWith("FactorySafeTimeModule: Only admin can set pending admin");
        });

        it("Pending admin should be able to accept admin role", async function() {
            const { factorySafeTimeModule, deployer, newAdmin } = await loadFixture(deploySafeAndTimelockFixture);
            await factorySafeTimeModule.connect(deployer).setPendingAdmin(newAdmin.address);
            await expect(factorySafeTimeModule.connect(newAdmin).acceptAdmin())
                .to.not.be.reverted; // Basic check
            expect(await factorySafeTimeModule.admin()).to.equal(newAdmin.address);
            expect(await factorySafeTimeModule.pendingAdmin()).to.equal(ethers.ZeroAddress);
        });

        it("Non-pending admin should NOT be able to accept admin role", async function() {
            const { factorySafeTimeModule, deployer, owner1, newAdmin } = await loadFixture(deploySafeAndTimelockFixture);
            await factorySafeTimeModule.connect(deployer).setPendingAdmin(newAdmin.address);
            await expect(factorySafeTimeModule.connect(owner1).acceptAdmin())
                .to.be.revertedWith("FactorySafeTimeModule: Only pending admin can accept admin");
        });

        it("Should NOT be able to accept admin role if no pending admin is set", async function() {
            const { factorySafeTimeModule, newAdmin } = await loadFixture(deploySafeAndTimelockFixture);
            expect(await factorySafeTimeModule.pendingAdmin()).to.not.equal(newAdmin.address); // Ensure it's not accidentally newAdmin
            await expect(factorySafeTimeModule.connect(newAdmin).acceptAdmin())
                .to.be.revertedWith("FactorySafeTimeModule: Only pending admin can accept admin");
        });
    });
}); 