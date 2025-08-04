import { expect } from 'chai'
import { ethers, network } from 'hardhat'
import hre from 'hardhat'
import { ContractFactory, Contract, BaseContract, Signature } from 'ethers'
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { SafeProxyFactory, SafeL2, Delay } from '../typechain-types'

const SAFE_L2_ADDRESS = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
const SAFE_PROXY_FACTORY_ADDRESS = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
const COMPATIBILITY_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'

describe('Delay Module with Gnosis Safe (Fork Test)', async () => {
  const cooldown = 60
  const expiration = 3600

  let deployer: HardhatEthersSigner, user1: HardhatEthersSigner
  let delay_factory: ContractFactory

  before(async function() {
    await hre.network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x1"])
    await hre.network.provider.send("evm_setAutomine", [true])

    const signers = await ethers.getSigners()
    deployer = signers[0]
    user1 = signers[1]

    // @ts-ignore
    delay_factory = await ethers.getContractFactory("Delay")
  })

  async function setupSafeWithDelay(): Promise<{ safe: SafeL2, delay: Delay, deployer: HardhatEthersSigner, user1: HardhatEthersSigner }> {
    const factory = await ethers.getContractAt("SafeProxyFactory", SAFE_PROXY_FACTORY_ADDRESS, deployer) as SafeProxyFactory
    const singleton = await ethers.getContractAt("SafeL2", SAFE_L2_ADDRESS, deployer) as SafeL2
        
    const owners = [deployer.address] // Single owner 
    const threshold = 1
    
    const setupData = singleton.interface.encodeFunctionData("setup", [
      owners,
      threshold,
      ethers.ZeroAddress,
      "0x",
      COMPATIBILITY_FALLBACK_HANDLER,
      ethers.ZeroAddress,
      0,
      ethers.ZeroAddress
    ])
    
    const saltNonce = ethers.hexlify(ethers.randomBytes(32))
    
    const tx = await factory.createProxyWithNonce(
      await singleton.getAddress(),
      setupData,
      saltNonce
    )
    
    const receipt = await tx.wait()
    if (!receipt) {
        throw new Error("Transaction receipt is null")
    }
    
    let safeAddress = ""
    
    console.log("Parsing logs to find Safe address...")
    
    // First check for event by topics and eventName
    if (receipt.logs) {
      // Loop through all logs and try different parsing methods
      for (const log of receipt.logs) {
        // 1. Try to find by topic hash
        if (log.topics && log.topics[0] === ethers.id('ProxyCreation(address,address)')) {
          safeAddress = ethers.getAddress(ethers.dataSlice(log.topics[1], 12))
          console.log("Found Safe address by topic: ", safeAddress)
          break
        }
        
        // 2. Try eventName if available
        if ((log as any).eventName === 'ProxyCreation' && (log as any).args?.proxy) {
          safeAddress = (log as any).args.proxy
          console.log("Found Safe address by eventName: ", safeAddress)
          break
        }
        
        // 3. Try parsing log directly
        try {
          const parsedLog = factory.interface.parseLog({ topics: log.topics, data: log.data })
          if (parsedLog && parsedLog.name === "ProxyCreation" && parsedLog.args.proxy) {
            safeAddress = parsedLog.args.proxy
            console.log("Found Safe address by parsing log: ", safeAddress)
            break
          }
        } catch (e) {
          // Silently ignore parsing errors
        }
      }
    }
    
    // If still not found, try getting it from static call
    if (!safeAddress) {
      try {
        console.log("Attempting to get Safe address via static call...")
        const proxyAddress = await factory.createProxyWithNonce.staticCall(
          await singleton.getAddress(),
          setupData,
          saltNonce
        )
        if (proxyAddress) {
          safeAddress = proxyAddress
          console.log("Found Safe address by static call: ", safeAddress)
        }
      } catch (e) {
        console.error("Static call failed:", e)
      }
    }
    
    if (!safeAddress) {
      throw new Error("Failed to find deployed Safe address from logs or static call")
    }
    
    console.log("Safe deployed at:", safeAddress)
    
    const safe = await ethers.getContractAt("SafeL2", safeAddress, deployer) as SafeL2
    
    console.log("Deploying Delay module...")
    // @ts-ignore
    const delay = await delay_factory.connect(deployer).deploy(
      deployer.address,
      safeAddress,
      safeAddress,
      cooldown,
      expiration
    ) as Delay
    await delay.waitForDeployment()
    
    const delayAddress = await delay.getAddress()
    console.log("Delay module deployed at:", delayAddress)
    
    console.log("Enabling Delay module on Safe...")
    
    const enableModuleData = safe.interface.encodeFunctionData("enableModule", [delayAddress])
    
    const currentSigner = await ethers.provider.getSigner(deployer.address)

    const safeNonce = await safe.nonce()
    const safeTx = {
      to: safeAddress,
      value: 0,
      data: enableModuleData,
      operation: 0,
      safeTxGas: 0, 
      baseGas: 0, 
      gasPrice: 0, 
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce: safeNonce 
    }
    
    const txHash = await safe.getTransactionHash(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      safeTx.nonce
    )
    
    const flatSignature = await currentSigner.signMessage(ethers.getBytes(txHash))
    
    const sig = Signature.from(flatSignature)
    const adjustedV = sig.v + 4
    const adjustedSignature = ethers.concat([sig.r, sig.s, ethers.toBeHex(adjustedV, 1)])

    await safe.execTransaction(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      adjustedSignature
    )
    
    const isEnabled = await safe.isModuleEnabled(delayAddress)
    console.log("Is Delay module enabled on Safe:", isEnabled)
    expect(isEnabled).to.be.true
    
    return { safe, delay, deployer, user1 }
  }

  // it('should set up Safe with Delay module correctly', async function() {
  //   this.timeout(120000)
    
  //   const { safe, delay } = await setupSafeWithDelay()
    
  //   const safeAddress = await safe.getAddress()
    
  //   expect(await delay.avatar()).to.equal(safeAddress)
  //   expect(await delay.txCooldown()).to.equal(cooldown)
  //   expect(await delay.txExpiration()).to.equal(expiration)
  //   expect(await delay.txExpiration()).to.equal(expiration)
  //   expect(await safe.isModuleEnabled(await delay.getAddress())).to.be.true
  // })

  // it('should execute a transaction through Delay module with cooldown', async function() {
  //   this.timeout(120000) // Increase timeout
    
  //   const { safe, delay } = await setupSafeWithDelay()
  //   const safeAddress = await safe.getAddress()
  //   const delayAddress = await delay.getAddress()
    
  //   // Check initial state
  //   // @ts-ignore
  //   expect(await delay.queueNonce()).to.equal(0) // Function call
  //   // @ts-ignore
  //   expect(await delay.txNonce()).to.equal(0)    // Function call
    
  //   // Prepare a transaction for the Safe to execute later (e.g., sending 0 ETH to user1)
  //   const targetTxTo = user1.address
  //   const targetTxValue = 0
  //   const targetTxData = '0x' 
  //   const targetTxOperation = 0 // CALL
    
  //   console.log("Queueing transaction through Delay module via Safe...")
    
  //   const queueTxData = delay.interface.encodeFunctionData(
  //     "execTransactionFromModule", 
  //     [targetTxTo, targetTxValue, targetTxData, targetTxOperation]
  //   )
    
  //   const currentSigner = await ethers.provider.getSigner(deployer.address)
  //   const safeNonceQueue = await safe.nonce()

  //   const safeTxToQueue = {
  //     to: delayAddress, 
  //     value: 0,
  //     data: queueTxData, 
  //     operation: 0, // CALL
  //     safeTxGas: 3000000, // Increased safeTxGas further
  //     baseGas: 50000,      // Set baseGas to a non-zero value
  //     gasPrice: 0,
  //     gasToken: ethers.ZeroAddress,
  //     refundReceiver: ethers.ZeroAddress,
  //     nonce: safeNonceQueue
  //   }
    
  //   // Calculate transaction hash for signing
  //   const txHashToQueue = await safe.getTransactionHash(
  //     safeTxToQueue.to,
  //     safeTxToQueue.value,
  //     safeTxToQueue.data,
  //     safeTxToQueue.operation,
  //     safeTxToQueue.safeTxGas,
  //     safeTxToQueue.baseGas,
  //     safeTxToQueue.gasPrice,
  //     safeTxToQueue.gasToken,
  //     safeTxToQueue.refundReceiver,
  //     safeTxToQueue.nonce
  //   )
    
  //   const signatureToQueueRawFlat = await currentSigner.signMessage(ethers.getBytes(txHashToQueue))
  //   const sigQueue = Signature.from(signatureToQueueRawFlat)
  //   const adjustedVQueue = sigQueue.v + 4
  //   const adjustedSignatureToQueue = ethers.concat([sigQueue.r, sigQueue.s, ethers.toBeHex(adjustedVQueue, 1)])
    
  //   console.log("Executing Safe transaction to queue in Delay module...")
  //   const queueTxResponse = await safe.execTransaction(
  //     safeTxToQueue.to,
  //     safeTxToQueue.value,
  //     safeTxToQueue.data,
  //     safeTxToQueue.operation,
  //     safeTxToQueue.safeTxGas,
  //     safeTxToQueue.baseGas,
  //     safeTxToQueue.gasPrice,
  //     safeTxToQueue.gasToken,
  //     safeTxToQueue.refundReceiver,
  //     adjustedSignatureToQueue // Use adjusted signature
  //   )
    
  //   console.log("Waiting for queue transaction receipt...");
  //   const queueTxReceipt = await queueTxResponse.wait();
  //   console.log("Queue Transaction Receipt Status:", queueTxReceipt?.status);

  //   if (queueTxReceipt?.logs) {
  //     console.log("Logs found in queue transaction receipt:");
  //     let eventFound = false;
  //     for (const log of queueTxReceipt.logs) {
  //       try {
  //         // @ts-ignore
  //         const parsedLog = delay.interface.parseLog(log as { topics: string[]; data: string; });
  //         if (parsedLog && parsedLog.name === "TransactionAdded") {
  //           console.log("Found TransactionAdded event:", parsedLog.args);
  //           eventFound = true;
  //         }
  //       } catch (e) {
  //         // Not a log from the Delay interface, ignore
  //       }
  //     }
  //     if (!eventFound) {
  //       console.log("TransactionAdded event NOT found.");
  //     }
  //   } else {
  //     console.log("No logs found in queue transaction receipt.");
  //   }
    
  //   expect(await delay.queueNonce()).to.equal(1)
    
  //   await expect(
  //     delay.connect(deployer).executeNextTx(targetTxTo, targetTxValue, targetTxData, targetTxOperation)
  //   ).to.be.revertedWith('Transaction is still in cooldown')
    
  //   console.log("Advancing time by", cooldown + 5, "seconds...")
  //   await hre.network.provider.send('evm_increaseTime', [cooldown + 5])
  //   await hre.network.provider.send('evm_mine')
    
  //   console.log("Executing the delayed transaction...")
  //   await delay.connect(deployer).executeNextTx(
  //     targetTxTo, 
  //     targetTxValue, 
  //     targetTxData, 
  //     targetTxOperation
  //   )
    
  //   expect(await delay.txNonce()).to.equal(1)
  //   console.log("Transaction executed successfully through Delay module.")
  // })
}) 