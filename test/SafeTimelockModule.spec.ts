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
) {
  // Compute expected txHash using the same formula as contract
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "bytes", "uint256"],
      [safeAddress, targetAddress, value, data, eta],
    ),
  );
}

describe("SafeTimelockModule Tests", function () {
  let timelockModule: any;
  let safe: any;
  let platform: HardhatEthersSigner;
  let owner1: HardhatEthersSigner;
  let nonOwner: HardhatEthersSigner;
  const MIN_DELAY = 60;

  beforeEach(async function () {
    [platform, owner1, nonOwner] = await ethers.getSigners();

    // Deploy mock Safe
    const MockSafe = await ethers.getContractFactory("MockGnosisSafe");
    safe = await MockSafe.deploy([owner1.address, platform.address]);

    // Deploy module with platform address
    const SafeTimelockModule =
      await ethers.getContractFactory("SafeTimelockModule");
    timelockModule = await SafeTimelockModule.deploy(
      platform.address,
      MIN_DELAY,
    );
  });

  describe("Constructor & Initialization", function () {
    it("Should reject zero address for platform", async function () {
      const SafeTimelockModule =
        await ethers.getContractFactory("SafeTimelockModule");
      await expect(
        SafeTimelockModule.deploy(ethers.ZeroAddress, MIN_DELAY),
      ).to.be.revertedWith("Invalid platform address");
    });

    it("Should set platform and delay correctly", async function () {
      expect(await timelockModule.platform()).to.equal(platform.address);
      expect(await timelockModule.timelockDelay()).to.equal(MIN_DELAY);
    });

    it("Should emit events on deployment", async function () {
      const SafeTimelockModule =
        await ethers.getContractFactory("SafeTimelockModule");

      const timelockModule = await SafeTimelockModule.deploy(
        platform.address,
        MIN_DELAY,
      );

      await expect(timelockModule.deploymentTransaction())
        .to.emit(timelockModule, "NewDelay")
        .withArgs(MIN_DELAY)
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

    it("Non-owner should NOT be able to set platform", async function () {
      await expect(
        timelockModule.connect(nonOwner).setPlatform(nonOwner.address),
      ).to.be.revertedWithCustomError(
        timelockModule,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Timelock Delay Management", function () {
    it("Owner should be able to set new delay", async function () {
      const newDelay = 500;

      await expect(timelockModule.setTimelockDelay(newDelay))
        .to.emit(timelockModule, "NewDelay")
        .withArgs(newDelay);

      expect(await timelockModule.timelockDelay()).to.equal(newDelay);
      expect(await timelockModule.getTimelockDelay()).to.equal(newDelay);
    });

    it("Non-owner should NOT be able to set delay", async function () {
      await expect(
        timelockModule.connect(nonOwner).setTimelockDelay(500),
      ).to.be.revertedWithCustomError(
        timelockModule,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("onlyNonPlatformOwner Modifier Tests", function () {
    it("Should reject if caller is not a Safe owner", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await expect(
        timelockModule
          .connect(nonOwner)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should reject if caller IS the platform address", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await expect(
        timelockModule
          .connect(platform)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Should allow Safe owner who is NOT platform", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.emit(timelockModule, "QueueTransaction");
    });
  });

  describe("Queue Transaction", function () {
    it("Should reject if ETA is before the minimum delay", async function () {
      const eta = (await time.latest()) + MIN_DELAY - 1;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("ETA too early");
    });

    it("Should reject if ETA is exactly at minimum delay", async function () {
      const eta = (await time.latest()) + MIN_DELAY;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("ETA too early");
    });

    it("Should accept if ETA is past the minimum delay", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 1;

      await expect(
        timelockModule
          .connect(owner1)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.emit(timelockModule, "QueueTransaction");
    });

    it("Platform should NOT be able to queue transaction", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await expect(
        timelockModule
          .connect(platform)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to queue transaction", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await expect(
        timelockModule
          .connect(nonOwner)
          .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should allow queueing duplicate transactions (same params different times)", async function () {
      const eta1 = (await time.latest()) + MIN_DELAY + 10;
      const eta2 = (await time.latest()) + MIN_DELAY + 20;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta1);

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta2);

      // Compute hashes for both tx
      const hash1 = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta1,
      );
      const hash2 = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta2,
      );

      expect(hash1).to.not.equal(hash2);
      expect(await timelockModule.queuedTransactions(hash1)).to.be.true;
      expect(await timelockModule.queuedTransactions(hash2)).to.be.true;
    });

    it("Should emit QueueTransaction event with correct args", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      const queuedTx = await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
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
        );
    });
  });

  describe("Cancel Transaction", function () {
    it("Platform should NOT be able to cancel", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;
      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await expect(
        timelockModule
          .connect(platform)
          .cancelTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to cancel", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await expect(
        timelockModule
          .connect(nonOwner)
          .cancelTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller not Safe owner");
    });

    it("Should allow owner to cancel queued transaction", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
      );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.true;

      await expect(
        timelockModule
          .connect(owner1)
          .cancelTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
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
        );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.false;
    });
  });

  describe("Execute Transaction", function () {
    it("Should reject if transaction not queued", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;
      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Transaction not queued");
    });

    it("Should reject if executed before ETA", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 100;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("ETA not reached");
    });

    it("Platform should NOT be able to execute", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await expect(
        timelockModule
          .connect(platform)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller is the platform");
    });

    it("Non-Owner should NOT be able to execute", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await expect(
        timelockModule
          .connect(nonOwner)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Caller not Safe owner");
    });

    // move to last

    it("Should reject double execution", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await time.increaseTo(eta);

      await timelockModule
        .connect(owner1)
        .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      // Try to execute again
      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Transaction not queued");
    });

    it("Should reject if Safe execution fails", async function () {
      // Setup mock to make execTransactionFromModule return false
      await safe.setExecutionResult(false);

      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
      ).to.be.revertedWith("Transaction execution failed");
    });

    it("Should allow execution exactly at ETA", async function () {
      const eta = (await time.latest()) + MIN_DELAY + 10;

      await timelockModule
        .connect(owner1)
        .queueTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta);

      const expectedHash = computeExpectedHash(
        safe.target,
        ethers.ZeroAddress,
        0,
        "0x",
        eta,
      );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.true;

      await time.increaseTo(eta);

      await expect(
        timelockModule
          .connect(owner1)
          .executeTransaction(safe.target, ethers.ZeroAddress, 0, "0x", eta),
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
        );

      expect(await timelockModule.queuedTransactions(expectedHash)).to.be.false;
    });
  });

  describe("View Functions", function () {
    it("getPlatform should return platform address", async function () {
      expect(await timelockModule.getPlatform()).to.equal(platform.address);
    });

    it("getTimelockDelay should return delay", async function () {
      expect(await timelockModule.getTimelockDelay()).to.equal(MIN_DELAY);
    });
  });
});
