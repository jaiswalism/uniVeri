import hre from "hardhat";
import { Wallet, HDNodeWallet, ethers, Contract } from "ethers";
import { LogClusterManager } from "../services/transparency-log/log-manager.js";
import { IndependentPublisher, LateEvent } from "../publisher/independent-publisher.js";
import { CommonVerifier, buildVerifierPolicy } from "../verifier/common-verifier.js";
import { RegistryRetrievalAdapter, createFaultInjectingRunner } from "../services/registry-adapter.js";
import { EvidenceRetriever } from "../verifier/evidence-retriever.js";
import {
  AcademicCertificate,
  ArchitectureEvidence,
  AuthStatus,
  BatchManifest,
  C1Evidence,
  C2Evidence,
  DEvidence,
  MerkleInclusionProof,
  ObservableRevocationStatus,
  PublicationStatus,
  SignedBatchManifest,
  TrialOutcome,
} from "../core/types.js";
import { generateWorkload, WorkloadPackage } from "./workload.js";
import { hashCertificateLeaf } from "../core/canonical.js";
import { MerkleTree } from "../core/merkle.js";
import { createBatchManifest, signBatchManifest } from "../core/manifest.js";
import {
  createCertificateCommitment,
  generateSyntheticCertificate,
  generateWorkloadCertificates,
} from "../core/certificate.js";

/**
 * 05-experiment-results-specification.md: Workload Definitions
 */
export interface WorkloadSpecConfig {
  id: "W1" | "W2" | "W3" | "W4" | "W5" | "W6";
  N: number; // Total certificates
  K: number; // Max certificates per batch
  B: number; // Number of batches
  description: string;
}

export const WORKLOAD_MATRIX: WorkloadSpecConfig[] = [
  { id: "W1", N: 1000, K: 100, B: 10, description: "Small baseline" },
  { id: "W2", N: 10000, K: 100, B: 100, description: "N-scaling with fixed K=100" },
  { id: "W3", N: 50000, K: 100, B: 500, description: "Large N with small K=100 (B=500)" },
  { id: "W4", N: 10000, K: 1000, B: 10, description: "Moderate workload for failure experiments" },
  { id: "W5", N: 50000, K: 1000, B: 50, description: "Large workload with medium batch K=1000" },
  { id: "W6", N: 50000, K: 10000, B: 5, description: "Large workload with large batch K=10000" },
];

export const FAILURE_INTERVENTIONS = [
  { id: "C1_SOLE_LOG_UNAVAILABLE", arch: "C1", desc: "Sole log unavailable (in-process endpoint failure)" },
  { id: "C1_SOLE_LOG_OMISSION", arch: "C1", desc: "Sole log acknowledges but omits inclusion evidence" },
  { id: "C2_ONE_LOG_UNAVAILABLE", arch: "C2", desc: "Log Alpha unavailable; Beta and Gamma healthy (2/3 quorum)" },
  { id: "C2_ONE_LOG_OMISSION", arch: "C2", desc: "Log Alpha omits inclusion; Beta and Gamma healthy (2/3 quorum)" },
  { id: "D_ENDPOINT_UNAVAILABLE", arch: "D", desc: "Blockchain endpoint unavailable (in-process mock fault)" },
  { id: "D_PROCESSING_DELAYED", arch: "D", desc: "Transaction processing delayed past deadline" },
] as const;

export interface PublicationTrialRow {
  runId: string;
  architecture: "C1" | "C2" | "D";
  scenario: string;
  N: number;
  K: number;
  B: number;
  batchId: string;
  submissionTime: number;
  firstAcceptanceTime: number | null;
  quorumAcceptanceTime: number | null;
  evidenceCompletionTime: number | null;
  outcome: TrialOutcome;
  attemptCount: number;
  supportingLogIds: string;
  evidenceBoundary: string;
}

export interface VerificationQueryRow {
  runId: string;
  queryId: string;
  batchId: string;
  cacheMode: "FRESH_NETWORK" | "CACHED";
  retrievalLatencyMs: number;
  localVerificationLatencyMs: number;
  totalLatencyMs: number;
  evidenceAvailable: boolean;
  evidenceFresh: boolean;
  authenticationResult: AuthStatus;
  publicationResult: PublicationStatus;
  statusResult: ObservableRevocationStatus;
  evidenceBoundary: string;
}

export interface ResourceMeasurementRow {
  runId: string;
  architecture: "C1" | "C2" | "D" | "COMMON";
  component: string;
  metricName: string;
  value: number;
  unit: string;
  measurementBoundary: string;
}

export interface CorrectnessTestRow {
  testCaseId: string;
  description: string;
  architecture: "C1" | "C2" | "D";
  expectedAuth: AuthStatus;
  observedAuth: AuthStatus;
  expectedPub: PublicationStatus;
  observedPub: PublicationStatus;
  expectedStatus: ObservableRevocationStatus;
  observedStatus: ObservableRevocationStatus;
  passFail: "PASS" | "FAIL";
}

export interface PublicationTraceRow {
  runId: string;
  architecture: "C1" | "C2" | "D";
  scenario: string;
  batchId: string;
  submissionMs: number;
  firstAcceptanceMs: number | null;
  quorumAcceptanceMs: number | null;
  evidenceCompletionMs: number | null;
  outcome: TrialOutcome;
  attemptsCount: number;
  perLogTimings?: Array<{ logId: string; acceptedAtMs: number; validatedAtMs: number | null; proofClass: string }>;
  provenance?: {
    txHash?: string;
    blockNumber?: number | null;
    gasUsed?: string;
    calldataBytes?: number;
    eventBytes?: number | null;
    checkpointRoot?: string;
    treeSize?: number;
  };
  lateObservations?: Array<{ op: string; target: string; completedAtMs: number; detail?: string }>;
}

/**
 * Specification-Compliant Experiment Engine with Live EVM Contract Execution
 */
export class SpecExperimentEngine {
  public logManager: LogClusterManager;
  public publisher: IndependentPublisher;
  public verifier: CommonVerifier;

  public registryContract: any = null;
  public registryAdapter: RegistryRetrievalAdapter | null = null;
  public deployerSigner: any = null;
  public publisherSigner: any = null;

  public publicationTrials: PublicationTrialRow[] = [];
  public verificationQueries: VerificationQueryRow[] = [];
  public resourceMeasurements: ResourceMeasurementRow[] = [];
  public correctnessTests: CorrectnessTestRow[] = [];
  public publicationTraces: PublicationTraceRow[] = [];

  constructor() {
    this.logManager = new LogClusterManager();
    this.publisher = new IndependentPublisher(this.logManager);
    this.verifier = new CommonVerifier(this.logManager);
    this.publisher.setValidator(this.verifier);
  }

