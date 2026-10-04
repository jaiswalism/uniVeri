import { getAddress } from "ethers";
import { canonicalizeJson, hashCertificateLeaf } from "../core/canonical.js";
import {
  computeIssuanceEntryHash,
  computeRevocationEntryHash,
  isWellFormedSignature,
  validateManifestIdentifiers,
  verifyBatchManifestSignature,
  verifyRevocationSignature,
  verifyStatusObservationSignature,
} from "../core/manifest.js";
import { MerkleTree } from "../core/merkle.js";
import {
  AcademicCertificate,
  ArchitectureEvidence,
  AuthStatus,
  C1Evidence,
  C2Evidence,
  DEvidence,
  LogInclusionProof,
  LogStatusObservation,
  MerkleInclusionProof,
  ObservableRevocationStatus,
  OverallResult,
  PublicationStatus,
  SignedBatchManifest,
  SignedTreeCheckpoint,
  VerificationReport,
} from "../core/types.js";
import { LogClusterManager, PinnedLog } from "../services/transparency-log/log-manager.js";

/**
 * Trusted verifier configuration. Everything that decides what counts as acceptable evidence lives here
 * and NEVER comes from the evidence being verified.
 */
export interface VerifierPolicy {
  /** Pinned issuer key. Empty/undefined address => key material unavailable => authentication UNKNOWN. */
  issuer: { issuerId: string; address: string; keyVersion: number } | null;
  schemaVersion: string;
  c1: PinnedLog;
  /** Pinned C2 log identities and threshold (2-of-3). */
  c2: { logs: PinnedLog[]; threshold: number };
  /** Pinned chain / contract and confirmation rule for D. null => D evidence cannot be evaluated. */
  d: { chainId: number; contractAddress: string; confirmationDepth: number } | null;
  freshness: {
    /** A checkpoint is fresh iff 0 <= now - checkpoint.timestamp <= maxCheckpointAgeSec (future skew tolerated up to futureSkewSec). */
    maxCheckpointAgeSec: number;
    futureSkewSec: number;
    /** D evidence is fresh iff now - retrievedAt <= maxDReadAgeSec. */
    maxDReadAgeSec: number;
    /** D state read is fresh only if head block - observed block <= maxDBlockLag (a node serving older state is stale). */
    maxDBlockLag: number;
  };
  /** Injectable verifier clock (seconds) */
  nowSec: () => number;
}

export const DEFAULT_FRESHNESS = { maxCheckpointAgeSec: 300, futureSkewSec: 5, maxDReadAgeSec: 300, maxDBlockLag: 5 } as const;

