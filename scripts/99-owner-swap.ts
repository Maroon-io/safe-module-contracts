import { ethers } from "hardhat";

// Get provider
const provider = ethers.provider;

// Gnosis Safe deployment dependencies
import GnosisSafeArtifact from "@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json";

// Safe Configuration
const SAFE_OWNER_EOA = new ethers.Wallet(
  process.env.OWNER1_PRIVATE_KEY as string,
  provider
);
const SAFE_OWNER_PLATFORM_OLD = new ethers.Wallet(
  process.env.OWNER2_PRIVATE_KEY as string,
  provider
);

// Safe address involved in ownership swap
const globalConfig = {
  safeAddress: "0xAC2eBdA2F8F91279aFBA8260EB4A03D6a369F55F",
};

async function main() {
  const safe = new ethers.Contract(
    globalConfig.safeAddress,
    GnosisSafeArtifact.abi,
    provider
  );

  // Find old platform address in list of owners
  const owners: string[] = await safe.getOwners();
  console.log("owners", owners);

  // Since we already know that the old platform signer is at index 1
  const prevOwner = owners[0];

  // Encode `swapOwner` calldata
  const calldata = safe.interface.encodeFunctionData("swapOwner", [
    prevOwner,
    SAFE_OWNER_PLATFORM_OLD.address,
    "0xd5f051BF790323AA49096293252f3eFE5A81AC78",
  ]);
  console.log("calldata", calldata);

  const nonce = await safe.nonce();
  console.log("nonce", nonce);

  const txHash = await safe.getTransactionHash(
    globalConfig.safeAddress,
    0,
    calldata,
    0, // CALL
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    nonce
  );

  console.log("txHash", txHash);

  // Sign the hash with both current owners
  const sig1 = await SAFE_OWNER_EOA.signMessage(ethers.getBytes(txHash));
  const sig2 = await SAFE_OWNER_PLATFORM_OLD.signMessage(
    ethers.getBytes(txHash)
  );

  // Adjust the v value (last byte) by adding 4 to each signature
  // This converts eth_sign format to the format Safe expects
  const adjustSignature = (sig: string) => {
    const r = sig.slice(0, 66);
    const s = "0x" + sig.slice(66, 130);
    let v = parseInt(sig.slice(130, 132), 16);

    // Safe expects v to be 31 or 32 for eth_sign
    if (v < 27) v += 27;
    v += 4; // Convert to eth_sign format for Safe

    return r + s.slice(2) + v.toString(16).padStart(2, "0");
  };

  const adjustedSig1 = adjustSignature(sig1);
  const adjustedSig2 = adjustSignature(sig2);

  // Sort signatures by signer address
  const signatures =
    BigInt(SAFE_OWNER_EOA.address) < BigInt(SAFE_OWNER_PLATFORM_OLD.address)
      ? adjustedSig1 + adjustedSig2.slice(2)
      : adjustedSig2 + adjustedSig1.slice(2);

  const safeWithSender = safe.connect(SAFE_OWNER_EOA) as any;
  console.log("sigs", signatures);

  try {
    const tx = await safeWithSender.execTransaction.staticCall(
      globalConfig.safeAddress,
      0,
      calldata,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      signatures
    );

    console.log("swapOwner tx hash:", tx);
  } catch (err: any) {
    console.error("Simulation failed:", err.reason || err);
    process.exit(1);
  }
  // for debugging;
  // return;

  const tx = await safeWithSender.execTransaction(
    globalConfig.safeAddress,
    0,
    calldata,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    signatures
  );
  console.log("swapOwner tx hash:", tx.hash);

  await tx.wait();
  console.log("Owner swapped successfully");

  const newOwners: string[] = await safe.getOwners();
  console.log("New owners", newOwners);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