  /**
   * Deploys the AcademicCertificateRegistry smart contract onto the Hardhat EVM
   */
  public async initEVM(): Promise<void> {
    const [deployer, publisher] = await hre.ethers.getSigners();
    this.deployerSigner = deployer;
    this.publisherSigner = publisher;

    const Factory = await hre.ethers.getContractFactory("AcademicCertificateRegistry");
    this.registryContract = await Factory.deploy();
    await this.registryContract.waitForDeployment();
    const address = await this.registryContract.getAddress();

    this.registryAdapter = new RegistryRetrievalAdapter(this.registryContract as any, hre.ethers.provider as any, 1);
    this.publisher.setRegistry(this.registryContract.connect(publisher) as any, this.registryAdapter, hre.ethers.provider as any);

    const policy = buildVerifierPolicy({
      logManager: this.logManager,
      issuer: null, // set per workload
      d: { chainId: 31337, contractAddress: address, confirmationDepth: 1 },
    });
    this.verifier.setPolicy(policy);
  }

  /**
   * Resets and deploys a clean smart contract instance on EVM for a fresh run
   */
  public async resetEVM(issuerId?: string, issuerAddress?: string): Promise<void> {
    const Factory = await hre.ethers.getContractFactory("AcademicCertificateRegistry");
    this.registryContract = await Factory.deploy();
    await this.registryContract.waitForDeployment();
    const address = await this.registryContract.getAddress();

    this.registryAdapter = new RegistryRetrievalAdapter(this.registryContract as any, hre.ethers.provider as any, 1);
    this.publisher.setRegistry(this.registryContract.connect(this.publisherSigner) as any, this.registryAdapter, hre.ethers.provider as any);

    if (issuerId && issuerAddress) {
      const regTx = await (this.registryContract.connect(this.deployerSigner) as any).registerIssuer(issuerId, issuerAddress);
      await regTx.wait(1);

      const policy = buildVerifierPolicy({
        logManager: this.logManager,
        issuer: { issuerId, address: issuerAddress, keyVersion: 1 },
        d: { chainId: 31337, contractAddress: address, confirmationDepth: 1 },
      });
      this.verifier.setPolicy(policy);
    }
  }

