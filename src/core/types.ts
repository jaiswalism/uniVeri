/**
 * Core type definitions for the Academic Certificate Verification Research Prototype
 * Implementation follows the Frozen Research Plan (C1, C2, D comparison)
 */

export type SchemaVersion = "1.0.0";

/**
 * Lifecycle state of a certificate record
 */
export type CertificateLifecycleState = "ISSUED" | "ACTIVE" | "REVOKED";

/**
 * Raw Academic Certificate (Off-chain private document)
 */
export interface AcademicCertificate {
  certificateId: string;
  studentId: string;
  studentName: string;
  degree: string;
  major: string;
  graduationDate: string;
  gpa: string;
  issuerId: string;
  issuedAt: number; // Unix timestamp in seconds
  salt: string;     // High-entropy random salt for privacy commitment
}

/**
 * Public Certificate Commitment (Leaves of Merkle Tree)
 */
export interface CertificateCommitment {
  certificateId: string;
  leafHash: string; // 0x... hex string
  salt: string;
}

/**
 * Single Merkle Proof step
 */
export interface MerkleProofStep {
  position: "left" | "right";
  data: string; // 0x... hash
}

/**
 * Merkle Inclusion Proof for a certificate inside a batch
 */
export interface MerkleInclusionProof {
  leafHash: string;
  leafIndex: number;
  merkleRoot: string;
  totalLeaves: number;
  proof: MerkleProofStep[];
}

/**
 * Signed Batch Manifest — Common publication unit across C1, C2, and D
 */
export interface BatchManifest {
  logicalBatchId: string;       // Stable issuer-scoped logical batch identifier
  batchContentId: string;       // Identifier for exact content + merkle root
  schemaVersion: SchemaVersion; // e.g., "1.0.0"
  issuerId: string;             // Issuer identifier (e.g., "did:uni:mit" or address)
  issuerAddress: string;        // EVM address corresponding to the signing key
  issuerKeyVersion: number;     // Key version (e.g., 1)
  institutionBatchNumber: number; // Monotonic batch sequence per issuer
  merkleRoot: string;           // Root of the Merkle tree of certificate leaf hashes
  credentialCount: number;      // Number of credentials in this batch
  issuedAt: number;             // Unix timestamp in seconds
}

export interface SignedBatchManifest {
  manifest: BatchManifest;
  institutionSignature: string; // 0x... secp256k1 signature (65 bytes hex)
}

/**
 * Signed Tree Checkpoint / Signed Tree Head (STH) for Transparency Logs (C1, C2)
 */
export interface SignedTreeCheckpoint {
  logId: string;              // Log identifier (e.g. "log-c1", "log-c2-a", "log-c2-b", "log-c2-c")
  treeSize: number;           // Total number of entries in the log
  rootHash: string;           // Merkle root of the append-only log
  timestamp: number;          // Timestamp of checkpoint generation
  signature: string;          // Log operator signature
}

/**
 * Inclusion Proof for a Batch Manifest inside a Transparency Log
 */
export interface LogInclusionProof {
  logId: string;
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  auditPath: MerkleProofStep[];
  checkpoint: SignedTreeCheckpoint;
}

/**
 * Issuer-signed revocation event (appended to transparency logs as a separate entry kind)
 * signature = EIP-191 signMessage(keccak256(abi.encode(logicalBatchId, batchContentId, issuerAddress, revokedAt, keccak256(reason))))
 */
export interface SignedRevocation {
  logicalBatchId: string;
  batchContentId: string;
  issuerAddress: string;
  reason: string;
  revokedAt: number;
  signature: string;
}

export interface RevocationProofEntry {
  event: SignedRevocation;
  inclusionProof: LogInclusionProof;
}

/**
 * A log's answer to a status query: the revocation entries it holds for the batch (possibly none),
 * together with the signed checkpoint relative to which the answer was given.
 * Absence of a revocation is NOT cryptographically proven; it only records what this log disclosed.
 */
export interface LogStatusObservation {
  logId: string;
  batchContentId: string;
  checkpoint: SignedTreeCheckpoint;
  revocations: RevocationProofEntry[];
  operatorSignature?: string;
  observedAt?: number;
}

/**
 * Architecture-specific Evidence
 */
export interface C1Evidence {
  architecture: "C1";
  logId: string;
  inclusionProof: LogInclusionProof;
  checkpoint: SignedTreeCheckpoint;
  status?: LogStatusObservation;
  statusError?: string;
  /** Other batchContentIds this log holds under the same logicalBatchId (observed conflicting versions) */
  conflictingContentIds?: string[];
  retrievedAt: number;
}

export interface C2LogProofEntry {
  logId: string;
  inclusionProof: LogInclusionProof;
  checkpoint: SignedTreeCheckpoint;
}

/**
 * C2 evidence. requiredQuorum / totalLogs / quorumMet are informational claims made by the evidence
 * supplier. The verifier NEVER uses them: the threshold and log set come from the pinned VerifierPolicy,
 * and a mismatching claim causes the evidence to be rejected.
 */
export interface C2Evidence {
  architecture: "C2";
  requiredQuorum: number;
  totalLogs: number;
  supportingProofs: C2LogProofEntry[];
  statusObservations?: LogStatusObservation[];
  unavailableStatusLogIds?: string[];
  conflictingContentIds?: string[];
  quorumMet: boolean;
  retrievedAt: number;
}