export function buildVerifierPolicy(params: {
  logManager: LogClusterManager;
  issuer: { issuerId: string; address: string; keyVersion?: number } | null;
  d?: { chainId: number; contractAddress: string; confirmationDepth?: number } | null;
  freshness?: Partial<VerifierPolicy["freshness"]>;
  nowSec?: () => number;
}): VerifierPolicy {
  return {
    issuer: params.issuer
      ? { issuerId: params.issuer.issuerId, address: params.issuer.address, keyVersion: params.issuer.keyVersion ?? 1 }
      : null,
    schemaVersion: "1.0.0",
    c1: params.logManager.getPinnedC1(),
    c2: { logs: params.logManager.getPinnedC2(), threshold: 2 },
    d: params.d
      ? { chainId: params.d.chainId, contractAddress: params.d.contractAddress, confirmationDepth: params.d.confirmationDepth ?? 1 }
      : null,
    freshness: { ...DEFAULT_FRESHNESS, ...(params.freshness ?? {}) },
    nowSec: params.nowSec ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export interface VerificationInput {
  certificate: AcademicCertificate;
  merkleProof: MerkleInclusionProof;
  signedManifest: SignedBatchManifest;
  /** null when evidence retrieval failed; then `architecture` must be provided */
  evidence: ArchitectureEvidence | null;
  architecture?: "C1" | "C2" | "D";
  /** Optional issuer address override / configuration */
  trustedIssuerAddress?: string;
}

export interface EvidenceEvaluation {
  publicationStatus: PublicationStatus;
  revocationStatus: ObservableRevocationStatus;
  evidenceValid: boolean;
  evidenceFresh: boolean;
  evidenceSummary: string;
  statusCoverage: string;
  checkpointOrBlock: string | number;
  statusObservations: string[];
  notes: string[];
}

export type ProofClass = "VALID_FRESH" | "VALID_STALE" | "INVALID";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Common Verifier implementing Frozen Verification Semantics (Section 14 of Research Plan)
 */
export class CommonVerifier {
  private policy: VerifierPolicy;

  constructor(
    policyOrManager: VerifierPolicy | LogClusterManager,
    legacyIssuerAddress?: string,
    legacyDContract?: string
  ) {
    if ("c1" in policyOrManager && "c2" in policyOrManager && "schemaVersion" in policyOrManager) {
      this.policy = policyOrManager as VerifierPolicy;
    } else {
      this.policy = buildVerifierPolicy({
        logManager: policyOrManager as LogClusterManager,
        issuer: legacyIssuerAddress ? { issuerId: "did:edu:univeri", address: legacyIssuerAddress } : null,
        d: legacyDContract ? { chainId: 31337, contractAddress: legacyDContract, confirmationDepth: 1 } : null,
      });
    }
  }

  public getPolicy(): VerifierPolicy {
    return this.policy;
  }

  public setPolicy(policy: VerifierPolicy): void {
    this.policy = policy;
  }

  /**
   * Classifies ONE log's issuance evidence (C1 log, or one of the pinned C2 logs) against the pinned policy
   * and the supplied signed manifest. Used by the publisher to decide per-log VALIDATED evidence.
   */
  public classifyLogEvidence(
    arch: "C1" | "C2",
    signedManifest: SignedBatchManifest,
    logId: string,
    proof: LogInclusionProof
  ): { cls: ProofClass; notes: string[] } {
    const notes: string[] = [];
    const pinned = arch === "C1" ? (logId === this.policy.c1.logId ? this.policy.c1 : undefined) : this.policy.c2.logs.find((l) => l.logId === logId);
    if (!pinned) return { cls: "INVALID", notes: [`log ${logId} not pinned for ${arch}`] };
    return { cls: this.classifyIssuanceProof(proof, logId, proof.checkpoint, pinned, signedManifest, notes), notes };
  }

  private checkpointFreshness(cp: SignedTreeCheckpoint): "FRESH" | "STALE" | "FUTURE" {
    const age = this.policy.nowSec() - cp.timestamp;
    if (age < -this.policy.freshness.futureSkewSec) return "FUTURE";
    if (age > this.policy.freshness.maxCheckpointAgeSec) return "STALE";
    return "FRESH";
  }

  /**
   * Classifies a log inclusion proof (for ONE issuance entry) against: pinned operator key, binding to the
   * exact supplied signed manifest, internal log-id consistency, and checkpoint freshness.
   */
  private classifyIssuanceProof(
    proof: LogInclusionProof,
    declaredLogId: string,
    declaredCheckpoint: SignedTreeCheckpoint,
    pinned: PinnedLog,
    signedManifest: SignedBatchManifest,
    notes: string[]
  ): ProofClass {
    if (declaredLogId !== pinned.logId || proof.logId !== pinned.logId || proof.checkpoint.logId !== pinned.logId) {
      notes.push(`log identity mismatch for ${declaredLogId}`);
      return "INVALID";
    }
    if (canonicalizeJson(declaredCheckpoint) !== canonicalizeJson(proof.checkpoint)) {
      notes.push(`checkpoint mismatch inside evidence for ${declaredLogId}`);
      return "INVALID";
    }
    if (proof.leafHash.toLowerCase() !== computeIssuanceEntryHash(signedManifest).toLowerCase()) {
      notes.push(`inclusion leaf of ${declaredLogId} is not bound to the supplied signed manifest`);
      return "INVALID";
    }
    if (!LogClusterManager.verifyLogInclusionProof(proof, pinned.operatorAddress)) {
      notes.push(`inclusion proof or checkpoint signature invalid for ${declaredLogId}`);
      return "INVALID";
    }
    const fr = this.checkpointFreshness(proof.checkpoint);
    if (fr === "FUTURE") {
      notes.push(`checkpoint of ${declaredLogId} is dated in the future`);
      return "INVALID";
    }
    return fr === "FRESH" ? "VALID_FRESH" : "VALID_STALE";
  }

  /**
   * Evaluates one log's status observation. Returns whether the observation is a valid, fresh answer
   * and whether it disclosed a valid issuer-signed revocation of this batch.
   */
  private evaluateStatusObservation(
    obs: LogStatusObservation,
    pinned: PinnedLog,
    signedManifest: SignedBatchManifest,
    notes: string[]
  ): { answered: boolean; revoked: boolean; invalidEntryReason?: string } {
    if (obs.logId !== pinned.logId || obs.checkpoint.logId !== pinned.logId) {
      const reason = `status observation with unpinned/mismatched log id ${obs.logId}`;
      notes.push(reason);
      return { answered: false, revoked: false, invalidEntryReason: reason };
    }
    if (!LogClusterManager.verifyCheckpoint(obs.checkpoint, pinned.operatorAddress)) {
      const reason = `status checkpoint signature invalid for ${pinned.logId}`;
      notes.push(reason);
      return { answered: false, revoked: false, invalidEntryReason: reason };
    }
    if (this.checkpointFreshness(obs.checkpoint) !== "FRESH") {
      const reason = `status checkpoint of ${pinned.logId} not fresh`;
      notes.push(reason);
      return { answered: false, revoked: false, invalidEntryReason: reason };
    }

    const m = signedManifest.manifest;
    // Bind status response to the queried batch
    const boundToBatch = Boolean(
      obs.batchContentId && obs.batchContentId.toLowerCase() === m.batchContentId.toLowerCase()
    );
    if (!boundToBatch) {
      const reason = `status observation not bound to queried batch ${m.batchContentId}`;
      notes.push(reason);
      return { answered: false, revoked: false, invalidEntryReason: reason };
    }

    // Authenticate operator attestation binding this batch and its revocation status
    const revocationLeafHashes = (obs.revocations ?? []).map((r) => r.inclusionProof?.leafHash ?? "");
    const operatorSigValid = Boolean(
      obs.operatorSignature &&
        boundToBatch &&
        verifyStatusObservationSignature(
          {
            logId: obs.logId,
            batchContentId: obs.batchContentId,
            checkpointRoot: obs.checkpoint.rootHash,
            treeSize: obs.checkpoint.treeSize,
            revocationEntryHashes: revocationLeafHashes,
            observedAt: obs.observedAt,
            signature: obs.operatorSignature,
          },
          pinned.operatorAddress
        )
    );

    if (!operatorSigValid) {
      const reason = `unauthenticated status observation from ${pinned.logId}: invalid or missing operator attestation signature`;
      notes.push(reason);
      return { answered: false, revoked: false, invalidEntryReason: reason };
    }

    let revoked = false;
    const issuerAddress = this.policy.issuer?.address ?? "";

    for (let i = 0; i < (obs.revocations ?? []).length; i++) {
      const r = obs.revocations[i];
      if (!r || !r.event || !r.inclusionProof) {
        const reason = `malformed revocation entry #${i} from ${pinned.logId}`;
        notes.push(reason);
        return { answered: false, revoked: false, invalidEntryReason: reason };
      }

      const bound = Boolean(
        r.event.batchContentId &&
          r.event.logicalBatchId &&
          r.event.batchContentId.toLowerCase() === m.batchContentId.toLowerCase() &&
          r.event.logicalBatchId.toLowerCase() === m.logicalBatchId.toLowerCase()
      );
      if (!bound) {
        const reason = `revocation entry #${i} from ${pinned.logId} failed batch binding (batchContentId/logicalBatchId mismatch)`;
        notes.push(reason);
        return { answered: false, revoked: false, invalidEntryReason: reason };
      }

      const leafOk = Boolean(
        r.inclusionProof.leafHash &&
          r.inclusionProof.leafHash.toLowerCase() === computeRevocationEntryHash(r.event).toLowerCase()
      );
      if (!leafOk) {
        const reason = `revocation entry #${i} from ${pinned.logId} failed event-hash binding (leafHash mismatch)`;
        notes.push(reason);
        return { answered: false, revoked: false, invalidEntryReason: reason };
      }

      const inclusionOk = Boolean(
        r.inclusionProof.logId === pinned.logId &&
          LogClusterManager.verifyLogInclusionProof(r.inclusionProof, pinned.operatorAddress) &&
          r.inclusionProof.checkpoint.treeSize <= obs.checkpoint.treeSize
      );
      if (!inclusionOk) {
        const reason = `revocation entry #${i} from ${pinned.logId} failed inclusion proof validation against operator checkpoint`;
        notes.push(reason);
        return { answered: false, revoked: false, invalidEntryReason: reason };
      }

      const sigOk = Boolean(issuerAddress !== "" && verifyRevocationSignature(r.event, issuerAddress));
      if (!sigOk) {
        const reason = `revocation entry #${i} from ${pinned.logId} failed issuer signature validation against ${issuerAddress}`;
        notes.push(reason);
        return { answered: false, revoked: false, invalidEntryReason: reason };
      }

      revoked = true;
    }

    if (revoked) {
      return { answered: true, revoked: true };
    }

    return { answered: true, revoked: false };
  }

  /**
   * Verifies an academic certificate with Merkle proof, signed manifest, and architecture evidence
   */
  public verifyCertificate(input: VerificationInput): VerificationReport {
    const startTime = performance.now();
    const { certificate, merkleProof, signedManifest, evidence } = input;
    const architecture = evidence ? evidence.architecture : input.architecture!;
    const policy = this.policy;
    const manifest = signedManifest.manifest;
    const rejectionReasons: string[] = [];

    // ---------------- 1. Local cryptographic authentication ----------------
    const calculatedLeafHash = hashCertificateLeaf(certificate);
    const leafHashMatches = calculatedLeafHash.toLowerCase() === merkleProof.leafHash.toLowerCase();
    const merkleProofValid = leafHashMatches && MerkleTree.verifyProof(merkleProof);
    const rootMatchesManifest = merkleProof.merkleRoot.toLowerCase() === manifest.merkleRoot.toLowerCase();

    const identifiers = validateManifestIdentifiers(manifest);
    const sigVerification = verifyBatchManifestSignature(signedManifest);

    // Enforce pinned issuer policy: trustedIssuerAddress must NOT replace configured issuer key
    const configuredIssuer = policy.issuer;
    const issuerConfigured = Boolean(configuredIssuer && configuredIssuer.address.trim().length > 0);
    const targetIssuerAddress = configuredIssuer ? configuredIssuer.address : (input.trustedIssuerAddress ?? "");
    const targetIssuerConfigured = Boolean(targetIssuerAddress && targetIssuerAddress.trim().length > 0);

    const issuerAddressMatches =
      targetIssuerConfigured &&
      manifest.issuerAddress.toLowerCase() === targetIssuerAddress.toLowerCase();
    const issuerIdMatches = configuredIssuer ? manifest.issuerId === configuredIssuer.issuerId : true;
    const keyVersionMatches = configuredIssuer ? manifest.issuerKeyVersion === configuredIssuer.keyVersion : true;
    const schemaVersionMatches = manifest.schemaVersion === policy.schemaVersion;

    const manifestSignatureValid =
      targetIssuerConfigured &&
      isWellFormedSignature(signedManifest.institutionSignature) &&
      sigVerification.valid &&
      sigVerification.recoveredAddress.toLowerCase() === targetIssuerAddress.toLowerCase();

    // Check policy and signature rejection reasons
    if (!issuerAddressMatches && targetIssuerConfigured) rejectionReasons.push("manifest issuerAddress differs from pinned policy");
    if (!issuerIdMatches) rejectionReasons.push("manifest issuerId differs from pinned policy");
    if (!keyVersionMatches) rejectionReasons.push("manifest issuerKeyVersion differs from pinned policy");
    if (!schemaVersionMatches) rejectionReasons.push("manifest schemaVersion differs from pinned policy");
    if (!manifestSignatureValid && targetIssuerConfigured) rejectionReasons.push("manifest signature invalid for pinned issuer key");

    // Failures that do not depend on key material are always NOT_AUTHENTIC.
    let authStatus: AuthStatus;
    if (!leafHashMatches || !merkleProofValid || !rootMatchesManifest || !identifiers.valid) {
      authStatus = "NOT_AUTHENTIC";
      if (!leafHashMatches) rejectionReasons.push("certificate leaf hash mismatch");
      if (!merkleProofValid) rejectionReasons.push("merkle proof invalid");
      if (!rootMatchesManifest) rejectionReasons.push("merkle root differs from manifest");
      rejectionReasons.push(...identifiers.problems);
    } else if (!targetIssuerConfigured) {
      authStatus = "UNKNOWN"; // genuinely unevaluable: no pinned key material
      rejectionReasons.push("no pinned issuer key configured");
    } else if (
      !issuerAddressMatches ||
      !issuerIdMatches ||
      !keyVersionMatches ||
      !schemaVersionMatches ||
      !manifestSignatureValid
    ) {
      authStatus = "NOT_AUTHENTIC";
    } else {
      authStatus = "AUTHENTIC";
    }

    const ev = this.evaluateEvidence(signedManifest, evidence);
    const { publicationStatus, revocationStatus, evidenceValid, evidenceFresh, evidenceSummary, statusCoverage, checkpointOrBlock, statusObservations } = ev;
    const latencyMs = performance.now() - startTime;

    // ---------------- 3. Overall result (never a bare boolean "valid") ----------------
    let overallResult: OverallResult;
    if (authStatus === "NOT_AUTHENTIC" || revocationStatus === "REVOKED_AS_OF_EVIDENCE") {
      overallResult = "REJECTED";
    } else if (authStatus === "AUTHENTIC" && publicationStatus === "PUBLISHED" && revocationStatus === "NO_REVOCATION_OBSERVED") {
      overallResult = "ACCEPTED_AS_OF_EVIDENCE_BOUNDARY";
    } else {
      overallResult = "INCONCLUSIVE";
    }
    if (revocationStatus === "STATUS_UNKNOWN") rejectionReasons.push("status evidence incomplete");
    if (revocationStatus === "REVOKED_AS_OF_EVIDENCE") rejectionReasons.push("revocation disclosed by verified evidence");
    if (publicationStatus !== "PUBLISHED") rejectionReasons.push(`publication ${publicationStatus}`);
    for (const n of ev.notes) {
      if (
        n.includes("failed") ||
        n.includes("rejected") ||
        n.includes("invalid") ||
        n.includes("mismatch") ||
        n.includes("unauthenticated")
      ) {
        rejectionReasons.push(n);
      }
    }

    return {
      certificateId: certificate.certificateId,
      architecture,
      authStatus,
      publicationStatus,
      revocationStatus,
      overallResult,
      isVerified: overallResult === "ACCEPTED_AS_OF_EVIDENCE_BOUNDARY",
      statusObservations,
      statusCoverage,
      evidenceFresh,
      rejectionReasons,
      merkleProofValid: leafHashMatches && merkleProofValid && rootMatchesManifest,
      manifestSignatureValid,
      evidenceValid,
      evidenceSummary,
      details: {
        leafHash: calculatedLeafHash,
        merkleRoot: manifest.merkleRoot,
        logicalBatchId: manifest.logicalBatchId,
        batchContentId: manifest.batchContentId,
        issuerAddress: manifest.issuerAddress,
        checkpointOrBlock,
        latencyMs,
      },
      rawEvidence: evidence,
    };
  }

  /**
   * Publication-evidence and status evaluation only (no certificate-level checks). Used by verifyCertificate
   * and by the publisher to decide whether a batch has sufficient VALIDATED evidence.
   */
  public evaluateEvidence(signedManifest: SignedBatchManifest, evidence: ArchitectureEvidence | null): EvidenceEvaluation {
    const policy = this.policy;
    const manifest = signedManifest.manifest;
    const statusObservations: string[] = [];
    let publicationStatus: PublicationStatus = "UNPUBLISHED";
    let revocationStatus: ObservableRevocationStatus = "STATUS_UNKNOWN";
    let evidenceValid = false;
    let evidenceFresh = false;
    let evidenceSummary = "";
    let statusCoverage = "no status source answered";
    let checkpointOrBlock: string | number = "N/A";
    const notes: string[] = [];

    // Research Plan Section 19 Publication Predicate: A valid signed manifest is required across all architectures
    const sigCheck = verifyBatchManifestSignature(signedManifest);
    const idCheck = validateManifestIdentifiers(manifest);
    if (!sigCheck.valid || !idCheck.valid) {
      return {
        publicationStatus: "INSUFFICIENT_EVIDENCE",
        revocationStatus: "STATUS_UNKNOWN",
        evidenceValid: false,
        evidenceFresh: false,
        evidenceSummary: `Publication predicate failed: signed manifest is invalid (${!sigCheck.valid ? "signature invalid" : idCheck.problems.join("; ")})`,
        statusCoverage: "none: invalid signed manifest",
        checkpointOrBlock: "N/A",
        statusObservations: [],
        notes: ["signed manifest fails publication predicate"],
      };
    }

    if (evidence === null) {
      publicationStatus = "INSUFFICIENT_EVIDENCE";
      evidenceSummary = "Evidence unavailable: retrieval failed or returned nothing";
      statusCoverage = "no status source answered";
    } else if (evidence.architecture === "C1") {
      const c1 = evidence as C1Evidence;
      checkpointOrBlock = c1.checkpoint.treeSize;
      const cls = this.classifyIssuanceProof(c1.inclusionProof, c1.logId, c1.checkpoint, policy.c1, signedManifest, notes);
      if (cls === "VALID_FRESH") {
        evidenceValid = true;
        evidenceFresh = true;
        publicationStatus = "PUBLISHED";
        evidenceSummary = `Valid fresh C1 inclusion in ${c1.logId} (checkpoint size ${c1.checkpoint.treeSize}, ts ${c1.checkpoint.timestamp})`;
      } else if (cls === "VALID_STALE") {
        evidenceValid = true;
        publicationStatus = "STALE_EVIDENCE";
        evidenceSummary = `C1 inclusion proof valid but checkpoint older than ${policy.freshness.maxCheckpointAgeSec}s`;
      } else {
        publicationStatus = "INSUFFICIENT_EVIDENCE";
        evidenceSummary = `C1 evidence rejected: ${notes.join("; ")}`;
      }

      // Status
      if (c1.status) {
        const r = this.evaluateStatusObservation(c1.status, policy.c1, signedManifest, notes);
        if (r.invalidEntryReason) {
          notes.push(`C1 status observation rejected: ${r.invalidEntryReason}`);
        }
        if (r.revoked) {
          revocationStatus = "REVOKED_AS_OF_EVIDENCE";
          statusCoverage = "1/1 pinned logs answered; revocation disclosed";
        } else if (r.answered) {
          revocationStatus = "NO_REVOCATION_OBSERVED";
          statusObservations.push("NO_REVOCATION_OBSERVED");
          statusCoverage = "1/1 pinned logs answered";
        } else {
          revocationStatus = "STATUS_UNKNOWN";
          statusCoverage = `0/1 pinned logs answered (${r.invalidEntryReason || "status observation invalid, unauthenticated, or stale"})`;
        }
      } else {
        statusCoverage = `0/1 pinned logs answered${c1.statusError ? ` (${c1.statusError})` : ""}`;
      }
    } else if (evidence.architecture === "C2") {
      const c2 = evidence as C2Evidence;
      const thr = policy.c2.threshold;
      const total = policy.c2.logs.length;
      const pinnedById = new Map(policy.c2.logs.map((l) => [l.logId, l]));

      let overrideRejected = false;
      if (c2.requiredQuorum !== thr || c2.totalLogs !== total) {
        overrideRejected = true;
        notes.push(`evidence-supplied quorum ${c2.requiredQuorum}-of-${c2.totalLogs} rejected; pinned policy is ${thr}-of-${total}`);
      }

      const validFresh = new Set<string>();
      const validStale = new Set<string>();
      const seen = new Set<string>();
      for (const entry of c2.supportingProofs) {
        if (seen.has(entry.logId)) {
          notes.push(`duplicate proof for ${entry.logId} ignored`);
          continue;
        }
        seen.add(entry.logId);
        const pinned = pinnedById.get(entry.logId);
        if (!pinned) {
          notes.push(`log ${entry.logId} is not in the pinned C2 log set`);
          continue;
        }
        const cls = this.classifyIssuanceProof(entry.inclusionProof, entry.logId, entry.checkpoint, pinned, signedManifest, notes);
        if (cls === "VALID_FRESH") validFresh.add(entry.logId);
        else if (cls === "VALID_STALE") validStale.add(entry.logId);
      }
      const maxTreeSize = c2.supportingProofs.reduce((m, p) => Math.max(m, p.checkpoint.treeSize), 0);
      checkpointOrBlock = `Quorum ${validFresh.size}/${total} (max checkpoint size ${maxTreeSize})`;

      if (!overrideRejected && validFresh.size >= thr) {
        evidenceValid = true;
        evidenceFresh = true;
        publicationStatus = "PUBLISHED";
        evidenceSummary = `Quorum met (${validFresh.size}/${total} distinct pinned logs: ${Array.from(validFresh).join(", ")})`;
      } else if (!overrideRejected && validFresh.size + validStale.size >= thr) {
        evidenceValid = true;
        publicationStatus = "STALE_EVIDENCE";
        evidenceSummary = `Quorum reachable only with stale checkpoints (fresh ${validFresh.size}, stale ${validStale.size}, required ${thr})`;
      } else {
        publicationStatus = "INSUFFICIENT_EVIDENCE";
        evidenceSummary = `Quorum failed (${validFresh.size}/${total} distinct valid fresh log proofs, required ${thr})${notes.length ? ": " + notes.join("; ") : ""}`;
      }

      // Status: needs an answer from every pinned log to be complete
      const answered = new Set<string>();
      let anyRevoked = false;
      let hasStatusTampering = false;
      for (const obs of c2.statusObservations ?? []) {
        const pinned = pinnedById.get(obs.logId);
        if (!pinned || answered.has(obs.logId)) {
          notes.push(`status observation from ${obs.logId} ignored (unpinned or duplicate)`);
          continue;
        }
        const r = this.evaluateStatusObservation(obs, pinned, signedManifest, notes);
        if (r.invalidEntryReason) {
          hasStatusTampering = true;
          notes.push(`C2 status observation from ${obs.logId} rejected: ${r.invalidEntryReason}`);
        }
        if (r.answered) answered.add(obs.logId);
        if (r.revoked) anyRevoked = true;
      }
      if (anyRevoked && !hasStatusTampering) {
        revocationStatus = "REVOKED_AS_OF_EVIDENCE";
        statusCoverage = `${answered.size}/${total} pinned logs answered; revocation disclosed`;
      } else if (answered.size === total && !hasStatusTampering) {
        revocationStatus = "NO_REVOCATION_OBSERVED";
        statusObservations.push("NO_REVOCATION_OBSERVED");
        statusCoverage = `${answered.size}/${total} pinned logs answered`;
      } else {
        revocationStatus = "STATUS_UNKNOWN";
        statusCoverage = `${answered.size}/${total} pinned logs answered (missing: ${policy.c2.logs.filter((l) => !answered.has(l.logId)).map((l) => l.logId).join(", ")}${hasStatusTampering ? "; status tampering detected" : ""})`;
        if (answered.size > 0 && !hasStatusTampering) {
          // Diagnostic only: must not be read as current non-revocation.
          statusObservations.push("NO_REVOCATION_OBSERVED");
        }
      }
    } else if (evidence.architecture === "D") {
      const d = evidence as DEvidence;
      checkpointOrBlock = d.observedBlockNumber;
      const dp = policy.d;
      const rec = d.record;
      const problems: string[] = [];

      if (!dp) {
        problems.push("no pinned D chain/contract in policy");
      } else {
        if (d.chainId !== dp.chainId) problems.push(`chainId ${d.chainId} != pinned ${dp.chainId}`);
        if (safeAddr(d.contractAddress) !== safeAddr(dp.contractAddress)) problems.push("contract address differs from pinned contract");
      }
      if (!Number.isInteger(d.observedBlockNumber) || d.observedBlockNumber < 0) problems.push("observed block number missing/invalid");
      if (!HEX32.test(d.observedBlockHash ?? "")) problems.push("observed block hash missing/invalid");
      if (dp && d.headBlockNumberAtRead - d.observedBlockNumber + 1 < dp.confirmationDepth) {
        problems.push(`observed block not confirmed to depth ${dp.confirmationDepth}`);
      }

      let freshOk = true;
      if (policy.nowSec() - d.retrievedAt > policy.freshness.maxDReadAgeSec) freshOk = false;
      if (d.headBlockNumberAtRead - d.observedBlockNumber > policy.freshness.maxDBlockLag) freshOk = false;

      let recordMatches = true;
      if (d.status !== "NONE") {
        const manifestFields: Array<[string, boolean]> = [
          ["logicalBatchId", rec.logicalBatchId.toLowerCase() === manifest.logicalBatchId.toLowerCase()],
          ["batchContentId", rec.batchContentId.toLowerCase() === manifest.batchContentId.toLowerCase()],
          ["merkleRoot", rec.merkleRoot.toLowerCase() === manifest.merkleRoot.toLowerCase()],
          ["issuerAddress", rec.issuerAddress.toLowerCase() === manifest.issuerAddress.toLowerCase()],
          ["issuerKeyVersion", rec.issuerKeyVersion === manifest.issuerKeyVersion],
          ["credentialCount", rec.credentialCount === manifest.credentialCount],
          ["issuedAt", rec.issuedAt === manifest.issuedAt],
        ];
        for (const [name, ok] of manifestFields) {
          if (!ok) {
            recordMatches = false;
            problems.push(`on-chain ${name} differs from supplied manifest`);
          }
        }
        if (d.registeredBlockNumber <= 0 || d.registeredBlockNumber > d.observedBlockNumber) {
          problems.push("registeredBlockNumber inconsistent with observed block");
        }
      }

      if (problems.length > 0) {
        publicationStatus = "INSUFFICIENT_EVIDENCE";
        evidenceSummary = `D evidence rejected: ${problems.join("; ")}`;
        statusCoverage = "registry state not trusted";
      } else if (!freshOk) {
        publicationStatus = "STALE_EVIDENCE";
        evidenceValid = true;
        evidenceSummary = `D read at block #${d.observedBlockNumber} is stale (head #${d.headBlockNumberAtRead}; max lag ${policy.freshness.maxDBlockLag} blocks, max read age ${policy.freshness.maxDReadAgeSec}s)`;
        statusCoverage = "registry state stale";
      } else if (d.status === "NONE") {
        publicationStatus = "UNPUBLISHED";
        evidenceValid = true;
        evidenceFresh = true;
        evidenceSummary = `Batch not registered as of block #${d.observedBlockNumber}`;
        statusCoverage = `registry read at block #${d.observedBlockNumber}`;
      } else {
        evidenceValid = true;
        evidenceFresh = true;
        publicationStatus = "PUBLISHED";
        statusCoverage = `1/1 registry read at block #${d.observedBlockNumber}`;
        if (d.status === "REVOKED") {
          revocationStatus = "REVOKED_AS_OF_EVIDENCE";
          evidenceSummary = `Batch REVOKED in registry as of block #${d.observedBlockNumber}`;
        } else {
          revocationStatus = "NO_REVOCATION_OBSERVED";
          statusObservations.push("NO_REVOCATION_OBSERVED");
          evidenceSummary = `ACTIVE_AS_OF_BLOCK_${d.observedBlockNumber} (registered at #${d.registeredBlockNumber})`;
        }
      }
    }

    if (evidenceSummary === "") evidenceSummary = notes.join("; ");
    return { publicationStatus, revocationStatus, evidenceValid, evidenceFresh, evidenceSummary, statusCoverage, checkpointOrBlock, statusObservations, notes };
  }
}

function safeAddr(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a.toLowerCase();
  }
}
