import React, { useState } from "react";
import { ShieldCheck, CheckCircle, XCircle, AlertTriangle, Search, Lock, Layers, RefreshCw, AlertCircle } from "lucide-react";
import {
  AcademicCertificate,
  MerkleInclusionProof,
  SignedBatchManifest,
  ArchitectureEvidence,
  VerificationReport,
  C1Evidence,
  C2Evidence,
  DEvidence,
  RevocationProofEntry,
  SignedRevocation,
} from "../../core/types";
import { CommonVerifier, buildVerifierPolicy } from "../../verifier/common-verifier";
import { LogClusterManager } from "../../services/transparency-log/log-manager";
import { generateSyntheticCertificate, createCertificateCommitment } from "../../core/certificate";
import { MerkleTree } from "../../core/merkle";
import { createBatchManifest, signBatchManifest } from "../../core/manifest";
import { Wallet, ethers, keccak256, toUtf8Bytes } from "ethers";

export interface VerificationPortalProps {
  logManager?: LogClusterManager;
  certificate: AcademicCertificate | null;
  merkleProof: MerkleInclusionProof | null;
  signedManifest: SignedBatchManifest | null;
  evidenceMap: { C1?: ArchitectureEvidence; C2?: ArchitectureEvidence; D?: ArchitectureEvidence };
  onLoadSample?: () => void;
}

export type TamperScenario =
  | "NONE"
  | "TAMPER_CERT_GPA"
  | "TAMPER_INSTITUTION_SIG"
  | "VALID_REVOCATION"
  | "TAMPER_REVOCATION_REASON"
  | "TAMPER_REVOCATION_BATCH_ID"
  | "TAMPER_REVOCATION_ISSUER"
  | "TAMPER_REVOCATION_SIG"
  | "TAMPER_STATUS_OPERATOR_SIG";

