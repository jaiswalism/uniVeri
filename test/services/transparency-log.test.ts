import { describe, it, expect, beforeEach } from "vitest";
import { Wallet, HDNodeWallet } from "ethers";
import { LogClusterManager } from "../../src/services/transparency-log/log-manager.js";
import { createBatchManifest, signBatchManifest } from "../../src/core/manifest.js";
import { IndependentPublisher } from "../../src/publisher/independent-publisher.js";
import { CommonVerifier, buildVerifierPolicy } from "../../src/verifier/common-verifier.js";
import { generateSyntheticCertificate, createCertificateCommitment } from "../../src/core/certificate.js";
import { MerkleTree } from "../../src/core/merkle.js";

describe("Milestone 2 & 4: Transparency Log Architecture & Verifier", () => {
  let logManager: LogClusterManager;
  let publisher: IndependentPublisher;
  let verifier: CommonVerifier;
  let issuerWallet: HDNodeWallet;

  beforeEach(() => {
    logManager = new LogClusterManager();
    issuerWallet = Wallet.createRandom();
    const policy = buildVerifierPolicy({
      logManager,
      issuer: { issuerId: "did:edu:cmu", address: issuerWallet.address, keyVersion: 1 },
    });
    verifier = new CommonVerifier(policy);
    publisher = new IndependentPublisher(logManager);
    publisher.setValidator(verifier);
  });

  it("C1 Single Log: Publishes manifest, generates inclusion proof and verifies correctly", async () => {
    const cert = generateSyntheticCertificate({ issuerId: "did:edu:cmu", index: 1 });
    const commitment = createCertificateCommitment(cert);
    const tree = new MerkleTree([commitment.leafHash]);
    const leafProof = tree.getProof(0);

    const manifest = createBatchManifest({
      issuerId: "did:edu:cmu",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    const pubResult = await publisher.publishToC1(signedManifest);
    expect(pubResult.outcome).toBe("SUCCESS");
    expect(pubResult.evidence).toBeDefined();

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: pubResult.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.revocationStatus).toBe("NO_REVOCATION_OBSERVED");
  });

  it("C1 Single Log Failure Injection: Operator outage results in INFRASTRUCTURE_ERROR", async () => {
    logManager.configureC1Failure({ unavailable: true });

    const manifest = createBatchManifest({
      issuerId: "did:edu:cmu",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: "0x" + "11".repeat(32),
      credentialCount: 1,
    });
    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    const pubResult = await publisher.publishToC1(signedManifest);
    expect(pubResult.outcome).toBe("INFRASTRUCTURE_ERROR");
    expect(pubResult.errorMessage).toContain("UNAVAILABLE");
  });

  it("C2 Multi-log: Survives 1-of-3 log failure and maintains 2-of-3 quorum, preserving safe uncertainty", async () => {
    // Inject failure on Log Alpha (Alpha fails, Beta & Gamma remain healthy)
    logManager.configureC2Failure({ failingLogIds: ["LOG_C2_ALPHA"] });

    const cert = generateSyntheticCertificate({ issuerId: "did:edu:cmu", index: 1 });
    const commitment = createCertificateCommitment(cert);
    const tree = new MerkleTree([commitment.leafHash]);
    const leafProof = tree.getProof(0);

    const manifest = createBatchManifest({
      issuerId: "did:edu:cmu",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    const pubResult = await publisher.publishToC2(signedManifest);
    expect(pubResult.outcome).toBe("SUCCESS");
    expect(pubResult.evidence?.architecture).toBe("C2");

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: pubResult.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    // With Log Alpha down, status is STATUS_UNKNOWN (cannot rule out hidden revocation in Alpha)
    expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
    expect(report.statusObservations).toContain("NO_REVOCATION_OBSERVED");
    expect(report.statusCoverage).toContain("2/3 pinned logs answered");
    expect(report.isVerified).toBe(false);
  });

  it("C2 Multi-log: Fails when 2-of-3 logs fail (quorum loss)", async () => {
    // Inject failure on Log Alpha and Beta
    logManager.configureC2Failure({ failingLogIds: ["LOG_C2_ALPHA", "LOG_C2_BETA"] });

    const manifest = createBatchManifest({
      issuerId: "did:edu:cmu",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: "0x" + "22".repeat(32),
      credentialCount: 1,
    });
    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    const pubResult = await publisher.publishToC2(signedManifest);
    expect(pubResult.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});