export interface BlockchainReceiptInfo {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  gasUsed: bigint;
  confirmations: number;
}

export type DRegistryStatus = "NONE" | "ACTIVE" | "REVOKED";

/**
 * D evidence as produced by a trusted retrieval adapter (an RPC read of the configured contract at an
 * explicit block). All manifest fields are the on-chain record values and are compared with the
 * supplied signed manifest by the verifier.
 */
export interface DEvidence {
  architecture: "D";
  chainId: number;
  contractAddress: string;
  record: {
    logicalBatchId: string;
    batchContentId: string;
    merkleRoot: string;
    issuerAddress: string;
    issuerKeyVersion: number;
    credentialCount: number;
    issuedAt: number;
  };
  status: DRegistryStatus;
  /** contentId the registry holds as canonical for the batch's logicalBatchId (zero hash if none) */
  canonicalContentId?: string;
  registeredBlockNumber: number;
  observedBlockNumber: number;
  observedBlockHash: string;
  observedBlockTimestamp: number;
  headBlockNumberAtRead: number;
  receipt?: BlockchainReceiptInfo;
  retrievedAt: number;
}

export type ArchitectureEvidence = C1Evidence | C2Evidence | DEvidence;

/**
 * Frozen Verification Result Vocabulary (Section 14 of Research Plan)
 */
export type AuthStatus = "AUTHENTIC" | "NOT_AUTHENTIC" | "UNKNOWN";
export type PublicationStatus = "PUBLISHED" | "UNPUBLISHED" | "INSUFFICIENT_EVIDENCE" | "STALE_EVIDENCE";
export type ObservableRevocationStatus = "NO_REVOCATION_OBSERVED" | "REVOKED_AS_OF_EVIDENCE" | "STATUS_UNKNOWN";

/**
 * Overall verifier result. It is deliberately NOT an unconditional "valid" flag:
 *  - REJECTED: not authentic, unpublished/insufficient/stale evidence, or revoked as of the evidence.
 *  - INCONCLUSIVE: authentic + published but status evidence is incomplete (STATUS_UNKNOWN).
 *  - ACCEPTED_AS_OF_EVIDENCE_BOUNDARY: authentic + published + every status source in the pinned
 *    policy answered without disclosing a revocation. Relative to the recorded checkpoint/block
 *    boundary only; it never means "currently not revoked".
 */
export type OverallResult = "REJECTED" | "INCONCLUSIVE" | "ACCEPTED_AS_OF_EVIDENCE_BOUNDARY";

export interface VerificationReport {
  certificateId: string;
  architecture: "C1" | "C2" | "D";
  authStatus: AuthStatus;
  publicationStatus: PublicationStatus;
  revocationStatus: ObservableRevocationStatus;
  overallResult: OverallResult;
  /** Diagnostic observations, e.g. NO_REVOCATION_OBSERVED recorded while revocationStatus is STATUS_UNKNOWN */
  statusObservations: string[];
  /** Human-readable description of status coverage (e.g. "2/3 pinned logs answered") */
  statusCoverage: string;
  evidenceFresh: boolean;
  rejectionReasons: string[];
  merkleProofValid: boolean;
  manifestSignatureValid: boolean;
  evidenceValid: boolean;
  evidenceSummary: string;
  details: {
    leafHash: string;
    merkleRoot: string;
    logicalBatchId: string;
    batchContentId: string;
    issuerAddress: string;
    checkpointOrBlock: number | string;
    latencyMs: number;
  };
  isVerified: boolean;
  rawEvidence: ArchitectureEvidence | null;
}

/**
 * Trial Outcomes (Section 20 of Research Plan)
 */
export type TrialOutcome =
  | "SUCCESS"
  | "TIMEOUT"
  | "REJECTED"
  | "INSUFFICIENT_EVIDENCE"
  | "STALE_EVIDENCE"
  | "INFRASTRUCTURE_ERROR";

/**
 * Failure Injection Configuration (Section 17 of Research Plan)
 */
export interface FailureConfig {
  c1?: {
    unavailable?: boolean;
    censor?: boolean;
    delayMs?: number;
    corruptProof?: boolean;
  };
  c2?: {
    failingLogIds?: string[]; // Log IDs that fail
    delayLogIds?: { [logId: string]: number };
    censorLogIds?: string[];
  };
  d?: {
    endpointUnavailable?: boolean;
    delayMs?: number;
    revertTx?: boolean;
  };
}

/**
 * Benchmark Trial Record
 */
export interface TrialRecord {
  trialId: string;
  repetitionIndex: number;
  architecture: "C1" | "C2" | "D";
  workload: {
    N: number; // Total certificates
    K: number; // Certificates per batch
    B: number; // Batch count
  };
  failureScenario: string;
  outcome: TrialOutcome;
  acceptanceLatencyMs: number;
  evidenceCompletionLatencyMs: number;
  verificationLatencyMs: number;
  storageBytes: {
    offChainPackageBytes: number;
    publicationLayerStorageBytes: number;
    proofBytes: number;
  };
  blockchainMetrics?: {
    gasUsedPerBatch: number;
    totalGasUsed: number;
    calldataBytes: number;
  };
  timestamp: number;
}