  /**
   * Section 5: Correctness and Uncertainty Tests on Live EVM and Logs
   */
  public async runCorrectnessTests(): Promise<CorrectnessTestRow[]> {
    if (!this.registryContract) {
      await this.initEVM();
    }

    const rows: CorrectnessTestRow[] = [];
    const issuerWallet = Wallet.createRandom();
    this.logManager.resetAll();
    await this.resetEVM("did:edu:mit", issuerWallet.address);

    // Setup a base batch
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

    // Publish to C1, C2, and D (real EVM transaction)
    const pubC1 = await this.publisher.publishToC1(signedManifest);
    const pubC2 = await this.publisher.publishToC2(signedManifest);
    const pubD = await this.publisher.publishToD(signedManifest);

    // Test 1: Unmodified certificate with sufficient publication evidence
    const r1 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: pubC1.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-1",
      description: "Unmodified certificate with sufficient publication evidence",
      architecture: "C1",
      expectedAuth: "AUTHENTIC",
      observedAuth: r1.authStatus,
      expectedPub: "PUBLISHED",
      observedPub: r1.publicationStatus,
      expectedStatus: "NO_REVOCATION_OBSERVED",
      observedStatus: r1.revocationStatus,
      passFail: r1.authStatus === "AUTHENTIC" && r1.publicationStatus === "PUBLISHED" && r1.isVerified ? "PASS" : "FAIL",
    });

    // Test 2: Modified certificate (Tampered academic claim)
    const tamperedCert = { ...cert, gpa: "4.00 (Tampered)" };
    const r2 = this.verifier.verifyCertificate({
      certificate: tamperedCert,
      merkleProof: leafProof,
      signedManifest,
      evidence: pubC1.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-2",
      description: "Modified certificate (Tampered academic claim)",
      architecture: "C1",
      expectedAuth: "NOT_AUTHENTIC",
      observedAuth: r2.authStatus,
      expectedPub: "PUBLISHED",
      observedPub: r2.publicationStatus,
      expectedStatus: "NO_REVOCATION_OBSERVED",
      observedStatus: r2.revocationStatus,
      passFail: r2.authStatus === "NOT_AUTHENTIC" && !r2.isVerified ? "PASS" : "FAIL",
    });

    // Test 3: Invalid Merkle proof path
    const corruptProof: MerkleInclusionProof = {
      ...leafProof,
      proof: [{ position: "left", data: "0x" + "00".repeat(32) }],
    };
    const r3 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: corruptProof,
      signedManifest,
      evidence: pubC1.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-3",
      description: "Invalid Merkle proof path",
      architecture: "C1",
      expectedAuth: "NOT_AUTHENTIC",
      observedAuth: r3.authStatus,
      expectedPub: "PUBLISHED",
      observedPub: r3.publicationStatus,
      expectedStatus: "NO_REVOCATION_OBSERVED",
      observedStatus: r3.revocationStatus,
      passFail: r3.authStatus === "NOT_AUTHENTIC" && !r3.isVerified ? "PASS" : "FAIL",
    });

    // Test 4: Invalid institution signature (Priority 1: NOT_AUTHENTIC with configured key)
    const corruptManifest: SignedBatchManifest = {
      ...signedManifest,
      institutionSignature: "0x" + "11".repeat(65),
    };
    const r4 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest: corruptManifest,
      evidence: pubC1.evidence!,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-4",
      description: "Invalid institution signature (Evaluated with configured trusted key)",
      architecture: "C1",
      expectedAuth: "NOT_AUTHENTIC",
      observedAuth: r4.authStatus,
      expectedPub: "INSUFFICIENT_EVIDENCE",
      observedPub: r4.publicationStatus,
      expectedStatus: "STATUS_UNKNOWN",
      observedStatus: r4.revocationStatus,
      passFail:
        r4.authStatus === "NOT_AUTHENTIC" &&
        r4.publicationStatus === "INSUFFICIENT_EVIDENCE" &&
        r4.revocationStatus === "STATUS_UNKNOWN" &&
        !r4.isVerified
          ? "PASS"
          : "FAIL",
    });

    // Test 5: Valid certificate with unavailable/invalid publication evidence
    const r5 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: null,
      architecture: "C1",
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-5",
      description: "Valid certificate with unavailable/invalid publication evidence",
      architecture: "C1",
      expectedAuth: "AUTHENTIC",
      observedAuth: r5.authStatus,
      expectedPub: "INSUFFICIENT_EVIDENCE",
      observedPub: r5.publicationStatus,
      expectedStatus: "STATUS_UNKNOWN",
      observedStatus: r5.revocationStatus,
      passFail:
        r5.authStatus === "AUTHENTIC" &&
        r5.publicationStatus === "INSUFFICIENT_EVIDENCE" &&
        r5.revocationStatus === "STATUS_UNKNOWN" &&
        !r5.isVerified
          ? "PASS"
          : "FAIL",
    });

    // Test 6: Genuinely signed stale checkpoint (STALE_EVIDENCE)
    this.logManager.logC1.setFailureOptions({ staleCheckpointAgeSec: 600 });
    const staleCp = await this.logManager.logC1.createCheckpoint();
    const staleProof = await this.logManager.logC1.getInclusionProof(manifest.batchContentId);
    this.logManager.logC1.clearFailureOptions();

    const staleEvidence: C1Evidence = {
      architecture: "C1",
      logId: this.logManager.logC1.logId,
      inclusionProof: staleProof,
      checkpoint: staleCp,
      retrievedAt: Math.floor(Date.now() / 1000),
    };
    const r6 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: staleEvidence,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-6",
      description: "Genuinely signed stale checkpoint (Age > 300s maxCheckpointAgeSec)",
      architecture: "C1",
      expectedAuth: "AUTHENTIC",
      observedAuth: r6.authStatus,
      expectedPub: "STALE_EVIDENCE",
      observedPub: r6.publicationStatus,
      expectedStatus: "STATUS_UNKNOWN",
      observedStatus: r6.revocationStatus,
      passFail:
        r6.authStatus === "AUTHENTIC" &&
        r6.publicationStatus === "STALE_EVIDENCE" &&
        r6.revocationStatus === "STATUS_UNKNOWN" &&
        !r6.isVerified
          ? "PASS"
          : "FAIL",
    });

    // Test 7: Verified institution-authorized revocation on real EVM contract (fetch changed state)
    // 1. Fund the issuer wallet so it can submit on-chain transactions
    await this.deployerSigner.sendTransaction({
      to: issuerWallet.address,
      value: hre.ethers.parseEther("0.1"),
    });
    const connectedIssuerSigner = issuerWallet.connect(hre.ethers.provider as any);

    // 2. Confirm unauthorized third-party revocation is rejected
    const unauthorizedSigner = Wallet.createRandom().connect(hre.ethers.provider as any);
    await this.deployerSigner.sendTransaction({
      to: unauthorizedSigner.address,
      value: hre.ethers.parseEther("0.05"),
    });
    let unauthorizedFailed = false;
    try {
      await (this.registryContract.connect(unauthorizedSigner) as any).revokeBatch(
        manifest.batchContentId,
        "Malicious attempt"
      );
    } catch {
      unauthorizedFailed = true;
    }
    if (!unauthorizedFailed) {
      throw new Error("TC-7: Unauthorized third party was able to revoke batch");
    }

    // 3. Confirm batch on-chain record issuerAddress matches issuerWallet.address
    const onChainRecord = await this.registryContract.getBatch(manifest.batchContentId);
    if (onChainRecord.issuerAddress.toLowerCase() !== issuerWallet.address.toLowerCase()) {
      throw new Error("TC-7: On-chain batch record issuer does not match test issuer");
    }

    // 4. Execute revocation via institution issuerSigner
    const revokeTx = await (this.registryContract.connect(connectedIssuerSigner) as any).revokeBatch(
      manifest.batchContentId,
      "Degree Rescinded Due to Academic Misconduct"
    );
    await revokeTx.wait(1);

    // Fetch the updated on-chain state via adapter
    const fetchedRevokedD = await this.registryAdapter!.readEvidence(manifest.batchContentId);
    const r7 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: fetchedRevokedD,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-7",
      description: "Verified institution-authorized revocation on blockchain registry (EVM executed)",
      architecture: "D",
      expectedAuth: "AUTHENTIC",
      observedAuth: r7.authStatus,
      expectedPub: "PUBLISHED",
      observedPub: r7.publicationStatus,
      expectedStatus: "REVOKED_AS_OF_EVIDENCE",
      observedStatus: r7.revocationStatus,
      passFail:
        r7.authStatus === "AUTHENTIC" &&
        r7.publicationStatus === "PUBLISHED" &&
        r7.revocationStatus === "REVOKED_AS_OF_EVIDENCE" &&
        !r7.isVerified
          ? "PASS"
          : "FAIL",
    });

    // Test 8: Two C2 issuance proofs while another log is unavailable -> STATUS_UNKNOWN with diagnostic NO_REVOCATION_OBSERVED
    const partialC2Evidence: C2Evidence = {
      architecture: "C2",
      requiredQuorum: 2,
      totalLogs: 3,
      supportingProofs: [
        (pubC2.evidence as C2Evidence).supportingProofs[0],
        (pubC2.evidence as C2Evidence).supportingProofs[1],
      ],
      statusObservations: [
        (pubC2.evidence as C2Evidence).statusObservations ? (pubC2.evidence as C2Evidence).statusObservations![0] : {
          logId: this.logManager.logC2A.logId,
          batchContentId: manifest.batchContentId,
          checkpoint: (pubC2.evidence as C2Evidence).supportingProofs[0].checkpoint,
          revocations: [],
        },
        (pubC2.evidence as C2Evidence).statusObservations ? (pubC2.evidence as C2Evidence).statusObservations![1] : {
          logId: this.logManager.logC2B.logId,
          batchContentId: manifest.batchContentId,
          checkpoint: (pubC2.evidence as C2Evidence).supportingProofs[1].checkpoint,
          revocations: [],
        },
      ], // 3rd log (Gamma) unavailable for status
      quorumMet: true,
      retrievedAt: Math.floor(Date.now() / 1000),
    };
    const r8 = this.verifier.verifyCertificate({
      certificate: cert,
      merkleProof: leafProof,
      signedManifest,
      evidence: partialC2Evidence,
      trustedIssuerAddress: issuerWallet.address,
    });
    rows.push({
      testCaseId: "TC-8",
      description: "Two C2 issuance proofs with 1 log down (safe uncertainty: STATUS_UNKNOWN)",
      architecture: "C2",
      expectedAuth: "AUTHENTIC",
      observedAuth: r8.authStatus,
      expectedPub: "PUBLISHED",
      observedPub: r8.publicationStatus,
      expectedStatus: "STATUS_UNKNOWN",
      observedStatus: r8.revocationStatus,
      passFail:
        r8.authStatus === "AUTHENTIC" &&
        r8.publicationStatus === "PUBLISHED" &&
        r8.revocationStatus === "STATUS_UNKNOWN" &&
        r8.statusObservations.includes("NO_REVOCATION_OBSERVED") &&
        !r8.isVerified
          ? "PASS"
          : "FAIL",
    });

    this.correctnessTests = rows;
    return rows;
  }

  /**
   * Runs the complete specification simulation: Normal-operation matrix (W1-W6) + Failure interventions
   * Directly executing against Hardhat EVM for Architecture D and live Transparency Logs for C1/C2.
   */
  public async runSpecificationExperiment(
    repetitions: number = 10,
    onProgress?: (msg: string) => void
  ): Promise<{
    publicationTrials: PublicationTrialRow[];
    verificationQueries: VerificationQueryRow[];
    resourceMeasurements: ResourceMeasurementRow[];
    correctnessTests: CorrectnessTestRow[];
    runConfig: any;
  }> {
    this.publicationTrials = [];
    this.verificationQueries = [];
    this.resourceMeasurements = [];
    this.publicationTraces = [];

    // Initialize EVM contract
    await this.initEVM();

    // 0. Warm-Up Phase: Prime EVM JIT, JSON serializers, and Merkle tree engines
    if (onProgress) onProgress("Executing warm-up trials to prime EVM, JIT, and Merkle engines...");
    const warmupIssuer = Wallet.createRandom();
    await this.resetEVM("did:edu:warmup", warmupIssuer.address);
    const warmupWorkload = await generateWorkload(10, 5, "did:edu:warmup", warmupIssuer);
    for (const warmArch of ["C1", "C2", "D"] as const) {
      for (const batch of warmupWorkload.batches) {
        if (warmArch === "C1") await this.publisher.publishToC1(batch.signedManifest);
        else if (warmArch === "C2") await this.publisher.publishToC2(batch.signedManifest);
        else await this.publisher.publishToD(batch.signedManifest);
      }
    }
    this.logManager.resetAll();

    // First run Correctness Tests
    if (onProgress) onProgress("Executing Section 5 Correctness & Uncertainty Test Suite (Live EVM & Logs)...");
    await this.runCorrectnessTests();

    // Pre-generate shared synthetic certificates and issuer for fixed-N=50,000 comparisons (W3, W5, W6)
    const fixed50kIssuerWallet = Wallet.createRandom();
    const fixed50kIssuerId = "did:edu:mit-fixed50k";
    const fixed50kCertificates = generateWorkloadCertificates(50000, fixed50kIssuerId);

    // 1. Normal Operation Matrix: W1 through W6
    for (const workloadDef of WORKLOAD_MATRIX) {
      if (onProgress) {
        onProgress(`Executing Normal Operation Workload ${workloadDef.id} (N=${workloadDef.N}, K=${workloadDef.K}, B=${workloadDef.B})...`);
      }

      let workload: WorkloadPackage;
      if (workloadDef.N === 50000) {
        workload = await generateWorkload(
          workloadDef.N,
          workloadDef.K,
          fixed50kIssuerId,
          fixed50kIssuerWallet,
          fixed50kCertificates
        );
      } else {
        workload = await generateWorkload(
          workloadDef.N,
          workloadDef.K,
          `did:edu:${workloadDef.id.toLowerCase()}`
        );
      }

      // Measure Common Preprocessing Resource Overhead
      const offChainPackageBytes =
        Buffer.byteLength(JSON.stringify(workload.batches.map((b) => b.certificates)), "utf8") +
        Buffer.byteLength(JSON.stringify(workload.batches.map((b) => b.leafProofs)), "utf8");

      this.resourceMeasurements.push({
        runId: `RUN-PRE-${workloadDef.id}`,
        architecture: "COMMON",
        component: "PREPROCESSOR",
        metricName: "OFF_CHAIN_PACKAGE_BYTES",
        value: offChainPackageBytes,
        unit: "BYTES",
        measurementBoundary: "PER_WORKLOAD_PAYLOAD",
      });

      for (let rep = 1; rep <= repetitions; rep++) {
        // Execution-order rotation across repetitions: Latin-square cyclic permutation
        const baseArchitectures: Array<"C1" | "C2" | "D"> = ["C1", "C2", "D"];
        const orderOffset = (rep - 1) % 3;
        const architectures: Array<"C1" | "C2" | "D"> = [
          baseArchitectures[orderOffset],
          baseArchitectures[(orderOffset + 1) % 3],
          baseArchitectures[(orderOffset + 2) % 3],
        ];

        for (const arch of architectures) {
          const runId = `RUN-NORM-${workloadDef.id}-${arch}-REP${rep}`;
          this.logManager.resetAll();
          if (arch === "D") {
            await this.resetEVM(workload.issuerId, workload.issuerWallet.address);
          } else {
            const policy = buildVerifierPolicy({
              logManager: this.logManager,
              issuer: { issuerId: workload.issuerId, address: workload.issuerWallet.address, keyVersion: 1 },
              d: this.registryContract ? { chainId: 31337, contractAddress: await this.registryContract.getAddress(), confirmationDepth: 1 } : null,
            });
            this.verifier.setPolicy(policy);
          }

          let totalGasForWorkload = 0;
          let measuredCalldataBytes = 0;
          let measuredEventBytes = 0;

          for (let b = 0; b < workload.batches.length; b++) {
            const batch = workload.batches[b];
            const batchId = batch.manifest.logicalBatchId;

            let pubResult;
            if (arch === "C1") {
              pubResult = await this.publisher.publishToC1(batch.signedManifest);
            } else if (arch === "C2") {
              pubResult = await this.publisher.publishToC2(batch.signedManifest);
            } else {
              pubResult = await this.publisher.publishToD(batch.signedManifest);
              if (pubResult.gasUsed) totalGasForWorkload += Number(pubResult.gasUsed);
              if (pubResult.d?.calldataBytes) measuredCalldataBytes += pubResult.d.calldataBytes;
              if (pubResult.d?.eventBytes) measuredEventBytes += pubResult.d.eventBytes;
            }

            let supportingLogIds = "";
            let evidenceBoundary = "";

            if (pubResult.evidence?.architecture === "C1") {
              supportingLogIds = (pubResult.evidence as C1Evidence).logId;
              evidenceBoundary = `TREE_SIZE_${(pubResult.evidence as C1Evidence).checkpoint.treeSize}`;
            } else if (pubResult.evidence?.architecture === "C2") {
              supportingLogIds = (pubResult.evidence as C2Evidence).supportingProofs.map((p) => p.logId).join(";");
              evidenceBoundary = `QUORUM_${(pubResult.evidence as C2Evidence).supportingProofs.length}_OF_3`;
            } else if (pubResult.evidence?.architecture === "D") {
              supportingLogIds = "BLOCKCHAIN_EVM";
              evidenceBoundary = `BLOCK_${(pubResult.evidence as DEvidence).registeredBlockNumber}`;
            }

            this.publicationTrials.push({
              runId,
              architecture: arch,
              scenario: "NORMAL_OPERATION",
              N: workloadDef.N,
              K: workloadDef.K,
              B: workloadDef.B,
              batchId,
              submissionTime: pubResult.submissionMs,
              firstAcceptanceTime: pubResult.firstAcceptanceMs,
              quorumAcceptanceTime: pubResult.quorumAcceptanceMs,
              evidenceCompletionTime: pubResult.evidenceCompletionMs,
              outcome: pubResult.outcome,
              attemptCount: pubResult.attemptsAtResult,
              supportingLogIds,
              evidenceBoundary,
            });

            this.publicationTraces.push({
              runId,
              architecture: arch,
              scenario: "NORMAL_OPERATION",
              batchId,
              submissionMs: pubResult.submissionMs,
              firstAcceptanceMs: pubResult.firstAcceptanceMs,
              quorumAcceptanceMs: pubResult.quorumAcceptanceMs,
              evidenceCompletionMs: pubResult.evidenceCompletionMs,
              outcome: pubResult.outcome,
              attemptsCount: pubResult.attemptsAtResult,
              perLogTimings: pubResult.perLogAcceptance.map((a, idx) => ({
                logId: a.logId,
                acceptedAtMs: a.acceptedAtMs,
                validatedAtMs: pubResult.perLogEvidence[idx]?.validatedAtMs ?? null,
                proofClass: pubResult.perLogEvidence[idx]?.cls ?? "VALID",
              })),
              provenance: {
                txHash: pubResult.d?.txHash,
                blockNumber: pubResult.d?.blockNumber,
                gasUsed: pubResult.d?.gasUsed?.toString(),
                calldataBytes: pubResult.d?.calldataBytes,
                eventBytes: pubResult.d?.eventBytes,
                checkpointRoot: pubResult.evidence?.architecture === "C1"
                  ? (pubResult.evidence as C1Evidence).checkpoint.rootHash
                  : pubResult.evidence?.architecture === "C2"
                    ? (pubResult.evidence as C2Evidence).supportingProofs[0]?.checkpoint.rootHash
                    : undefined,
                treeSize: pubResult.evidence?.architecture === "C1"
                  ? (pubResult.evidence as C1Evidence).checkpoint.treeSize
                  : pubResult.evidence?.architecture === "C2"
                    ? (pubResult.evidence as C2Evidence).supportingProofs[0]?.checkpoint.treeSize
                    : undefined,
              },
              lateObservations: pubResult.late,
            });

            // Post-Publication Verification Query (Sample batch 0)
            if (b === 0 && pubResult.outcome === "SUCCESS") {
              // 1. FRESH_NETWORK mode: fetch evidence directly via independent retriever
              const retriever = new EvidenceRetriever(this.logManager, this.registryAdapter);
              const { evidence: retrievedEvidence, retrievalMs } = await retriever.fetch(arch, batch.signedManifest);

              const valStart = performance.now();
              const vReport = this.verifier.verifyCertificate({
                certificate: batch.certificates[0],
                merkleProof: batch.leafProofs[0],
                signedManifest: batch.signedManifest,
                evidence: retrievedEvidence,
                architecture: arch,
              });
              const localVerificationLatencyMs = performance.now() - valStart;
              const totalLatencyMs = retrievalMs + localVerificationLatencyMs;

              this.verificationQueries.push({
                runId,
                queryId: `Q-FRESH-${runId}-B0`,
                batchId,
                cacheMode: "FRESH_NETWORK",
                retrievalLatencyMs: retrievalMs,
                localVerificationLatencyMs,
                totalLatencyMs,
                evidenceAvailable: retrievedEvidence !== null,
                evidenceFresh: vReport.evidenceFresh,
                authenticationResult: vReport.authStatus,
                publicationResult: vReport.publicationStatus,
                statusResult: vReport.revocationStatus,
                evidenceBoundary: vReport.details.checkpointOrBlock ? vReport.details.checkpointOrBlock.toString() : "UNAVAILABLE",
              });

              // 2. CACHED mode: verification against local cache without network retrieval
              const cachedStart = performance.now();
              const vReportCached = this.verifier.verifyCertificate({
                certificate: batch.certificates[0],
                merkleProof: batch.leafProofs[0],
                signedManifest: batch.signedManifest,
                evidence: retrievedEvidence,
                architecture: arch,
              });
              const cachedTotalLatencyMs = performance.now() - cachedStart;

              this.verificationQueries.push({
                runId,
                queryId: `Q-CACHED-${runId}-B0`,
                batchId,
                cacheMode: "CACHED",
                retrievalLatencyMs: 0,
                localVerificationLatencyMs: vReportCached.details.latencyMs,
                totalLatencyMs: cachedTotalLatencyMs,
                evidenceAvailable: retrievedEvidence !== null,
                evidenceFresh: vReportCached.evidenceFresh,
                authenticationResult: vReportCached.authStatus,
                publicationResult: vReportCached.publicationStatus,
                statusResult: vReportCached.revocationStatus,
                evidenceBoundary: vReportCached.details.checkpointOrBlock ? vReportCached.details.checkpointOrBlock.toString() : "UNAVAILABLE",
              });
            }
          }

          // Record Publication Storage & Resource Metrics
          if (arch === "C1") {
            const acc = this.logManager.logC1.getStorageAccounting();
            this.resourceMeasurements.push({
              runId,
              architecture: "C1",
              component: "LOG_C1_PRIMARY",
              metricName: "LOG_SERIALIZED_BYTES",
              value: acc.totalSerializedBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_SERIALIZED_STATE",
            });
          } else if (arch === "C2") {
            const accA = this.logManager.logC2A.getStorageAccounting();
            const accB = this.logManager.logC2B.getStorageAccounting();
            const accC = this.logManager.logC2C.getStorageAccounting();
            const total = accA.totalSerializedBytes + accB.totalSerializedBytes + accC.totalSerializedBytes;

            this.resourceMeasurements.push({
              runId,
              architecture: "C2",
              component: "LOG_C2_ALPHA",
              metricName: "LOG_SERIALIZED_BYTES",
              value: accA.totalSerializedBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_SERIALIZED_STATE",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "C2",
              component: "LOG_C2_BETA",
              metricName: "LOG_SERIALIZED_BYTES",
              value: accB.totalSerializedBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_SERIALIZED_STATE",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "C2",
              component: "LOG_C2_GAMMA",
              metricName: "LOG_SERIALIZED_BYTES",
              value: accC.totalSerializedBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_SERIALIZED_STATE",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "C2",
              component: "LOG_C2_AGGREGATE",
              metricName: "LOG_SERIALIZED_BYTES",
              value: total,
              unit: "BYTES",
              measurementBoundary: "MEASURED_SERIALIZED_STATE",
            });
          } else {
            // Live EVM gas, calldata, events, and state layout
            this.resourceMeasurements.push({
              runId,
              architecture: "D",
              component: "SMART_CONTRACT",
              metricName: "TOTAL_GAS_USED",
              value: totalGasForWorkload,
              unit: "GAS",
              measurementBoundary: "FINALIZED_BLOCK_RECEIPT",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "D",
              component: "SMART_CONTRACT",
              metricName: "CALLDATA_BYTES",
              value: measuredCalldataBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_TRANSACTION_PAYLOAD",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "D",
              component: "SMART_CONTRACT",
              metricName: "EVENT_BYTES",
              value: measuredEventBytes,
              unit: "BYTES",
              measurementBoundary: "MEASURED_LOG_EMISSION",
            });
            this.resourceMeasurements.push({
              runId,
              architecture: "D",
              component: "SMART_CONTRACT",
              metricName: "RECORD_LAYOUT_ESTIMATE_BYTES",
              value: 160 * workloadDef.B,
              unit: "BYTES",
              measurementBoundary: "ANALYTICAL_ESTIMATE",
            });
          }
        }
      }
    }

    // 2. Section 3: Failure Experiments on W4 (N=10,000, K=1,000, B=10)
    // Exactly 6 interventions * 10 repetitions * 10 batches = 600 publication trials
    if (onProgress) onProgress("Executing Section 3 Publication Failure & Post-Publication Retrieval Experiments (W4 on Live EVM)...");
    const w4Workload = await generateWorkload(10000, 1000, "did:edu:w4failure");

    for (const intervention of FAILURE_INTERVENTIONS) {
      for (let rep = 1; rep <= repetitions; rep++) {
        const runId = `RUN-FAIL-${intervention.id}-REP${rep}`;
        this.logManager.resetAll();
        if (intervention.arch === "D") {
          await this.resetEVM(w4Workload.issuerId, w4Workload.issuerWallet.address);
        } else {
          const policy = buildVerifierPolicy({
            logManager: this.logManager,
            issuer: { issuerId: w4Workload.issuerId, address: w4Workload.issuerWallet.address, keyVersion: 1 },
            d: this.registryContract ? { chainId: 31337, contractAddress: await this.registryContract.getAddress(), confirmationDepth: 1 } : null,
          });
          this.verifier.setPolicy(policy);
        }

        // Configure specific intervention for publication trials
        let customPublisher = this.publisher;
        let isDelayedMining = false;

        if (intervention.id === "C1_SOLE_LOG_UNAVAILABLE") {
          this.logManager.configureC1Failure({ unavailable: true });
        } else if (intervention.id === "C1_SOLE_LOG_OMISSION") {
          // Acknowledges submission but never incorporates into Merkle log
          this.logManager.configureC1Failure({ acknowledgeButOmit: true });
        } else if (intervention.id === "C2_ONE_LOG_UNAVAILABLE") {
          this.logManager.configureC2Logs({ LOG_C2_ALPHA: { unavailable: true } });
        } else if (intervention.id === "C2_ONE_LOG_OMISSION") {
          // Alpha acknowledges but omits; Beta & Gamma provide valid inclusion
          this.logManager.configureC2Logs({ LOG_C2_ALPHA: { acknowledgeButOmit: true } });
        } else if (intervention.id === "D_ENDPOINT_UNAVAILABLE") {
          // Unreachable submission endpoint (write path fails; in-process mock transport fault)
          const faultRunner = createFaultInjectingRunner(this.publisherSigner, { submitUnavailable: true });
          customPublisher = new IndependentPublisher(this.logManager);
          customPublisher.setRegistry(
            this.registryContract.connect(faultRunner as any) as any,
            this.registryAdapter!,
            hre.ethers.provider as any
          );
          customPublisher.setValidator(this.verifier);
        } else if (intervention.id === "D_PROCESSING_DELAYED") {
          // Transaction processing delayed past global 1000ms deadline
          isDelayedMining = true;
          await hre.network.provider.send("evm_setAutomine", [false]);
          customPublisher = new IndependentPublisher(this.logManager, {
            deadlineMs: 1000,
            lateObservationWindowMs: 3000,
          });
          customPublisher.setRegistry(
            this.registryContract.connect(this.publisherSigner) as any,
            this.registryAdapter!,
            hre.ethers.provider as any
          );
          customPublisher.setValidator(this.verifier);
          customPublisher.hooks.afterSubmit = () => {
            // Trigger block mining after 1200ms (strictly after the 1000ms deadline)
            setTimeout(async () => {
              try {
                await hre.network.provider.send("evm_mine");
              } catch {}
            }, 1200);
          };
        }

        const arch = intervention.arch as "C1" | "C2" | "D";
        for (let b = 0; b < w4Workload.batches.length; b++) {
          const batch = w4Workload.batches[b];
          const batchId = batch.manifest.logicalBatchId;

          let pubResult;
          if (arch === "C1") {
            pubResult = await customPublisher.publishToC1(batch.signedManifest);
          } else if (arch === "C2") {
            pubResult = await customPublisher.publishToC2(batch.signedManifest);
          } else {
            pubResult = await customPublisher.publishToD(batch.signedManifest);
          }
          await pubResult.settle();

          let supportingLogIds = "";
          let evidenceBoundary = "";

          if (pubResult.evidence?.architecture === "C1") {
            supportingLogIds = (pubResult.evidence as C1Evidence).logId;
            evidenceBoundary = `TREE_SIZE_${(pubResult.evidence as C1Evidence).checkpoint.treeSize}`;
          } else if (pubResult.evidence?.architecture === "C2") {
            supportingLogIds = (pubResult.evidence as C2Evidence).supportingProofs.map((p) => p.logId).join(";");
            evidenceBoundary = `QUORUM_${(pubResult.evidence as C2Evidence).supportingProofs.length}_OF_3`;
          } else if (pubResult.evidence?.architecture === "D") {
            supportingLogIds = "BLOCKCHAIN_EVM";
            evidenceBoundary = `BLOCK_${(pubResult.evidence as DEvidence).registeredBlockNumber}`;
          }

          this.publicationTrials.push({
            runId,
            architecture: arch,
            scenario: intervention.id,
            N: 10000,
            K: 1000,
            B: 10,
            batchId,
            submissionTime: pubResult.submissionMs,
            firstAcceptanceTime: pubResult.firstAcceptanceMs,
            quorumAcceptanceTime: pubResult.quorumAcceptanceMs,
            evidenceCompletionTime: pubResult.evidenceCompletionMs,
            outcome: pubResult.outcome,
            attemptCount: pubResult.attemptsAtResult,
            supportingLogIds,
            evidenceBoundary,
          });

          this.publicationTraces.push({
            runId,
            architecture: arch,
            scenario: intervention.id,
            batchId,
            submissionMs: pubResult.submissionMs,
            firstAcceptanceMs: pubResult.firstAcceptanceMs,
            quorumAcceptanceMs: pubResult.quorumAcceptanceMs,
            evidenceCompletionMs: pubResult.evidenceCompletionMs,
            outcome: pubResult.outcome,
            attemptsCount: pubResult.attemptsAtResult,
            perLogTimings: pubResult.perLogAcceptance.map((a, idx) => ({
              logId: a.logId,
              acceptedAtMs: a.acceptedAtMs,
              validatedAtMs: pubResult.perLogEvidence[idx]?.validatedAtMs ?? null,
              proofClass: pubResult.perLogEvidence[idx]?.cls ?? "FAIL",
            })),
            provenance: {
              txHash: pubResult.d?.txHash,
              blockNumber: pubResult.d?.blockNumber,
              gasUsed: pubResult.d?.gasUsed?.toString(),
              calldataBytes: pubResult.d?.calldataBytes,
              eventBytes: pubResult.d?.eventBytes,
            },
            lateObservations: pubResult.late,
          });
        }

        if (isDelayedMining) {
          await hre.network.provider.send("evm_setAutomine", [true]);
        }

        // Section 3.2: Controlled Post-Publication Retrieval Experiment:
        // Audit requirement 5: Publish successfully first, then inject read unavailability/staleness, then query.
        // Separate valid-response availability from sufficient fresh publication evidence.
        const refBatch = w4Workload.batches[0];

        // Step 1: Ensure batch 0 is published successfully first to establish valid post-publication state
        this.logManager.resetAll();
        if (arch === "D") {
          await this.resetEVM(w4Workload.issuerId, w4Workload.issuerWallet.address);
          await this.publisher.publishToD(refBatch.signedManifest);
        } else if (arch === "C1") {
          await this.publisher.publishToC1(refBatch.signedManifest);
        } else {
          await this.publisher.publishToC2(refBatch.signedManifest);
        }

        // Step 2: Inject controlled read unavailability / staleness into the read transport
        let readAdapter = this.registryAdapter;
        if (intervention.id === "C1_SOLE_LOG_UNAVAILABLE") {
          // Read endpoint unavailable: in-process endpoint failure
          this.logManager.logC1.setFailureOptions({ unavailable: true });
        } else if (intervention.id === "C1_SOLE_LOG_OMISSION") {
          // Read staleness: log returns stale checkpoint (>300s old)
          this.logManager.logC1.setFailureOptions({ staleCheckpointAgeSec: 600 });
        } else if (intervention.id === "C2_ONE_LOG_UNAVAILABLE") {
          // Log Alpha read unavailable; Beta & Gamma provide 2/3 quorum
          this.logManager.logC2A.setFailureOptions({ unavailable: true });
        } else if (intervention.id === "C2_ONE_LOG_OMISSION") {
          // Log Alpha omits proof and status on read path; Beta & Gamma provide 2/3 quorum
          this.logManager.logC2A.setFailureOptions({ readOmitProof: true, readOmitStatus: true });
        } else if (intervention.id === "D_ENDPOINT_UNAVAILABLE") {
          // Blockchain read endpoint unavailable: in-process RPC transport failure
          readAdapter = {
            readEvidence: async () => { throw new Error("In-process RPC read transport unavailable"); },
          } as any;
        } else if (intervention.id === "D_PROCESSING_DELAYED") {
          // Mock unconfirmed reading (e.g. state read timed out before confirmation)
          readAdapter = {
            readEvidence: async () => null,
          } as any;
        }

        // Step 3: Query using independent EvidenceRetriever and verify
        const retriever = new EvidenceRetriever(this.logManager, readAdapter);
        const { evidence: retrievedEvidence, retrievalMs } = await retriever.fetch(arch, refBatch.signedManifest);

        const valStart = performance.now();
        const vReport = this.verifier.verifyCertificate({
          certificate: refBatch.certificates[0],
          merkleProof: refBatch.leafProofs[0],
          signedManifest: refBatch.signedManifest,
          evidence: retrievedEvidence,
          architecture: arch,
        });
        const localVerificationLatencyMs = performance.now() - valStart;
        const totalLatencyMs = retrievalMs + localVerificationLatencyMs;

        // Step 4: Record verification query with separated response availability vs evidence freshness
        this.verificationQueries.push({
          runId,
          queryId: `Q-FAIL-${runId}-B0`,
          batchId: refBatch.manifest.logicalBatchId,
          cacheMode: "FRESH_NETWORK",
          retrievalLatencyMs: retrievalMs,
          localVerificationLatencyMs,
          totalLatencyMs,
          evidenceAvailable: retrievedEvidence !== null,
          evidenceFresh: vReport.evidenceFresh,
          authenticationResult: vReport.authStatus,
          publicationResult: vReport.publicationStatus,
          statusResult: vReport.revocationStatus,
          evidenceBoundary: vReport.details.checkpointOrBlock ? vReport.details.checkpointOrBlock.toString() : "UNAVAILABLE",
        });

        // Clear failure options
        this.logManager.resetAll();
      }
    }

    const runConfig: Record<string, any> = {
      specVersion: "2026-10-04",
      researchScopeAuthority: "Academic_Certificate_Verification_Frozen_Research_Plan.md",
      hashAlgorithm: "Keccak256",
      signatureAlgorithm: "ECDSA (secp256k1)",
      canonicalJsonStandard: "RFC 8785 strict subset",
      schemaVersion: "1.0.0",
      workloads: WORKLOAD_MATRIX,
      failureScenarios: FAILURE_INTERVENTIONS,
      totalWorkloadRuns: 240, // 180 normal + 60 failure
      totalScheduledBatchTrials: 20850,
      repetitionsPerRun: repetitions,
      quorumRequirement: "2-of-3",
      retryPolicy: { maxAttempts: 3, deadlineMs: 1000, initialBackoffMs: 10, backoffMultiplier: 2 },
      lateObservationWindowMs: 3000,
      gasMeasuredViaEVM: true,
      evmContractAddress: await this.registryContract.getAddress(),
      evmChainId: 31337,
      executionEnvironment: "Hardhat EVM (Solidity 0.8.24 viaIR) / Node.js v22",
      sourceRevision: "univeri-v3-final-validity-pass",
      transportDescription: "In-process memory dispatch for C1/C2 HTTP REST simulation; JSON-RPC over Hardhat EVM provider for Architecture D",
      warmup: {
        count: 3,
        workload: "did:edu:warmup (N=10, K=5, B=2, 3 architectures)",
        purpose: "Prime EVM JIT, JSON serializers, and Merkle tree engines",
      },
      executionOrderSchedule: Array.from({ length: repetitions }, (_, i) => {
        const base: Array<"C1" | "C2" | "D"> = ["C1", "C2", "D"];
        const offset = i % 3;
        return {
          repetition: i + 1,
          order: [base[offset], base[(offset + 1) % 3], base[(offset + 2) % 3]],
        };
      }),
      fixed50kInput: {
        issuerId: fixed50kIssuerId,
        issuerAddress: fixed50kIssuerWallet.address,
        datasetHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(fixed50kCertificates))),
      },
      statisticalMethod: "Student's t-distribution on run-level repetition means",
      confidenceLevel: "95%",
      tCriticalValue: 2.262,
      degreesOfFreedom: 9,
      intervalProcedure: "runMean +/- (tCrit * runStdDev / sqrt(repetitions))",
      perRunContractDeploymentAddresses: [await this.registryContract.getAddress()],
      measurementUnitsAndBoundaries: {
        publicationLatency: "ms (submission timestamp to evidence completion timestamp)",
        verificationLatency: "ms (retrievalLatency + localVerificationLatency)",
        gas: "EVM gas units (transaction receipt gasUsed)",
        calldata: "bytes (transaction payload tx.data length)",
        eventBytes: "bytes (receipt logs data bytes + 32 bytes per topic word)",
        serializedStorage: "bytes (canonical serialized state size)",
        recordLayoutEstimate: "bytes (160 bytes analytical layout on-chain)",
      },
      timestamp: new Date().toISOString(),
    };

    // Compute Workload/Scenario Statistical Summary with Run-Level Uncertainty
    const statisticalSummary: Record<string, any> = {
      specVersion: "2026-10-04",
      generatedAt: new Date().toISOString(),
      workloads: {},
      failureScenarios: {},
    };

    for (const wDef of WORKLOAD_MATRIX) {
      statisticalSummary.workloads[wDef.id] = {};
      for (const arch of ["C1", "C2", "D"]) {
        const trials = this.publicationTrials.filter(
          (t) => t.scenario === "NORMAL_OPERATION" && t.N === wDef.N && t.K === wDef.K && t.architecture === arch
        );
        const successes = trials.filter((t) => t.outcome === "SUCCESS");
        const latencies = successes
          .map((t) => (t.evidenceCompletionTime !== null ? t.evidenceCompletionTime - t.submissionTime : null))
          .filter((v): v is number => v !== null)
          .sort((a, b) => a - b);

        // Run-level means for uncertainty estimation (10 repetitions)
        const runMeans: number[] = [];
        for (let rep = 1; rep <= repetitions; rep++) {
          const runTrials = successes.filter((t) => t.runId === `RUN-NORM-${wDef.id}-${arch}-REP${rep}`);
          if (runTrials.length > 0) {
            const mean =
              runTrials.reduce((acc, t) => acc + (t.evidenceCompletionTime! - t.submissionTime), 0) / runTrials.length;
            runMeans.push(mean);
          }
        }

        const runMean = runMeans.length > 0 ? runMeans.reduce((a, b) => a + b, 0) / runMeans.length : 0;
        const runVariance =
          runMeans.length > 1
            ? runMeans.reduce((acc, val) => acc + Math.pow(val - runMean, 2), 0) / (runMeans.length - 1)
            : 0;
        const runStdDev = Math.sqrt(runVariance);
        // Student's t critical value for df=9, alpha=0.05 is 2.262
        const tCrit = 2.262;
        const marginOfError = runMeans.length > 1 ? (tCrit * runStdDev) / Math.sqrt(runMeans.length) : 0;

        statisticalSummary.workloads[wDef.id][arch] = {
          totalTrials: trials.length,
          successTrials: successes.length,
          successRatePct: trials.length > 0 ? (successes.length / trials.length) * 100 : 0,
          latencyMs: {
            mean: parseFloat(runMean.toFixed(3)),
            stdDev: parseFloat(runStdDev.toFixed(3)),
            ci95: [parseFloat((runMean - marginOfError).toFixed(3)), parseFloat((runMean + marginOfError).toFixed(3))],
            median: latencies.length > 0 ? parseFloat(latencies[Math.floor(latencies.length * 0.5)].toFixed(3)) : 0,
            p95: latencies.length > 0 ? parseFloat(latencies[Math.floor(latencies.length * 0.95)].toFixed(3)) : 0,
          },
        };
      }
    }

    for (const intervention of FAILURE_INTERVENTIONS) {
      const trials = this.publicationTrials.filter((t) => t.scenario === intervention.id);
      const queries = this.verificationQueries.filter((q) => q.runId.includes(intervention.id));
      statisticalSummary.failureScenarios[intervention.id] = {
        architecture: intervention.arch,
        description: intervention.desc,
        publicationTrialCount: trials.length,
        outcomes: {
          SUCCESS: trials.filter((t) => t.outcome === "SUCCESS").length,
          TIMEOUT: trials.filter((t) => t.outcome === "TIMEOUT").length,
          INFRASTRUCTURE_ERROR: trials.filter((t) => t.outcome === "INFRASTRUCTURE_ERROR").length,
          INSUFFICIENT_EVIDENCE: trials.filter((t) => t.outcome === "INSUFFICIENT_EVIDENCE").length,
        },
        retrievalQueryCount: queries.length,
        retrievalOutcome: {
          evidenceAvailable: queries.filter((q) => q.evidenceAvailable).length,
          evidenceFresh: queries.filter((q) => q.evidenceFresh).length,
          publishedCount: queries.filter((q) => q.publicationResult === "PUBLISHED").length,
          staleCount: queries.filter((q) => q.publicationResult === "STALE_EVIDENCE").length,
          insufficientCount: queries.filter((q) => q.publicationResult === "INSUFFICIENT_EVIDENCE").length,
        },
      };
    }

    // Save Section 6 CSV/JSON Artifacts
    if (typeof window === "undefined") {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const outputDir = "./results";
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        // 6.2 publication_trials.csv
        const pubCsvHeader = "run_id,architecture,scenario,N,K,B,batch_id,submission_time,first_acceptance_time,quorum_acceptance_time,evidence_completion_time,outcome,attempt_count,supporting_log_ids,evidence_boundary\n";
        const pubCsvRows = this.publicationTrials
          .map((r) => {
            const firstAcc = r.firstAcceptanceTime !== null ? r.firstAcceptanceTime.toFixed(2) : "";
            const qAcc = r.quorumAcceptanceTime !== null ? r.quorumAcceptanceTime.toFixed(2) : "";
            const comp = r.evidenceCompletionTime !== null ? r.evidenceCompletionTime.toFixed(2) : "";
            return `${r.runId},${r.architecture},"${r.scenario}",${r.N},${r.K},${r.B},${r.batchId},${r.submissionTime.toFixed(2)},${firstAcc},${qAcc},${comp},${r.outcome},${r.attemptCount},"${r.supportingLogIds}","${r.evidenceBoundary}"`;
          })
          .join("\n");
        fs.writeFileSync(path.join(outputDir, "publication_trials.csv"), pubCsvHeader + pubCsvRows, "utf8");

        // 6.3 verification_queries.csv
        const verCsvHeader = "run_id,query_id,batch_id,cache_mode,retrieval_latency,local_verification_latency,total_latency,evidence_available,evidence_fresh,authentication_result,publication_result,status_result,evidence_boundary\n";
        const verCsvRows = this.verificationQueries
          .map((r) => `${r.runId},${r.queryId},${r.batchId},${r.cacheMode},${r.retrievalLatencyMs.toFixed(3)},${r.localVerificationLatencyMs.toFixed(3)},${r.totalLatencyMs.toFixed(3)},${r.evidenceAvailable},${r.evidenceFresh},${r.authenticationResult},${r.publicationResult},${r.statusResult},"${r.evidenceBoundary}"`)
          .join("\n");
        fs.writeFileSync(path.join(outputDir, "verification_queries.csv"), verCsvHeader + verCsvRows, "utf8");

        // 6.4 resource_measurements.csv
        const resCsvHeader = "run_id,architecture,component,metric_name,value,unit,measurement_boundary\n";
        const resCsvRows = this.resourceMeasurements
          .map((r) => `${r.runId},${r.architecture},${r.component},${r.metricName},${r.value},${r.unit},"${r.measurementBoundary}"`)
          .join("\n");
        fs.writeFileSync(path.join(outputDir, "resource_measurements.csv"), resCsvHeader + resCsvRows, "utf8");

        // 6.5 correctness_tests.csv
        const corCsvHeader = "test_case_id,description,architecture,expected_auth,observed_auth,expected_pub,observed_pub,expected_status,observed_status,pass_fail\n";
        const corCsvRows = this.correctnessTests
          .map((r) => `${r.testCaseId},"${r.description}",${r.architecture},${r.expectedAuth},${r.observedAuth},${r.expectedPub},${r.observedPub},${r.expectedStatus},${r.observedStatus},${r.passFail}`)
          .join("\n");
        fs.writeFileSync(path.join(outputDir, "correctness_tests.csv"), corCsvHeader + corCsvRows, "utf8");

        // 6.6 publication_traces.json (Detailed companion traces)
        fs.writeFileSync(path.join(outputDir, "publication_traces.json"), JSON.stringify(this.publicationTraces, null, 2), "utf8");

        // 6.7 statistical_summary.json (Run-level uncertainty & confidence intervals)
        fs.writeFileSync(path.join(outputDir, "statistical_summary.json"), JSON.stringify(statisticalSummary, null, 2), "utf8");

        // 6.1 run_config.json with companion artifact cryptographic checksums
        const crypto = await import("crypto");
        const companionFiles = [
          "publication_trials.csv",
          "verification_queries.csv",
          "resource_measurements.csv",
          "correctness_tests.csv",
          "publication_traces.json",
          "statistical_summary.json",
        ];
        const companionArtifactHashes: Record<string, string> = {};
        for (const cf of companionFiles) {
          const filePath = path.join(outputDir, cf);
          if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath);
            companionArtifactHashes[cf] = crypto.createHash("sha256").update(data).digest("hex");
          }
        }
        runConfig.companionArtifactHashes = companionArtifactHashes;
        fs.writeFileSync(path.join(outputDir, "run_config.json"), JSON.stringify(runConfig, null, 2), "utf8");
      } catch (e) {
        // Ignored in browser context
      }
    }

    return {
      publicationTrials: this.publicationTrials,
      verificationQueries: this.verificationQueries,
      resourceMeasurements: this.resourceMeasurements,
      correctnessTests: this.correctnessTests,
      runConfig,
    };
  }
}
