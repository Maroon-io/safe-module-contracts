import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

function computeExpectedHash(
  safeAddress: string,
  targetAddress: string,
  value: number,
  data: string,
  eta: number,
  nonce: number
) {
  // Compute expected txHash using the same formula as contract
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "bytes", "uint256", "uint256"],
      [safeAddress, targetAddress, value, data, eta, nonce]
    )
  );
}

const MIN_DELAY = 60;
const MAX_DELAY = 3600;
const INITIAL_DELAY = 120;
const GRACE_PERIOD = 86400 * 2; // 2 days

const DEFAULT_MODULE_CONFIG = {
  initialDelay: INITIAL_DELAY,
  minDelay: MIN_DELAY,
  maxDelay: MAX_DELAY,
  gracePeriod: GRACE_PERIOD,
};

async function deploySafeTimelockModule(
  platform: string,
  config = DEFAULT_MODULE_CONFIG
) {
  const Factory = await ethers.getContractFactory("SafeTimelockModule");
  return Factory.deploy(
    platform,
    config.initialDelay,
    config.minDelay,
    config.maxDelay,
    config.gracePeriod
  );
}

describe("SafeTimelockModule Tests", function () {
  let timelockModule: any;
  let safe: any;
  let platform: HardhatEthersSigner;
  let owner1: HardhatEthersSigner;
  let nonOwner: HardhatEthersSigner;

  beforeEach(async function () {
    [platform, owner1, nonOwner] = await ethers.getSigners();

    // Deploy mock Safe
    const MockSafe = await ethers.getContractFactory("MockGnosisSafe");
    safe = await MockSafe.deploy([owner1.address, platform.address]);

    // Deploy module with platform address
    timelockModule = await deploySafeTimelockModule(platform.address);
  });

  describe("Constructor & Initialization", function () {
    it("Should reject zero address for platform", async function () {
      await expect(
        deploySafeTimelockModule(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid platform address");
    });

    it("Should reject invalid delay bounds", async function () {
      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          minDelay: 0,
        })
      ).to.be.revertedWith("Invalid min delay");

      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          minDelay: DEFAULT_MODULE_CONFIG.maxDelay + 1,
        })
      ).to.be.revertedWith("Min delay > max delay");

      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          maxDelay: GRACE_PERIOD * 20,
        })
      ).to.be.revertedWith("Max delay exceeds absolute limit");

      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          initialDelay: DEFAULT_MODULE_CONFIG.minDelay - 1,
        })
      ).to.be.revertedWith("Initial delay out of bounds");

      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          initialDelay: DEFAULT_MODULE_CONFIG.maxDelay + 1,
        })
      ).to.be.revertedWith("Initial delay out of bounds");

      await expect(
        deploySafeTimelockModule(platform.address, {
          ...DEFAULT_MODULE_CONFIG,
          gracePeriod: 3600,
        })
      ).to.be.revertedWith("Grace period too short");
    });

    it("Should set platform, delays, and immutables correctly", async function () {
      expect(await timelockModule.platform()).to.equal(platform.address);
      expect(await timelockModule.timelockDelay()).to.equal(INITIAL_DELAY);
      expect(await timelockModule.MIN_TIMELOCK_DELAY()).to.equal(MIN_DELAY);
      expect(await timelockModule.MAX_TIMELOCK_DELAY()).to.equal(MAX_DELAY);
      expect(await timelockModule.GRACE_PERIOD()).to.equal(GRACE_PERIOD);
    });

    it("Should emit events on deployment", async function () {
      const timelockModule = await deploySafeTimelockModule(platform.address);

      expect(await timelockModule.owner()).to.equal(platform.address);

      await expect(timelockModule.deploymentTransaction())
        .to.emit(timelockModule, "NewDelay")
        .withArgs(INITIAL_DELAY)
        .and.to.emit(timelockModule, "PlatformSet")
        .withArgs(platform.address);
    });
  });

  describe("Platform Address Management", function () {
    it("Owner should be able to set new platform address", async function () {
      const newPlatform = nonOwner.address;

      await expect(timelockModule.setPlatform(newPlatform))
        .to.emit(timelockModule, "PlatformSet")
        .withArgs(newPlatform);

      expect(await timelockModule.platform()).to.equal(newPlatform);
      expect(await timelockModule.getPlatform()).to.equal(newPlatform);
    });

    it("Should reject setting platform to zero address", async function () {
      await expect(
        timelockModule.setPlatform(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid platform address");
    });

    it("Should reject setting platform to same address", async function () {
      await expect(
        timelockModule.setPlatform(platform.address)
      ).to.be.revertedWith("Platform already set to this address");
    });

    it("Non-owner should NOT be able to set platform", async function () {
      await expect(
        timelockModule.connect(nonOwner).setPlatform(nonOwner.address)
      ).to.be.revertedWithCustomError(
        timelockModule,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Timelock Delay Management", function () {
    it("Owner should be able to set new delay", async function () {
      const newDelay = MIN_DELAY + 10;

      await expect(timelockModule.setTimelockDelay(newDelay))
        .to.emit(timelockModule, "NewDelay")
        .withArgs(newDelay);

      expect(await timelockModule.timelockDelay()).to.equal(newDelay);
      expect(await timelockModule.getTimelockDelay()).to.equal(newDelay);
    });

    it("Should reject delay below min", async function () {
      await expect(
        timelockModule.setTimelockDelay(MIN_DELAY - 1)
      ).to.be.revertedWith("Delay too short");
    });

    it("Should reject delay above max", async function () {
      await expect(
        timelockModule.setTimelockDelay(MAX_DELAY + 1)
      ).to.be.revertedWith("Delay too long");
    });

    it("Non-owner should NOT be able to set delay", async function () {
      await expect(
        timelockModule.connect(nonOwner).setTimelockDelay(MIN_DELAY)
      ).to.be.revertedWithCustomError(
        timelockModule,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("onlyNonPlatformOwner Modifier Tests", function () {
    it("Should reject if caller is not a Safe owner", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await expect(
        timelockModule
          .connect(nonOwner)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should reject if caller IS the platform address", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await expect(
        timelockModule
          .connect(platform)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Should allow Safe owner who is NOT platform", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.emit(timelockModule, "QueueTransaction");
    });
  });

  describe("Queue Transaction", function () {
    it("Should reject if ETA is before the minimum delay", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY - 1;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("ETA too early");
    });

    it("Should reject if ETA is exactly at minimum delay", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("ETA too early");
    });

    it("Should accept if ETA is past the minimum delay", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 1;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.emit(timelockModule, "QueueTransaction");
    });

    it("Platform should NOT be able to queue transaction", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await expect(
        timelockModule
          .connect(platform)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to queue transaction", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await expect(
        timelockModule
          .connect(nonOwner)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta)
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should allow queueing identical transactions (same params different times)", async function () {
      const eta1 = (await time.latest()) + INITIAL_DELAY + 10;
      const eta2 = (await time.latest()) + INITIAL_DELAY + 20;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta1);

      const nonce1 = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta2);

      const nonce2 = Number(await timelockModule.safeNonces(safe.target)) - 1;

      // Compute hashes for both tx
      const hash1 = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta1,
        nonce1
      );
      const hash2 = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta2,
        nonce2
      );

      expect(hash1).to.not.equal(hash2);
      expect(await timelockModule.queuedTransactions(hash1)).to.be.true;
      expect(await timelockModule.queuedTransactions(hash2)).to.be.true;

      expect(await timelockModule.safeNonces(safe.target)).eq(nonce2 + 1);
    });

    it("Should emit QueueTransaction event with correct args", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      const queuedTx = await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
        nonce
      );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.true;
      await expect(queuedTx)
        .to.emit(timelockModule, "QueueTransaction")
        .withArgs(
          expectedHash,
          safe.target,
          owner1.address,
          ethers.ZeroAddress,
          0,
          "0x",
          eta,
          nonce
        );
    });
  });

  describe("Cancel Transaction", function () {
    it("Platform should NOT be able to cancel", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;
      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await expect(
        timelockModule
          .connect(platform)
          .cancelTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to cancel", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await expect(
        timelockModule
          .connect(nonOwner)
          .cancelTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should allow owner to cancel queued transaction", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
        nonce
      );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.true;

      await expect(
        timelockModule
          .connect(owner1)
          .cancelTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      )
        .to.emit(timelockModule, "CancelTransaction")
        .withArgs(
          expectedHash,
          safe.target,
          owner1.address,
          ethers.ZeroAddress,
          0,
          "0x",
          eta,
          nonce
        );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.false;
    });
  });

  describe("Execute Transaction", function () {
    it("Should reject if transaction not queued", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;
      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta, 0)
      ).to.be.revertedWith("Transaction not queued");
    });

    it("Should reject if executed before ETA", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 100;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("ETA not reached");
    });

    it("Platform should NOT be able to execute", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await expect(
        timelockModule
          .connect(platform)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to execute", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await expect(
        timelockModule
          .connect(nonOwner)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should reject double execution", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await time.increaseTo(eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await timelockModule
        .connect(owner1)
        .executeTransaction(
          safe.target,
          ethers.ZeroAddress,
          0,
          "0x",
          eta,
          nonce
        );

      // Try to execute again
      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Transaction not queued");
    });

    it("Should reject if Safe execution fails", async function () {
      // Setup mock to make execTransactionFromModule return false
      await safe.setExecutionResult(false);

      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Transaction execution failed");
    });

    it("Should reject stale transaction", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 100;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      await time.increaseTo(eta + GRACE_PERIOD + 1);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      ).to.be.revertedWith("Transaction stale");
    });

    it("Should allow execution exactly at ETA", async function () {
      const eta = (await time.latest()) + INITIAL_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const nonce = Number(await timelockModule.safeNonces(safe.target)) - 1;

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
        nonce
      );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.true;

      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(
            safe.target,
            ethers.ZeroAddress,
            0,
            "0x",
            eta,
            nonce
          )
      )
        .to.emit(timelockModule, "ExecuteTransaction")
        .withArgs(
          expectedHash,
          safe.target,
          owner1.address,
          ethers.ZeroAddress,
          0,
          "0x",
          eta,
          nonce
        );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.false;
    });
  });

  describe("View Functions", function () {
    it("getPlatform should return platform address", async function () {
      expect(await timelockModule.getPlatform()).to.equal(platform.address);
    });

    it("getTimelockDelay should return delay", async function () {
      expect(await timelockModule.getTimelockDelay()).to.equal(INITIAL_DELAY);
    });
  });
});
