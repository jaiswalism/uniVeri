import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AcademicCertificateRegistry } from "../../typechain-types";
import { deriveBatchContentId, deriveLogicalBatchId } from "../../src/core/canonical";

describe("Milestone 3: Architecture D Smart Contract (AcademicCertificateRegistry)", function () {
  let registry: AcademicCertificateRegistry;
  let owner: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let unauthorized: HardhatEthersSigner;

  const ISSUER_ID = "did:edu:stanford";
  const SCHEMA_VERSION = "1.0.0";

  beforeEach(async function () {
    [owner, issuer, unauthorized] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AcademicCertificateRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();

    // Register issuer
    await registry.registerIssuer(ISSUER_ID, issuer.address);
  });

  it("Should allow owner to register authorized academic institutions", async function () {
    const issuerInfo = await registry.issuers(issuer.address);
    expect(issuerInfo.issuerId).to.equal(ISSUER_ID);
    expect(issuerInfo.isActive).to.be.true;
  });

  it("Should allow permissionless batch registration with valid institutional signature", async function () {
    const logicalBatchId = deriveLogicalBatchId({
      issuerId: ISSUER_ID,
      institutionBatchNumber: 1,
      schemaVersion: SCHEMA_VERSION,
    });

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("merkle_root_batch_1"));
    const issuedAt = Math.floor(Date.now() / 1000);
    const credentialCount = 100;
    const issuerKeyVersion = 1;

    const batchContentId = deriveBatchContentId({
      logicalBatchId,
      merkleRoot,
      issuerAddress: issuer.address,
      issuerKeyVersion,
      credentialCount,
      issuedAt,
      schemaVersion: SCHEMA_VERSION,
    });

    // Create manifest hash matching Solidity's abi.encode(...)
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "address", "uint16", "uint32", "uint64"],
      [logicalBatchId, batchContentId, merkleRoot, issuer.address, issuerKeyVersion, credentialCount, issuedAt]
    );
    const manifestHash = ethers.keccak256(encoded);

    // Institutional signature
    const signature = await issuer.signMessage(ethers.getBytes(manifestHash));

    // Submit from unauthorized third-party (permissionless publisher)
    const tx = await registry.connect(unauthorized).registerBatch(
      logicalBatchId,
      batchContentId,
      merkleRoot,
      issuer.address,
      issuerKeyVersion,
      credentialCount,
      issuedAt,
      signature
    );

    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);
    console.log(`      ⛽ Gas Used for Batch Registration: ${receipt?.gasUsed.toString()}`);

    // Verify state
    const [isActive, storedRoot, blockNumber] = await registry.isBatchActive(batchContentId);
    expect(isActive).to.be.true;
    expect(storedRoot).to.equal(merkleRoot);
    expect(blockNumber).to.be.greaterThan(0);
  });

  it("Should reject duplicate registration of identical batchContentId", async function () {
    const logicalBatchId = deriveLogicalBatchId({
      issuerId: ISSUER_ID,
      institutionBatchNumber: 2,
      schemaVersion: SCHEMA_VERSION,
    });
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("merkle_root_2"));
    const issuedAt = Math.floor(Date.now() / 1000);
    const credentialCount = 50;

    const batchContentId = deriveBatchContentId({
      logicalBatchId,
      merkleRoot,
      issuerAddress: issuer.address,
      issuerKeyVersion: 1,
      credentialCount,
      issuedAt,
      schemaVersion: SCHEMA_VERSION,
    });

    // Register directly from issuer
    await registry.connect(issuer).registerBatchDirect(
      logicalBatchId,
      batchContentId,
      merkleRoot,
      1,
      credentialCount,
      issuedAt
    );

    // Attempting to register again should revert with BatchAlreadyRegistered
    await expect(
      registry.connect(issuer).registerBatchDirect(
        logicalBatchId,
        batchContentId,
        merkleRoot,
        1,
        credentialCount,
        issuedAt
      )
    ).to.be.revertedWithCustomError(registry, "BatchAlreadyRegistered");
  });

  it("Should detect LogicalBatchConflict if same logicalBatchId is registered with conflicting content", async function () {
    const logicalBatchId = deriveLogicalBatchId({
      issuerId: ISSUER_ID,
      institutionBatchNumber: 3,
      schemaVersion: SCHEMA_VERSION,
    });
    const merkleRootA = ethers.keccak256(ethers.toUtf8Bytes("root_version_A"));
    const merkleRootB = ethers.keccak256(ethers.toUtf8Bytes("root_version_B"));
    const issuedAt = Math.floor(Date.now() / 1000);

    const contentIdA = deriveBatchContentId({
      logicalBatchId,
      merkleRoot: merkleRootA,
      issuerAddress: issuer.address,
      issuerKeyVersion: 1,
      credentialCount: 50,
      issuedAt,
      schemaVersion: SCHEMA_VERSION,
    });

    const contentIdB = deriveBatchContentId({
      logicalBatchId,
      merkleRoot: merkleRootB,
      issuerAddress: issuer.address,
      issuerKeyVersion: 1,
      credentialCount: 50,
      issuedAt,
      schemaVersion: SCHEMA_VERSION,
    });

    // Register Version A
    await registry.connect(issuer).registerBatchDirect(
      logicalBatchId,
      contentIdA,
      merkleRootA,
      1,
      50,
      issuedAt
    );

    // Register Version B with same logicalBatchId -> Should revert with LogicalBatchConflict
    await expect(
      registry.connect(issuer).registerBatchDirect(
        logicalBatchId,
        contentIdB,
        merkleRootB,
        1,
        50,
        issuedAt
      )
    ).to.be.revertedWithCustomError(registry, "LogicalBatchConflict");
  });

  it("Should allow institution-authorized revocation and reject unauthorized third-party revocation", async function () {
    const [_, __, thirdParty] = await ethers.getSigners();
    const logicalBatchId = deriveLogicalBatchId({
      issuerId: ISSUER_ID,
      institutionBatchNumber: 4,
      schemaVersion: SCHEMA_VERSION,
    });
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes("root_revoke_test"));
    const issuedAt = Math.floor(Date.now() / 1000);

    const contentId = deriveBatchContentId({
      logicalBatchId,
      merkleRoot,
      issuerAddress: issuer.address,
      issuerKeyVersion: 1,
      credentialCount: 10,
      issuedAt,
      schemaVersion: SCHEMA_VERSION,
    });

    await registry.connect(issuer).registerBatchDirect(
      logicalBatchId,
      contentId,
      merkleRoot,
      1,
      10,
      issuedAt
    );

    // Verify stored issuer address is issuer.address
    const batchBefore = await registry.getBatch(contentId);
    expect(batchBefore.issuerAddress.toLowerCase()).to.equal(issuer.address.toLowerCase());

    // Unauthorized third-party revocation attempt must be rejected
    await expect(
      registry.connect(thirdParty).revokeBatch(contentId, "Unauthorized revocation")
    ).to.be.revertedWithCustomError(registry, "Unauthorized");

    // Institution-authorized revocation through issuer signer succeeds
    await registry.connect(issuer).revokeBatch(contentId, "Administrative correction");

    const batchAfter = await registry.getBatch(contentId);
    expect(batchAfter.status).to.equal(2); // BatchStatus.REVOKED

    const [isActive] = await registry.isBatchActive(contentId);
    expect(isActive).to.be.false;
  });
});