export const VerificationPortal: React.FC<VerificationPortalProps> = ({
  logManager: injectedLogManager,
  certificate: initialCert,
  merkleProof: initialProof,
  signedManifest: initialManifest,
  evidenceMap: initialEvidenceMap,
  onLoadSample,
}) => {
  const [localLogManager] = useState(() => new LogClusterManager());
  const logManager = injectedLogManager || localLogManager;
  const contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  const [verifier] = useState(
    () => new CommonVerifier(logManager, undefined, contractAddress)
  );

  const [targetArch, setTargetArch] = useState<"C1" | "C2" | "D">("C1");
  const [tamperScenario, setTamperScenario] = useState<TamperScenario>("NONE");

  // Fallback demo state if user hasn't generated/published a batch yet
  const [demoState] = useState(() => {
    const institutionWallet = Wallet.createRandom();
    const cert = generateSyntheticCertificate({ issuerId: "did:edu:mit", index: 1 });
    const comm = createCertificateCommitment(cert);
    const tree = new MerkleTree([comm.leafHash]);
    const manifest = createBatchManifest({
      issuerId: "did:edu:mit",
      issuerAddress: institutionWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: tree.getRoot(),
      credentialCount: 1,
    });
    // Sync sign for immediate availability
    const manifestHash = keccak256(toUtf8Bytes(JSON.stringify(manifest)));
    const sig = institutionWallet.signingKey.sign(manifestHash).serialized;
    const signed: SignedBatchManifest = { manifest, institutionSignature: sig };
    const proof = tree.getProof(0);

    const c1Ev: C1Evidence = {
      architecture: "C1",
      logId: "LOG_C1_PRIMARY",
      inclusionProof: {
        logId: "LOG_C1_PRIMARY",
        leafHash: comm.leafHash,
        leafIndex: 0,
        treeSize: 1,
        auditPath: [],
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 1,
          rootHash: tree.getRoot(),
          timestamp: Math.floor(Date.now() / 1000),
          signature: "0x1234",
        },
      },
      checkpoint: {
        logId: "LOG_C1_PRIMARY",
        treeSize: 1,
        rootHash: tree.getRoot(),
        timestamp: Math.floor(Date.now() / 1000),
        signature: "0x1234",
      },
      status: {
        logId: "LOG_C1_PRIMARY",
        batchContentId: manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 1,
          rootHash: tree.getRoot(),
          timestamp: Math.floor(Date.now() / 1000),
          signature: "0x1234",
        },
        revocations: [],
        operatorSignature: "0x5678",
      },
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    const c2Ev: C2Evidence = {
      architecture: "C2",
      requiredQuorum: 2,
      totalLogs: 3,
      supportingProofs: [
        { logId: "LOG_C2_ALPHA", inclusionProof: c1Ev.inclusionProof, checkpoint: c1Ev.checkpoint },
        { logId: "LOG_C2_BETA", inclusionProof: c1Ev.inclusionProof, checkpoint: c1Ev.checkpoint },
      ],
      statusObservations: c1Ev.status ? [c1Ev.status] : [],
      quorumMet: true,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    const dEv: DEvidence = {
      architecture: "D",
      chainId: 31337,
      contractAddress,
      record: {
        logicalBatchId: manifest.logicalBatchId,
        batchContentId: manifest.batchContentId,
        merkleRoot: manifest.merkleRoot,
        issuerAddress: manifest.issuerAddress,
        issuerKeyVersion: 1,
        credentialCount: 1,
        issuedAt: manifest.issuedAt,
      },
      status: "ACTIVE",
      registeredBlockNumber: 1001,
      observedBlockNumber: 1001,
      observedBlockHash: "0x" + "bb".repeat(32),
      observedBlockTimestamp: Math.floor(Date.now() / 1000),
      headBlockNumberAtRead: 1001,
      retrievedAt: Math.floor(Date.now() / 1000),
    };

    return {
      certificate: cert,
      merkleProof: proof,
      signedManifest: signed,
      evidenceMap: { C1: c1Ev, C2: c2Ev, D: dEv },
      institutionWallet,
    };
  });

  const certificate = initialCert || demoState.certificate;
  const merkleProof = initialProof || demoState.merkleProof;
  const signedManifest = initialManifest || demoState.signedManifest;
  const evidenceMap = initialEvidenceMap && initialEvidenceMap[targetArch] ? initialEvidenceMap : demoState.evidenceMap;

  const rawEvidence = evidenceMap[targetArch];

  let report: VerificationReport | null = null;

  if (certificate && merkleProof && signedManifest && rawEvidence) {
    let certToVerify = { ...certificate };
    let manifestToVerify = { ...signedManifest };
    let evidenceToVerify = JSON.parse(JSON.stringify(rawEvidence));

    // Apply tamper scenarios
    if (tamperScenario === "TAMPER_CERT_GPA") {
      certToVerify = { ...certificate, gpa: "4.00 (Tampered)" };
    } else if (tamperScenario === "TAMPER_INSTITUTION_SIG") {
      manifestToVerify = {
        ...signedManifest,
        institutionSignature: "0x" + "00".repeat(65),
      };
    } else if (tamperScenario === "VALID_REVOCATION") {
      // Inject legitimate signed revocation event
      const revTime = Math.floor(Date.now() / 1000);
      const revReason = "Academic misconduct";
      const revHash = keccak256(toUtf8Bytes(revReason));
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint256", "bytes32"],
        [
          signedManifest.manifest.logicalBatchId,
          signedManifest.manifest.batchContentId,
          signedManifest.manifest.issuerAddress,
          revTime,
          revHash,
        ]
      );
      const revEventHash = keccak256(encoded);
      const revLeafHash = keccak256(toUtf8Bytes(JSON.stringify({ type: "REVOCATION", revEventHash })));
      const operatorWallet = logManager.logC1.getOperatorWallet();
      const statusCpSig = operatorWallet.signingKey.sign(keccak256(toUtf8Bytes("checkpoint"))).serialized;

      const event: SignedRevocation = {
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: signedManifest.manifest.issuerAddress,
        reason: revReason,
        revokedAt: revTime,
        signature: demoState.institutionWallet.signingKey.sign(revEventHash).serialized,
      };

      const revocationEntry: RevocationProofEntry = {
        event,
        inclusionProof: {
          logId: "LOG_C1_PRIMARY",
          leafHash: revLeafHash,
          leafIndex: 1,
          treeSize: 2,
          auditPath: [],
          checkpoint: {
            logId: "LOG_C1_PRIMARY",
            treeSize: 2,
            rootHash: revLeafHash,
            timestamp: revTime,
            signature: statusCpSig,
          },
        },
      };

      const statusObs = {
        logId: "LOG_C1_PRIMARY",
        batchContentId: signedManifest.manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 2,
          rootHash: revLeafHash,
          timestamp: revTime,
          signature: statusCpSig,
        },
        revocations: [revocationEntry],
        operatorSignature: statusCpSig,
      };

      if (targetArch === "C1") {
        evidenceToVerify.status = statusObs;
      } else if (targetArch === "C2") {
        evidenceToVerify.statusObservations = [statusObs];
      }
    } else if (tamperScenario === "TAMPER_REVOCATION_REASON") {
      // Event reason tampered -> event hash mismatch -> STATUS_UNKNOWN / INCONCLUSIVE
      const revTime = Math.floor(Date.now() / 1000);
      const revReason = "Original reason";
      const revHash = keccak256(toUtf8Bytes(revReason));
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint256", "bytes32"],
        [
          signedManifest.manifest.logicalBatchId,
          signedManifest.manifest.batchContentId,
          signedManifest.manifest.issuerAddress,
          revTime,
          revHash,
        ]
      );
      const revEventHash = keccak256(encoded);
      const revLeafHash = keccak256(toUtf8Bytes(JSON.stringify({ type: "REVOCATION", revEventHash })));
      const operatorWallet = logManager.logC1.getOperatorWallet();
      const statusCpSig = operatorWallet.signingKey.sign(keccak256(toUtf8Bytes("checkpoint"))).serialized;

      const event: SignedRevocation = {
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: signedManifest.manifest.issuerAddress,
        reason: "Tampered reason by attacker", // TAMPERED!
        revokedAt: revTime,
        signature: demoState.institutionWallet.signingKey.sign(revEventHash).serialized,
      };

      const revocationEntry: RevocationProofEntry = {
        event,
        inclusionProof: {
          logId: "LOG_C1_PRIMARY",
          leafHash: revLeafHash,
          leafIndex: 1,
          treeSize: 2,
          auditPath: [],
          checkpoint: {
            logId: "LOG_C1_PRIMARY",
            treeSize: 2,
            rootHash: revLeafHash,
            timestamp: revTime,
            signature: statusCpSig,
          },
        },
      };

      const statusObs = {
        logId: "LOG_C1_PRIMARY",
        batchContentId: signedManifest.manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 2,
          rootHash: revLeafHash,
          timestamp: revTime,
          signature: statusCpSig,
        },
        revocations: [revocationEntry],
        operatorSignature: statusCpSig,
      };

      if (targetArch === "C1") evidenceToVerify.status = statusObs;
      else if (targetArch === "C2") evidenceToVerify.statusObservations = [statusObs];
    } else if (tamperScenario === "TAMPER_REVOCATION_BATCH_ID") {
      // Foreign batch ID -> STATUS_UNKNOWN / INCONCLUSIVE
      const revTime = Math.floor(Date.now() / 1000);
      const fakeBatchId = "0x" + "11".repeat(32);
      const revReason = "Administrative error";
      const revHash = keccak256(toUtf8Bytes(revReason));
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint256", "bytes32"],
        [
          fakeBatchId,
          signedManifest.manifest.batchContentId,
          signedManifest.manifest.issuerAddress,
          revTime,
          revHash,
        ]
      );
      const revEventHash = keccak256(encoded);
      const revLeafHash = keccak256(toUtf8Bytes(JSON.stringify({ type: "REVOCATION", revEventHash })));
      const operatorWallet = logManager.logC1.getOperatorWallet();
      const statusCpSig = operatorWallet.signingKey.sign(keccak256(toUtf8Bytes("checkpoint"))).serialized;

      const event: SignedRevocation = {
        logicalBatchId: fakeBatchId, // TAMPERED!
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: signedManifest.manifest.issuerAddress,
        reason: revReason,
        revokedAt: revTime,
        signature: demoState.institutionWallet.signingKey.sign(revEventHash).serialized,
      };

      const revocationEntry: RevocationProofEntry = {
        event,
        inclusionProof: {
          logId: "LOG_C1_PRIMARY",
          leafHash: revLeafHash,
          leafIndex: 1,
          treeSize: 2,
          auditPath: [],
          checkpoint: {
            logId: "LOG_C1_PRIMARY",
            treeSize: 2,
            rootHash: revLeafHash,
            timestamp: revTime,
            signature: statusCpSig,
          },
        },
      };

      const statusObs = {
        logId: "LOG_C1_PRIMARY",
        batchContentId: signedManifest.manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 2,
          rootHash: revLeafHash,
          timestamp: revTime,
          signature: statusCpSig,
        },
        revocations: [revocationEntry],
        operatorSignature: statusCpSig,
      };

      if (targetArch === "C1") evidenceToVerify.status = statusObs;
      else if (targetArch === "C2") evidenceToVerify.statusObservations = [statusObs];
    } else if (tamperScenario === "TAMPER_REVOCATION_ISSUER") {
      // Foreign issuer address -> STATUS_UNKNOWN / INCONCLUSIVE
      const revTime = Math.floor(Date.now() / 1000);
      const fakeIssuer = Wallet.createRandom().address;
      const revReason = "Administrative error";
      const revHash = keccak256(toUtf8Bytes(revReason));
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint256", "bytes32"],
        [
          signedManifest.manifest.logicalBatchId,
          signedManifest.manifest.batchContentId,
          fakeIssuer,
          revTime,
          revHash,
        ]
      );
      const revEventHash = keccak256(encoded);
      const revLeafHash = keccak256(toUtf8Bytes(JSON.stringify({ type: "REVOCATION", revEventHash })));
      const operatorWallet = logManager.logC1.getOperatorWallet();
      const statusCpSig = operatorWallet.signingKey.sign(keccak256(toUtf8Bytes("checkpoint"))).serialized;

      const event: SignedRevocation = {
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: fakeIssuer, // TAMPERED!
        reason: revReason,
        revokedAt: revTime,
        signature: demoState.institutionWallet.signingKey.sign(revEventHash).serialized,
      };

      const revocationEntry: RevocationProofEntry = {
        event,
        inclusionProof: {
          logId: "LOG_C1_PRIMARY",
          leafHash: revLeafHash,
          leafIndex: 1,
          treeSize: 2,
          auditPath: [],
          checkpoint: {
            logId: "LOG_C1_PRIMARY",
            treeSize: 2,
            rootHash: revLeafHash,
            timestamp: revTime,
            signature: statusCpSig,
          },
        },
      };

      const statusObs = {
        logId: "LOG_C1_PRIMARY",
        batchContentId: signedManifest.manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 2,
          rootHash: revLeafHash,
          timestamp: revTime,
          signature: statusCpSig,
        },
        revocations: [revocationEntry],
        operatorSignature: statusCpSig,
      };

      if (targetArch === "C1") evidenceToVerify.status = statusObs;
      else if (targetArch === "C2") evidenceToVerify.statusObservations = [statusObs];
    } else if (tamperScenario === "TAMPER_REVOCATION_SIG") {
      // Signature signed by foreign attacker -> STATUS_UNKNOWN / INCONCLUSIVE
      const revTime = Math.floor(Date.now() / 1000);
      const revReason = "Administrative error";
      const revHash = keccak256(toUtf8Bytes(revReason));
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint256", "bytes32"],
        [
          signedManifest.manifest.logicalBatchId,
          signedManifest.manifest.batchContentId,
          signedManifest.manifest.issuerAddress,
          revTime,
          revHash,
        ]
      );
      const revEventHash = keccak256(encoded);
      const revLeafHash = keccak256(toUtf8Bytes(JSON.stringify({ type: "REVOCATION", revEventHash })));
      const attackerWallet = Wallet.createRandom();
      const operatorWallet = logManager.logC1.getOperatorWallet();
      const statusCpSig = operatorWallet.signingKey.sign(keccak256(toUtf8Bytes("checkpoint"))).serialized;

      const event: SignedRevocation = {
        logicalBatchId: signedManifest.manifest.logicalBatchId,
        batchContentId: signedManifest.manifest.batchContentId,
        issuerAddress: signedManifest.manifest.issuerAddress,
        reason: revReason,
        revokedAt: revTime,
        signature: attackerWallet.signingKey.sign(revEventHash).serialized, // TAMPERED!
      };

      const revocationEntry: RevocationProofEntry = {
        event,
        inclusionProof: {
          logId: "LOG_C1_PRIMARY",
          leafHash: revLeafHash,
          leafIndex: 1,
          treeSize: 2,
          auditPath: [],
          checkpoint: {
            logId: "LOG_C1_PRIMARY",
            treeSize: 2,
            rootHash: revLeafHash,
            timestamp: revTime,
            signature: statusCpSig,
          },
        },
      };

      const statusObs = {
        logId: "LOG_C1_PRIMARY",
        batchContentId: signedManifest.manifest.batchContentId,
        checkpoint: {
          logId: "LOG_C1_PRIMARY",
          treeSize: 2,
          rootHash: revLeafHash,
          timestamp: revTime,
          signature: statusCpSig,
        },
        revocations: [revocationEntry],
        operatorSignature: statusCpSig,
      };

      if (targetArch === "C1") evidenceToVerify.status = statusObs;
      else if (targetArch === "C2") evidenceToVerify.statusObservations = [statusObs];
    } else if (tamperScenario === "TAMPER_STATUS_OPERATOR_SIG") {
      if (targetArch === "C1" && evidenceToVerify.status) {
        evidenceToVerify.status.operatorSignature = "0x" + "00".repeat(65);
      } else if (targetArch === "C2" && evidenceToVerify.statusObservations) {
        evidenceToVerify.statusObservations = evidenceToVerify.statusObservations.map((s: any) => ({
          ...s,
          operatorSignature: "0x" + "00".repeat(65),
        }));
      }
    }

    // Set pinned policy on verifier
    verifier.setPolicy(
      buildVerifierPolicy({
        logManager,
        issuer: {
          issuerId: manifestToVerify.manifest.issuerId,
          address: manifestToVerify.manifest.issuerAddress,
          keyVersion: manifestToVerify.manifest.issuerKeyVersion,
        },
        d: {
          chainId: 31337,
          contractAddress,
          confirmationDepth: 1,
        },
      })
    );

    report = verifier.verifyCertificate({
      certificate: certToVerify,
      merkleProof,
      signedManifest: manifestToVerify,
      evidence: evidenceToVerify,
      trustedIssuerAddress: manifestToVerify.manifest.issuerAddress,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
      {/* Header & Controls */}
      <div className="glass-card" style={{ padding: "1.75rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <ShieldCheck size={20} color="#10b981" /> Universal Multi-Architecture Verification Portal
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "1.25rem" }}>
              Strictly enforces the frozen 8-vocabulary verification semantics across C1, C2, and D with pinned issuer policy, status authentication, and revocation integrity.
            </p>
          </div>

          {onLoadSample && (
            <button className="btn-secondary" onClick={onLoadSample}>
              <RefreshCw size={15} /> Reload Fresh Batch
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          {/* Target Architecture Selector */}
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 600 }}>Verify Against:</span>
            {(["C1", "C2", "D"] as const).map((arch) => (
              <button
                key={arch}
                onClick={() => setTargetArch(arch)}
                className={`btn-secondary ${targetArch === arch ? "btn-primary" : ""}`}
                style={{ padding: "0.45rem 1rem", fontSize: "0.8rem" }}
              >
                {arch === "C1" ? "C1 (Single Log)" : arch === "C2" ? "C2 (3-Log Quorum)" : "D (Blockchain)"}
              </button>
            ))}
          </div>

          {/* Tamper / Attack Injection Selector */}
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 600 }}>Attack / Scenario Simulation:</span>
            <select
              value={tamperScenario}
              onChange={(e) => setTamperScenario(e.target.value as TamperScenario)}
              style={{
                padding: "0.45rem 0.8rem",
                borderRadius: "var(--radius-sm)",
                background: "rgba(10, 13, 20, 0.8)",
                border: "1px solid var(--border-color)",
                color: tamperScenario === "NONE" ? "#34d399" : "#fb7185",
                fontSize: "0.82rem",
                fontFamily: "var(--font-mono)",
              }}
            >
              <option value="NONE">NORMAL: Authentic Valid Certificate</option>
              <option value="TAMPER_CERT_GPA">ATTACK: Tamper Certificate Field (GPA)</option>
              <option value="TAMPER_INSTITUTION_SIG">ATTACK: Corrupt Institution ECDSA Signature</option>
              <option value="VALID_REVOCATION">REVOKED: Valid Signed Revocation Event</option>
              <option value="TAMPER_REVOCATION_REASON">STATUS ATTACK: Tampered Revocation Reason</option>
              <option value="TAMPER_REVOCATION_BATCH_ID">STATUS ATTACK: Tampered Batch Binding</option>
              <option value="TAMPER_REVOCATION_ISSUER">STATUS ATTACK: Tampered Revocation Issuer</option>
              <option value="TAMPER_REVOCATION_SIG">STATUS ATTACK: Forged Revocation Signature</option>
              <option value="TAMPER_STATUS_OPERATOR_SIG">STATUS ATTACK: Invalid Log Operator Sig</option>
            </select>
          </div>
        </div>
      </div>

      {/* Verification Report Display */}
      {report ? (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: "1.5rem" }}>
          {/* Left: Verification Verdict Card */}
          <div className="glass-card" style={{ padding: "1.75rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h4 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Verification Report</h4>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Target Architecture: <strong>{targetArch}</strong></div>
              </div>
              <span className={`badge ${report.isVerified ? "badge-success" : report.overallResult === "INCONCLUSIVE" ? "badge-warning" : "badge-danger"}`}>
                {report.isVerified ? "VERIFIED & AUTHENTIC" : report.overallResult}
              </span>
            </div>

            {/* Frozen Vocabulary 4-Tuple Display */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.6rem" }}>
              <div style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
                <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Auth Status</div>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: report.authStatus === "AUTHENTIC" ? "#34d399" : "#fb7185", marginTop: "0.25rem" }}>
                  {report.authStatus}
                </div>
              </div>

              <div style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
                <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Publication</div>
                <div style={{ fontSize: "0.8rem", fontWeight: 700, color: report.publicationStatus === "PUBLISHED" ? "#38bdf8" : "#fb7185", marginTop: "0.25rem" }}>
                  {report.publicationStatus}
                </div>
              </div>

              <div style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
                <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Status Obs</div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, color: report.revocationStatus === "NO_REVOCATION_OBSERVED" ? "#34d399" : report.revocationStatus === "REVOKED_AS_OF_EVIDENCE" ? "#fb7185" : "#f59e0b", marginTop: "0.25rem" }}>
                  {report.revocationStatus}
                </div>
              </div>

              <div style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
                <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase" }}>Overall Result</div>
                <div style={{ fontSize: "0.75rem", fontWeight: 700, color: report.overallResult === "ACCEPTED_AS_OF_EVIDENCE_BOUNDARY" ? "#34d399" : report.overallResult === "INCONCLUSIVE" ? "#f59e0b" : "#fb7185", marginTop: "0.25rem" }}>
                  {report.overallResult}
                </div>
              </div>
            </div>

            {/* Checklist of Cryptographic Assertions */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
                {report.merkleProofValid ? <CheckCircle size={16} color="#10b981" /> : <XCircle size={16} color="#f43f5e" />}
                <span>Merkle Inclusion Proof verifies to batch root: <code>{report.details.merkleRoot.slice(0, 14)}...</code></span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
                {report.manifestSignatureValid ? <CheckCircle size={16} color="#10b981" /> : <XCircle size={16} color="#f43f5e" />}
                <span>Institutional ECDSA secp256k1 Signature verified: <code>{report.details.issuerAddress.slice(0, 14)}...</code></span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
                {report.evidenceValid ? <CheckCircle size={16} color="#10b981" /> : <XCircle size={16} color="#f43f5e" />}
                <span>{report.evidenceSummary}</span>
              </div>
              {report.rejectionReasons && report.rejectionReasons.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "#f43f5e" }}>
                  <AlertCircle size={16} color="#f43f5e" />
                  <span><strong>Rejection / Inconclusive Diagnostic:</strong> {report.rejectionReasons.join("; ")}</span>
                </div>
              )}
            </div>

            {/* Safe Uncertainty & Audit Invariant Banner */}
            <div style={{ background: "rgba(99, 102, 241, 0.1)", border: "1px solid rgba(99, 102, 241, 0.3)", padding: "0.85rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", color: "#a5b4fc" }}>
              <strong>Safe Uncertainty Invariant:</strong> Status tampering never produces accepted verification. If an entry fails binding or signature validation, status drops to <code>STATUS_UNKNOWN</code> and overall result yields <code>INCONCLUSIVE</code>.
            </div>
          </div>

          {/* Right: Merkle Proof Audit Path */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Layers size={18} color="#8b5cf6" /> Merkle Proof Path ({merkleProof?.proof.length || 0} Steps)
            </h4>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "250px", overflowY: "auto" }}>
              {merkleProof && merkleProof.proof.length > 0 ? (
                merkleProof.proof.map((step, idx) => (
                  <div key={idx} style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.6rem", borderRadius: "var(--radius-sm)", fontSize: "0.75rem", fontFamily: "var(--font-mono)", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#a5b4fc" }}>Step {idx + 1} ({step.position})</span>
                    <span style={{ color: "var(--text-muted)" }}>{step.data.slice(0, 18)}...</span>
                  </div>
                ))
              ) : (
                <div style={{ background: "rgba(8, 11, 18, 0.7)", padding: "0.6rem", borderRadius: "var(--radius-sm)", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Single leaf root (trivial proof)
                </div>
              )}
            </div>

            <div style={{ marginTop: "1rem", fontSize: "0.75rem", color: "var(--text-secondary)", display: "flex", justifyContent: "space-between" }}>
              <span>Latency: <strong>{report.details.latencyMs.toFixed(3)} ms</strong></span>
              <span>Credentials in Batch: <strong>{signedManifest.manifest.credentialCount}</strong></span>
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
          Initializing verification portal...
        </div>
      )}
    </div>
  );
};
