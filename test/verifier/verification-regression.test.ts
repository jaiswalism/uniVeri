import { describe, it, expect, beforeEach } from "vitest";
import { HDNodeWallet, Wallet } from "ethers";
import { LogClusterManager } from "../../src/services/transparency-log/log-manager.js";
import { CommonVerifier, buildVerifierPolicy } from "../../src/verifier/common-verifier.js";
import { generateSyntheticCertificate, createCertificateCommitment } from "../../src/core/certificate.js";
import { MerkleTree } from "../../src/core/merkle.js";
import { createBatchManifest, signBatchManifest, signRevocation } from "../../src/core/manifest.js";
import { IndependentPublisher } from "../../src/publisher/independent-publisher.js";
import { EvidenceRetriever } from "../../src/verifier/evidence-retriever.js";
import {
  C1Evidence,
  C2Evidence,
  DEvidence,
  MerkleInclusionProof,
  SignedBatchManifest,
} from "../../src/core/types.js";

describe("Priority 1: Verification Correctness & Regression Suite", () => {
  let logManager: LogClusterManager;
  let verifier: CommonVerifier;
  let issuerWallet: HDNodeWallet;
  let attackerWallet: HDNodeWallet;
  const D_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const CHAIN_ID = 31337;

  beforeEach(() => {
    logManager = new LogClusterManager();
    issuerWallet = Wallet.createRandom();
    attackerWallet = Wallet.createRandom();
    const policy = buildVerifierPolicy({
      logManager,
      issuer: { issuerId: "did:edu:mit", address: issuerWallet.address, keyVersion: 1 },
      d: { chainId: CHAIN_ID, contractAddress: D_CONTRACT, confirmationDepth: 1 },
      freshness: { maxCheckpointAgeSec: 300, futureSkewSec: 5, maxDReadAgeSec: 300, maxDBlockLag: 5 },
    });
    verifier = new CommonVerifier(policy);
  });

  async function createValidSetup() {
    const cert = generateSyntheticCertificate({ issuerId: "did:edu:mit", index: 1 });
    const commitment = createCertificateCommitment(cert);
    const tree = new MerkleTree([commitment.leafHash]);
    const leafProof = tree.getProof(0);

    const manifest = createBatchManifest({
      issuerId: "did:edu:mit",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    // Submit to C1 Log
    await logManager.logC1.submitManifest(signedManifest);
    const inclusionC1 = await logManager.logC1.getInclusionProof(manifest.batchContentId);
    const checkpointC1 = await logManager.logC1.getLatestCheckpoint();
    const statusC1 = await logManager.logC1.getStatusObservation(manifest.batchContentId);

    const c1Evidence: C1Evidence = {
      architecture: "C1",
      logId: logManager.logC1.logId,
      inclusionProof: inclusionC1,
      checkpoint: checkpointC1,
      status: statusC1,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    // Submit to C2 Logs (Alpha, Beta, Gamma)
    await logManager.logC2A.submitManifest(signedManifest);
    await logManager.logC2B.submitManifest(signedManifest);
    await logManager.logC2C.submitManifest(signedManifest);

    const proofA = await logManager.logC2A.getInclusionProof(manifest.batchContentId);
    const proofB = await logManager.logC2B.getInclusionProof(manifest.batchContentId);
    const proofC = await logManager.logC2C.getInclusionProof(manifest.batchContentId);

    const cpA = await logManager.logC2A.getLatestCheckpoint();
    const cpB = await logManager.logC2B.getLatestCheckpoint();
    const cpC = await logManager.logC2C.getLatestCheckpoint();

    const stA = await logManager.logC2A.getStatusObservation(manifest.batchContentId);
    const stB = await logManager.logC2B.getStatusObservation(manifest.batchContentId);
    const stC = await logManager.logC2C.getStatusObservation(manifest.batchContentId);

    const c2Evidence: C2Evidence = {
      architecture: "C2",
      requiredQuorum: 2,
      totalLogs: 3,
      supportingProofs: [
        { logId: logManager.logC2A.logId, inclusionProof: proofA, checkpoint: cpA },
        { logId: logManager.logC2B.logId, inclusionProof: proofB, checkpoint: cpB },
        { logId: logManager.logC2C.logId, inclusionProof: proofC, checkpoint: cpC },
      ],
      statusObservations: [stA, stB, stC],
      quorumMet: true,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    const dEvidence: DEvidence = {
      architecture: "D",
      chainId: CHAIN_ID,
      contractAddress: D_CONTRACT,
      record: {
        logicalBatchId: manifest.logicalBatchId,
        batchContentId: manifest.batchContentId,
        merkleRoot: manifest.merkleRoot,
        issuerAddress: issuerWallet.address,
        issuerKeyVersion: manifest.issuerKeyVersion,
        credentialCount: manifest.credentialCount,
        issuedAt: manifest.issuedAt,
      },
      status: "ACTIVE",
      registeredBlockNumber: 42,
      observedBlockNumber: 42,
      observedBlockHash: "0x" + "aa".repeat(32),
      observedBlockTimestamp: Math.floor(Date.now() / 1000),
      headBlockNumberAtRead: 42,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    return { cert, leafProof, manifest, signedManifest, c1Evidence, c2Evidence, dEvidence, tree };
  }

  it("1.1 Valid signature with configured key produces AUTHENTIC, PUBLISHED, and ACCEPTED_AS_OF_EVIDENCE_BOUNDARY", async () => {
    const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();
    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: c1Evidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.revocationStatus).toBe("NO_REVOCATION_OBSERVED");
    expect(report.overallResult).toBe("ACCEPTED_AS_OF_EVIDENCE_BOUNDARY");
    expect(report.isVerified).toBe(true);
  });

  it("1.2 Invalid signature with configured key MUST produce NOT_AUTHENTIC (never UNKNOWN)", async () => {
    const { cert, leafProof, manifest, c1Evidence } = await createValidSetup();
    const forgedManifest = await signBatchManifest(manifest, attackerWallet);

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: forgedManifest,
      evidence: c1Evidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("NOT_AUTHENTIC");
    expect(report.manifestSignatureValid).toBe(false);
    expect(report.overallResult).toBe("REJECTED");
    expect(report.isVerified).toBe(false);
  });

  it("1.3 Unavailable key material produces UNKNOWN (reserved for genuinely unevaluable cases)", async () => {
    const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();
    // Unset issuer in policy and pass empty trustedIssuerAddress
    const unconfiguredVerifier = new CommonVerifier(
      buildVerifierPolicy({ logManager, issuer: null, d: null })
    );

    const report = unconfiguredVerifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: c1Evidence,
      trustedIssuerAddress: "",
    });

    expect(report.authStatus).toBe("UNKNOWN");
    expect(report.overallResult).toBe("INCONCLUSIVE");
    expect(report.isVerified).toBe(false);
  });

  it("1.4 Genuinely signed stale checkpoint produces STALE_EVIDENCE; forged checkpoint produces INSUFFICIENT_EVIDENCE", async () => {
    const { cert, leafProof, signedManifest, manifest } = await createValidSetup();

    // 1.4a Genuinely signed stale checkpoint:
    // Configure log to emit checkpoint with 600s staleness (> 300s threshold), signed genuinely by operator wallet
    logManager.logC1.setFailureOptions({ staleCheckpointAgeSec: 600 });
    const staleCheckpoint = await logManager.logC1.createCheckpoint();
    const inclusionProof = await logManager.logC1.getInclusionProof(manifest.batchContentId);

    const genuineStaleEvidence: C1Evidence = {
      architecture: "C1",
      logId: logManager.logC1.logId,
      inclusionProof,
      checkpoint: staleCheckpoint,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    const staleReport = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: genuineStaleEvidence,
    });

    expect(staleReport.publicationStatus).toBe("STALE_EVIDENCE");
    expect(staleReport.evidenceValid).toBe(true);
    expect(staleReport.evidenceFresh).toBe(false);
    expect(staleReport.overallResult).toBe("INCONCLUSIVE");
    expect(staleReport.isVerified).toBe(false);

    // 1.4b Forged checkpoint signature explicitly
    const forgedEvidence: C1Evidence = {
      ...genuineStaleEvidence,
      checkpoint: { ...genuineStaleEvidence.checkpoint, signature: "0x" + "99".repeat(65) },
      inclusionProof: {
        ...genuineStaleEvidence.inclusionProof,
        checkpoint: { ...genuineStaleEvidence.inclusionProof.checkpoint, signature: "0x" + "99".repeat(65) },
      },
    };
    const forgedReport = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: forgedEvidence,
    });
    expect(forgedReport.publicationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(forgedReport.evidenceValid).toBe(false);
  });

  it("1.5 Pinned issuer policy enforcement: trustedIssuerAddress must not replace configured issuer key", async () => {
    const { cert, leafProof, manifest, c1Evidence } = await createValidSetup();

    // Manifest signed by attacker
    const attackerSignedManifest = await signBatchManifest(manifest, attackerWallet);

    // Caller attempts to override pinned policy by passing trustedIssuerAddress = attackerWallet.address
    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: attackerSignedManifest,
      evidence: c1Evidence,
      trustedIssuerAddress: attackerWallet.address,
    });

    // Pinned policy must be enforced: attacker's signature must NOT be accepted as authentic
    expect(report.authStatus).toBe("NOT_AUTHENTIC");
    expect(report.manifestSignatureValid).toBe(false);
    expect(report.rejectionReasons).toContain("manifest signature invalid for pinned issuer key");
    expect(report.overallResult).toBe("REJECTED");
    expect(report.isVerified).toBe(false);
  });

  it("1.6 Pinned issuer policy enforcement: issuerId, issuerKeyVersion, schemaVersion, and address mismatches", async () => {
    const { cert, leafProof, tree } = await createValidSetup();

    // 1.6a issuerId mismatch
    const badIdManifest = createBatchManifest({
      issuerId: "did:edu:untrusted_other",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedBadId = await signBatchManifest(badIdManifest, issuerWallet);
    const repBadId = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: signedBadId,
      evidence: null,
      architecture: "C1",
    });
    expect(repBadId.authStatus).toBe("NOT_AUTHENTIC");
    expect(repBadId.rejectionReasons).toContain("manifest issuerId differs from pinned policy");

    // 1.6b issuerKeyVersion mismatch
    const badKeyVerManifest = createBatchManifest({
      issuerId: "did:edu:mit",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 99,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedBadKey = await signBatchManifest(badKeyVerManifest, issuerWallet);
    const repBadKey = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: signedBadKey,
      evidence: null,
      architecture: "C1",
    });
    expect(repBadKey.authStatus).toBe("NOT_AUTHENTIC");
    expect(repBadKey.rejectionReasons).toContain("manifest issuerKeyVersion differs from pinned policy");

    // 1.6c schemaVersion mismatch
    const badSchemaManifest = {
      ...badKeyVerManifest,
      issuerKeyVersion: 1,
      schemaVersion: "9.9.9" as any,
    };
    const signedBadSchema = await signBatchManifest(badSchemaManifest, issuerWallet);
    const repBadSchema = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: signedBadSchema,
      evidence: null,
      architecture: "C1",
    });
    expect(repBadSchema.authStatus).toBe("NOT_AUTHENTIC");
    expect(repBadSchema.rejectionReasons).toContain("manifest schemaVersion differs from pinned policy");

    // 1.6d issuerAddress mismatch
    const badAddrManifest = createBatchManifest({
      issuerId: "did:edu:mit",
      issuerAddress: attackerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    const signedBadAddr = await signBatchManifest(badAddrManifest, attackerWallet);
    const repBadAddr = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: signedBadAddr,
      evidence: null,
      architecture: "C1",
    });
    expect(repBadAddr.authStatus).toBe("NOT_AUTHENTIC");
    expect(repBadAddr.rejectionReasons).toContain("manifest issuerAddress differs from pinned policy");
  });

  it("1.7 Status observation authentication: removing genuine revocation preserves uncertainty, never accepted", async () => {
    const { cert, leafProof, signedManifest, manifest, c1Evidence } = await createValidSetup();

    // Submit an issuer-signed revocation to log C1
    const rev = await signRevocation({
      logicalBatchId: manifest.logicalBatchId,
      batchContentId: manifest.batchContentId,
      issuerAddress: issuerWallet.address,
      reason: "Degree rescinded for academic misconduct",
      revokedAt: Math.floor(Date.now() / 1000),
    }, issuerWallet);
    await logManager.logC1.submitRevocation(rev);

    // Retrieve genuine status observation from the log
    const genuineStatus = await logManager.logC1.getStatusObservation(manifest.batchContentId);
    expect(genuineStatus.revocations.length).toBe(1);
    expect(genuineStatus.operatorSignature).toBeDefined();

    // Verify with genuine revocation: produces REVOKED_AS_OF_EVIDENCE and REJECTED
    const revokedReport = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: { ...c1Evidence, status: genuineStatus },
    });
    expect(revokedReport.revocationStatus).toBe("REVOKED_AS_OF_EVIDENCE");
    expect(revokedReport.overallResult).toBe("REJECTED");

    // ATTACK SIMULATION: Adversary strips the genuine revocation from status.revocations
    const tamperedStatus = {
      ...genuineStatus,
      revocations: [], // Stripped revocation!
    };

    const tamperedReport = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: { ...c1Evidence, status: tamperedStatus },
    });

    // MUST NOT produce NO_REVOCATION_OBSERVED or ACCEPTED_AS_OF_EVIDENCE_BOUNDARY!
    expect(tamperedReport.revocationStatus).toBe("STATUS_UNKNOWN");
    expect(tamperedReport.overallResult).toBe("INCONCLUSIVE");
    expect(tamperedReport.isVerified).toBe(false);

    // Empty status observation with no operator attestation also produces STATUS_UNKNOWN (uncertainty preserved)
    const unauthenticatedEmptyStatus = {
      logId: logManager.logC1.logId,
      batchContentId: manifest.batchContentId,
      checkpoint: genuineStatus.checkpoint,
      revocations: [],
    };
    const unauthReport = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: { ...c1Evidence, status: unauthenticatedEmptyStatus },
    });
    expect(unauthReport.revocationStatus).toBe("STATUS_UNKNOWN");
    expect(unauthReport.isVerified).toBe(false);
  });

  it("1.8 Enforce valid-signed-manifest publication predicate across C1, C2, and D", async () => {
    const { signedManifest } = await createValidSetup();
    const corruptManifest: SignedBatchManifest = {
      ...signedManifest,
      institutionSignature: "0x" + "11".repeat(65),
    };

    const publisher = new IndependentPublisher(logManager);
    publisher.setValidator(verifier);

    // C1: Pre-submission publication predicate rejects invalid signed manifest
    const pubC1 = await publisher.publishToC1(corruptManifest);
    expect(pubC1.outcome).toBe("REJECTED");
    expect(pubC1.failureClass).toBe("INVALID_MANIFEST_PREDICATE");

    // C2: Pre-submission publication predicate rejects invalid signed manifest
    const pubC2 = await publisher.publishToC2(corruptManifest);
    expect(pubC2.outcome).toBe("REJECTED");
    expect(pubC2.failureClass).toBe("INVALID_MANIFEST_PREDICATE");

    // D: Pre-submission publication predicate rejects invalid signed manifest
    const pubD = await publisher.publishToD(corruptManifest);
    expect(pubD.outcome).toBe("REJECTED");
    expect(pubD.failureClass).toBe("INVALID_MANIFEST_PREDICATE");

    // Direct log engine write path also enforces predicate
    await expect(logManager.logC1.submitManifest(corruptManifest)).rejects.toThrow("invalid institutional manifest signature");

    // Verifier evaluateEvidence also enforces predicate
    const ev = verifier.evaluateEvidence(corruptManifest, null);
    expect(ev.publicationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(ev.evidenceValid).toBe(false);
  });

  it("1.5 Duplicate log identity is NOT counted toward C2 quorum", async () => {
    const { cert, leafProof, signedManifest, c2Evidence } = await createValidSetup();

    // Send 2 proofs, but both are from LOG_C2_ALPHA
    const duplicateEvidence: C2Evidence = {
      ...c2Evidence,
      supportingProofs: [c2Evidence.supportingProofs[0], c2Evidence.supportingProofs[0]],
    };

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: duplicateEvidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.publicationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.overallResult).toBe("INCONCLUSIVE");
    expect(report.isVerified).toBe(false);
  });

  it("1.6 Two logs supporting different manifests are rejected (proof not bound to manifest)", async () => {
    const { cert, leafProof, manifest, signedManifest, c2Evidence } = await createValidSetup();

    // Create a second, conflicting manifest
    const conflictingManifest = createBatchManifest({
      issuerId: "did:edu:mit",
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 2,
      merkleRoot: "0x" + "22".repeat(32),
      credentialCount: 1,
    });
    const signedConflicting = await signBatchManifest(conflictingManifest, issuerWallet);
    await logManager.logC2B.submitManifest(signedConflicting);
    const proofBConflicting = await logManager.logC2B.getInclusionProof(conflictingManifest.batchContentId);

    // C2 evidence mixing proof from Manifest 1 (Log A) and Manifest 2 (Log B)
    const mixedEvidence: C2Evidence = {
      ...c2Evidence,
      supportingProofs: [
        c2Evidence.supportingProofs[0], // Bound to signedManifest
        { logId: logManager.logC2B.logId, inclusionProof: proofBConflicting, checkpoint: proofBConflicting.checkpoint }, // Bound to signedConflicting
      ],
    };

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: mixedEvidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    // Quorum requires 2 proofs bound to signedManifest; Log B proof is rejected because its leaf does not bind
    expect(report.publicationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.evidenceSummary).toContain("not bound to the supplied signed manifest");
    expect(report.isVerified).toBe(false);
  });

  it("1.7 C2 safe uncertainty: 2 positive issuance proofs + 1 unavailable log MUST NOT imply current non-revocation", async () => {
    const { cert, leafProof, signedManifest, c2Evidence } = await createValidSetup();

    // Alpha and Beta healthy, Gamma down (no status observation from Gamma)
    const partialC2Evidence: C2Evidence = {
      ...c2Evidence,
      supportingProofs: [c2Evidence.supportingProofs[0], c2Evidence.supportingProofs[1]],
      statusObservations: [c2Evidence.statusObservations![0], c2Evidence.statusObservations![1]], // Gamma missing
    };

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: partialC2Evidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    // Must NOT be NO_REVOCATION_OBSERVED as final status: Gamma could hold a revocation!
    expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
    expect(report.statusObservations).toContain("NO_REVOCATION_OBSERVED");
    expect(report.statusCoverage).toContain("2/3 pinned logs answered");
    // Overall result is INCONCLUSIVE (not ACCEPTED_AS_OF_EVIDENCE_BOUNDARY), isVerified is false!
    expect(report.overallResult).toBe("INCONCLUSIVE");
    expect(report.isVerified).toBe(false);
  });

  it("1.8 Signed revocation hidden in third log is detected when third log answers", async () => {
    const { cert, leafProof, signedManifest, c2Evidence } = await createValidSetup();

    // Submit signed revocation event to Log Gamma
    const revEvent = await signRevocation({
      logicalBatchId: signedManifest.manifest.logicalBatchId,
      batchContentId: signedManifest.manifest.batchContentId,
      issuerAddress: issuerWallet.address,
      reason: "Diploma Revoked",
      revokedAt: Math.floor(Date.now() / 1000),
    }, issuerWallet);

    await logManager.logC2C.submitRevocation(revEvent);
    const gammaStatus = await logManager.logC2C.getStatusObservation(signedManifest.manifest.batchContentId);

    const c2WithRevocation: C2Evidence = {
      ...c2Evidence,
      statusObservations: [
        c2Evidence.statusObservations![0],
        c2Evidence.statusObservations![1],
        gammaStatus, // Gamma discloses revocation
      ],
    };

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: c2WithRevocation,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.revocationStatus).toBe("REVOKED_AS_OF_EVIDENCE");
    expect(report.overallResult).toBe("REJECTED");
    expect(report.isVerified).toBe(false);
  });

  it("1.9 Verified revocation in Architecture D produces REVOKED_AS_OF_EVIDENCE and REJECTED", async () => {
    const { cert, leafProof, signedManifest, dEvidence } = await createValidSetup();

    const revokedDEvidence: DEvidence = {
      ...dEvidence,
      status: "REVOKED",
      observedBlockNumber: 45,
      headBlockNumberAtRead: 45,
    };

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: revokedDEvidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.revocationStatus).toBe("REVOKED_AS_OF_EVIDENCE");
    expect(report.overallResult).toBe("REJECTED");
    expect(report.isVerified).toBe(false);
  });

  it("1.10 Tampered certificate with authentic published batch is NOT_AUTHENTIC and REJECTED", async () => {
    const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();
    const tamperedCert = { ...cert, studentName: "Malicious Impersonator" };

    const report = verifier.verifyCertificate({
      certificate: tamperedCert,
      merkleProof: leafProof,
      signedManifest,
      evidence: c1Evidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("NOT_AUTHENTIC");
    expect(report.merkleProofValid).toBe(false);
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.overallResult).toBe("REJECTED");
    expect(report.isVerified).toBe(false);
  });

  it("1.11 Architecture D status at recorded block boundary", async () => {
    const { cert, leafProof, signedManifest, dEvidence } = await createValidSetup();

    const report = verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: dEvidence,
      trustedIssuerAddress: issuerWallet.address,
    });

    expect(report.authStatus).toBe("AUTHENTIC");
    expect(report.publicationStatus).toBe("PUBLISHED");
    expect(report.revocationStatus).toBe("NO_REVOCATION_OBSERVED");
    expect(report.evidenceSummary).toContain("ACTIVE_AS_OF_BLOCK_42");
    expect(report.overallResult).toBe("ACCEPTED_AS_OF_EVIDENCE_BOUNDARY");
    expect(report.isVerified).toBe(true);
  });

  describe("Item 1: Tampered revocation-entry handling", () => {
    it("1.1 Tampering by removing a revocation entry causes STATUS_UNKNOWN and INCONCLUSIVE", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      const revEvent = await signRevocation({
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: issuerWallet.address,
        reason: "Academic Misconduct",
        revokedAt: Math.floor(Date.now() / 1000),
      }, issuerWallet);

      await logManager.logC1.submitRevocation(revEvent);
      const genuineStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);

      // Tamper by removing the revocation event while leaving inclusionProofs or status unchanged
      const tamperedStatus = {
        ...genuineStatus,
        revocations: [],
      };

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: tamperedStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.overallResult).toBe("INCONCLUSIVE");
      expect(report.isVerified).toBe(false);
      expect(report.rejectionReasons.some((r) => r.includes("revocations count") || r.includes("tamper") || r.includes("incomplete"))).toBe(true);
    });

    it("1.2 Tampering with revocation reason causes STATUS_UNKNOWN and INCONCLUSIVE", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      const revEvent = await signRevocation({
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: issuerWallet.address,
        reason: "Academic Misconduct",
        revokedAt: Math.floor(Date.now() / 1000),
      }, issuerWallet);

      await logManager.logC1.submitRevocation(revEvent);
      const genuineStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);

      // Modify the reason field in the event
      const tamperedRev = {
        ...genuineStatus.revocations[0],
        event: { ...genuineStatus.revocations[0].event, reason: "Fraudulent Alteration" },
      };
      const tamperedStatus = {
        ...genuineStatus,
        revocations: [tamperedRev],
      };

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: tamperedStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.overallResult).toBe("INCONCLUSIVE");
      expect(report.isVerified).toBe(false);
      expect(report.rejectionReasons.some((r) => r.includes("leafHash mismatch") || r.includes("failed event-hash binding"))).toBe(true);
    });

    it("1.3 Modifying batchContentId or logicalBatchId causes STATUS_UNKNOWN and INCONCLUSIVE", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      const revEvent = await signRevocation({
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: issuerWallet.address,
        reason: "Degree Cancelled",
        revokedAt: Math.floor(Date.now() / 1000),
      }, issuerWallet);

      await logManager.logC1.submitRevocation(revEvent);
      const genuineStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);

      // Modify logicalBatchId
      const otherBatchId = "0x" + "bb".repeat(32);
      const tamperedRev = {
        ...genuineStatus.revocations[0],
        event: { ...genuineStatus.revocations[0].event, logicalBatchId: otherBatchId },
      };
      const tamperedStatus = {
        ...genuineStatus,
        revocations: [tamperedRev],
      };

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: tamperedStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.overallResult).toBe("INCONCLUSIVE");
      expect(report.isVerified).toBe(false);
      expect(report.rejectionReasons.some((r) => r.includes("failed batch binding") || r.includes("logicalBatchId mismatch"))).toBe(true);
    });

    it("1.4 Modifying issuerAddress causes STATUS_UNKNOWN and INCONCLUSIVE", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      const revEvent = await signRevocation({
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: issuerWallet.address,
        reason: "Administrative Void",
        revokedAt: Math.floor(Date.now() / 1000),
      }, issuerWallet);

      await logManager.logC1.submitRevocation(revEvent);
      const genuineStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);

      // Modify issuerAddress to attacker wallet address
      const tamperedRev = {
        ...genuineStatus.revocations[0],
        event: { ...genuineStatus.revocations[0].event, issuerAddress: attackerWallet.address },
      };
      const tamperedStatus = {
        ...genuineStatus,
        revocations: [tamperedRev],
      };

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: tamperedStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.overallResult).toBe("INCONCLUSIVE");
      expect(report.isVerified).toBe(false);
      expect(report.rejectionReasons.some((r) => r.includes("leafHash mismatch") || r.includes("issuer address") || r.includes("failed issuer signature"))).toBe(true);
    });

    it("1.5 Replacing revocation event with another signed event causes STATUS_UNKNOWN and INCONCLUSIVE", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      const revEvent = await signRevocation({
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: issuerWallet.address,
        reason: "Authentic Revocation",
        revokedAt: Math.floor(Date.now() / 1000),
      }, issuerWallet);

      await logManager.logC1.submitRevocation(revEvent);
      const genuineStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);

      // Create an event for a completely different batch, signed by attacker
      const otherBatchId = "0x" + "11".repeat(32);
      const otherContentId = "0x" + "aa".repeat(32);
      const otherRev = await signRevocation({
        logicalBatchId: otherBatchId,
        batchContentId: otherContentId,
        issuerAddress: attackerWallet.address,
        reason: "Other Batch Event",
        revokedAt: Math.floor(Date.now() / 1000),
      }, attackerWallet);

      const tamperedStatus = {
        ...genuineStatus,
        revocations: [{ ...genuineStatus.revocations[0], event: otherRev }],
      };

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: tamperedStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.overallResult).toBe("INCONCLUSIVE");
      expect(report.isVerified).toBe(false);
    });

    it("1.6 Valid empty status observation signed by the log operator produces ACCEPTED", async () => {
      const { cert, leafProof, signedManifest, c1Evidence } = await createValidSetup();

      // No revocations submitted; genuine status observation signed by operator
      const emptyStatus = await logManager.logC1.getStatusObservation(signedManifest.manifest.batchContentId);
      expect(emptyStatus.revocations.length).toBe(0);
      expect(emptyStatus.operatorSignature).toBeDefined();

      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: { ...c1Evidence, status: emptyStatus },
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.authStatus).toBe("AUTHENTIC");
      expect(report.publicationStatus).toBe("PUBLISHED");
      expect(report.revocationStatus).toBe("NO_REVOCATION_OBSERVED");
      expect(report.overallResult).toBe("ACCEPTED_AS_OF_EVIDENCE_BOUNDARY");
      expect(report.isVerified).toBe(true);
    });
  });

  describe("Item 2: Genuine C2 read-path omission", () => {
    it("2.1 Read-path omission on Alpha allows Beta and Gamma to satisfy quorum while excluding Alpha", async () => {
      const { cert, leafProof, signedManifest } = await createValidSetup();

      // Publish to all C2 logs
      const publisher = new IndependentPublisher(logManager);
      publisher.setValidator(verifier);
      const pubRes = await publisher.publishToC2(signedManifest);
      expect(pubRes.outcome).toBe("SUCCESS");

      // Configure read-path omission on Alpha only:
      // The entry is stored in Alpha, but getInclusionProof and getStatusObservation fail on read
      logManager.configureC2Failure({
        readOmitProofLogIds: ["LOG_C2_ALPHA"],
        readOmitStatusLogIds: ["LOG_C2_ALPHA"],
      });

      const retriever = new EvidenceRetriever(logManager, null);
      const retrieved = await retriever.fetch("C2", signedManifest);

      expect(retrieved.evidence).not.toBeNull();
      const c2Ev = retrieved.evidence as C2Evidence;

      // 1. Alpha's read proof is unavailable
      expect(retrieved.errors.some((e) => e.includes("LOG_C2_ALPHA"))).toBe(true);

      // 2. Beta and Gamma proofs remain available
      const logIds = c2Ev.supportingProofs.map((p) => p.logId);
      expect(logIds).toContain("LOG_C2_BETA");
      expect(logIds).toContain("LOG_C2_GAMMA");
      expect(logIds).not.toContain("LOG_C2_ALPHA");

      // 3. C2 still obtains quorum publication evidence (2 of 3 met)
      expect(c2Ev.quorumMet).toBe(true);
      expect(c2Ev.supportingProofs.length).toBe(2);

      // 4. Status coverage reflects unavailable Alpha source
      const report = verifier.verifyCertificate({
        certificate: cert,
        merkleProof: leafProof,
        signedManifest,
        evidence: c2Ev,
        trustedIssuerAddress: issuerWallet.address,
      });

      expect(report.publicationStatus).toBe("PUBLISHED");
      // With Alpha status unavailable, complete revocation coverage is not established
      expect(report.revocationStatus).toBe("STATUS_UNKNOWN");
      expect(report.statusCoverage).toContain("LOG_C2_ALPHA");
      expect(report.statusCoverage).toContain("2/3 pinned logs answered");
      expect(c2Ev.unavailableStatusLogIds).toContain("LOG_C2_ALPHA");
    });
  });
});
