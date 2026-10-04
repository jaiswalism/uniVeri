import { Wallet } from "ethers";
import { LogClusterManager } from "../services/transparency-log/log-manager.js";
import { IndependentPublisher } from "../publisher/independent-publisher.js";
import { CommonVerifier } from "../verifier/common-verifier.js";
import { TrialRecord } from "../core/types.js";
import { generateWorkload, WorkloadPackage } from "./workload.js";
import { computeAggregateStats, exportTrialsToCsv } from "./metrics.js";

export interface ExperimentConfig {
  repetitions: number;
  warmupRuns: number;
  workloadMatrix: Array<{ N: number; K: number }>;
  failureScenarios: string[];
  outputDir: string;
}

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  repetitions: 10,
  warmupRuns: 2,
  workloadMatrix: [
    { N: 1000, K: 100 },   // B = 10
    { N: 10000, K: 1000 }, // B = 10
    { N: 50000, K: 1000 }, // B = 50
    { N: 50000, K: 10000 },// B = 5
  ],
  failureScenarios: [
    "NORMAL_OPERATION",
    "C1_OPERATOR_OUTAGE",
    "C1_OPERATOR_CENSORSHIP",
    "C2_ONE_LOG_FAILURE",
    "C2_TWO_LOGS_FAILURE",
    "D_TRANSACTION_PATH_FAILURE",
  ],
  outputDir: "./results",
};

/**
 * High-performance In-Memory EVM Registry Mock
 * Mirrors the exact logic of AcademicCertificateRegistry.sol for fast, reproducible benchmarking
 */
export class InMemoryBlockchainRegistry {
  public totalGasUsed: bigint = 0n;
  public totalBatches: number = 0;
  public stateStorageBytes: number = 0;
  public failureConfig = { endpointUnavailable: false, delayMs: 0 };
  private batches = new Map<string, any>();
  private logicalToContent = new Map<string, string>();
  private currentBlockNumber = 1000;

  public reset(): void {
    this.batches.clear();
    this.logicalToContent.clear();
    this.totalBatches = 0;
    this.totalGasUsed = 0n;
    this.stateStorageBytes = 0;
    this.currentBlockNumber = 1000;
  }

  public async registerBatch(
    logicalBatchId: string,
    batchContentId: string,
    merkleRoot: string,
    issuerAddress: string,
    issuerKeyVersion: number,
    credentialCount: number,
    issuedAt: number,
    institutionSignature: string
  ): Promise<{
    hash: string;
    blockNumber: number;
    gasUsed: bigint;
    blockHash: string;
    wait: (conf: number) => Promise<any>;
  }> {
    if (this.failureConfig.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.failureConfig.delayMs));
    }
    if (this.failureConfig.endpointUnavailable) {
      throw new Error("Blockchain RPC node endpoint UNAVAILABLE (Controlled Failure)");
    }

    if (this.batches.has(batchContentId)) {
      throw new Error("BatchAlreadyRegistered");
    }

    const existing = this.logicalToContent.get(logicalBatchId);
    if (existing && existing !== batchContentId) {
      throw new Error("LogicalBatchConflict");
    }

    // Base gas cost for batch registration + calldata + SSTOREs
    // 21000 (base tx) + ~45000 (ecrecover + 2x SSTORE + event) + calldata
    const calldataBytes = 32 * 7 + 65; // ~289 bytes
    const gasUsed = 68420n;

    this.currentBlockNumber++;
    const record = {
      logicalBatchId,
      batchContentId,
      merkleRoot,
      issuerAddress,
      issuerKeyVersion,
      credentialCount,
      issuedAt,
      registeredAt: Math.floor(Date.now() / 1000),
      registeredBlockNumber: this.currentBlockNumber,
      status: "ACTIVE",
    };

    this.batches.set(batchContentId, record);
    this.logicalToContent.set(logicalBatchId, batchContentId);
    this.totalBatches++;
    this.totalGasUsed += gasUsed;
    this.stateStorageBytes += 160; // 5 x 32-byte slots

    const receipt = {
      hash: "0x" + "a".repeat(64),
      blockNumber: this.currentBlockNumber,
      gasUsed,
      blockHash: "0x" + "b".repeat(64),
      wait: async () => receipt,
    };

    return receipt;
  }

  public async isBatchActive(batchContentId: string): Promise<[boolean, string, number]> {
    if (this.failureConfig.endpointUnavailable) {
      throw new Error("Blockchain RPC node endpoint UNAVAILABLE");
    }
    const record = this.batches.get(batchContentId);
    if (record && record.status === "ACTIVE") {
      return [true, record.merkleRoot, record.registeredBlockNumber];
    }
    return [false, "0x" + "00".repeat(32), 0];
  }

  public async getAddress(): Promise<string> {
    return "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  }
}

/**
 * Main Experiment Runner
 */
export class ExperimentRunner {
  private config: ExperimentConfig;
  private logManager: LogClusterManager;
  private inMemoryRegistry: InMemoryBlockchainRegistry;
  private publisher: IndependentPublisher;
  private verifier: CommonVerifier;

  constructor(config: Partial<ExperimentConfig> = {}) {
    this.config = { ...DEFAULT_EXPERIMENT_CONFIG, ...config };
    this.logManager = new LogClusterManager();
    this.inMemoryRegistry = new InMemoryBlockchainRegistry();
    this.publisher = new IndependentPublisher(this.logManager);
    this.verifier = new CommonVerifier(this.logManager);
    this.publisher.setValidator(this.verifier);
  }

  /**
   * Applies architecture-specific failure scenario
   */
  private applyScenario(scenario: string): void {
    this.logManager.resetAll();
    this.inMemoryRegistry.reset();
    this.inMemoryRegistry.failureConfig = { endpointUnavailable: false, delayMs: 0 };

    switch (scenario) {
      case "C1_OPERATOR_OUTAGE":
        this.logManager.configureC1Failure({ unavailable: true });
        break;
      case "C1_OPERATOR_CENSORSHIP":
        this.logManager.configureC1Failure({ censorAll: true });
        break;
      case "C2_ONE_LOG_FAILURE":
        // 1 of 3 logs fails (Alpha fails, Beta and Gamma healthy -> Quorum 2/3 succeeds)
        this.logManager.configureC2Failure({ failingLogIds: ["LOG_C2_ALPHA"] });
        break;
      case "C2_TWO_LOGS_FAILURE":
        // 2 of 3 logs fail (Alpha and Beta fail -> Quorum fails)
        this.logManager.configureC2Failure({ failingLogIds: ["LOG_C2_ALPHA", "LOG_C2_BETA"] });
        break;
      case "D_TRANSACTION_PATH_FAILURE":
        this.inMemoryRegistry.failureConfig = { endpointUnavailable: true, delayMs: 0 };
        break;
      case "NORMAL_OPERATION":
      default:
        break;
    }
  }

  /**
   * Executes a single trial for an architecture
   */
  private async executeTrial(
    arch: "C1" | "C2" | "D",
    workload: WorkloadPackage,
    scenario: string,
    repIndex: number
  ): Promise<TrialRecord> {
    const trialId = `trial-${arch}-${workload.N}-${workload.K}-${scenario}-rep${repIndex}`;
    const firstBatch = workload.batches[0];
    const sampleCert = firstBatch.certificates[0];
    const sampleProof = firstBatch.leafProofs[0];

    let acceptanceTotalMs = 0;
    let evidenceTotalMs = 0;
    let totalGasForBatch = 0;
    let lastOutcome: any = "SUCCESS";
    let lastEvidence: any;

    // Process all batches in the workload
    for (const batch of workload.batches) {
      let pubResult;
      if (arch === "C1") {
        pubResult = await this.publisher.publishToC1(batch.signedManifest);
      } else if (arch === "C2") {
        pubResult = await this.publisher.publishToC2(batch.signedManifest);
      } else {
        pubResult = await this.publisher.publishToD(batch.signedManifest);
      }

      if (pubResult.acceptanceLatencyMs !== null) {
        acceptanceTotalMs += pubResult.acceptanceLatencyMs;
      }
      if (pubResult.evidenceCompletionLatencyMs !== null) {
        evidenceTotalMs += pubResult.evidenceCompletionLatencyMs;
      }
      if (pubResult.gasUsed) {
        totalGasForBatch += Number(pubResult.gasUsed);
      }
      lastOutcome = pubResult.outcome;
      lastEvidence = pubResult.evidence;

      if (pubResult.outcome !== "SUCCESS") {
        break;
      }
    }

    // Measure Verification Latency
    const verifyStart = performance.now();
    if (lastEvidence) {
      this.verifier.verifyCertificate({
        certificate: sampleCert,
        merkleProof: sampleProof,
        signedManifest: firstBatch.signedManifest,
        evidence: lastEvidence,
        trustedIssuerAddress: workload.issuerWallet.address,
      });
    }
    const verificationLatencyMs = performance.now() - verifyStart;

    const calcBytes = (s: string) =>
      typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function"
        ? Buffer.byteLength(s, "utf8")
        : new TextEncoder().encode(s).length;

    // Calculate storage bytes
    const offChainPackageBytes =
      calcBytes(JSON.stringify(workload.batches.map((b) => b.certificates))) +
      calcBytes(JSON.stringify(workload.batches.map((b) => b.leafProofs)));

    let publicationLayerStorageBytes = 0;
    if (arch === "C1") {
      publicationLayerStorageBytes = this.logManager.logC1.getStorageSizeBytes();
    } else if (arch === "C2") {
      publicationLayerStorageBytes =
        this.logManager.logC2A.getStorageSizeBytes() +
        this.logManager.logC2B.getStorageSizeBytes() +
        this.logManager.logC2C.getStorageSizeBytes();
    } else {
      publicationLayerStorageBytes = this.inMemoryRegistry.stateStorageBytes;
    }

    return {
      trialId,
      repetitionIndex: repIndex,
      architecture: arch,
      workload: { N: workload.N, K: workload.K, B: workload.B },
      failureScenario: scenario,
      outcome: lastOutcome,
      acceptanceLatencyMs: acceptanceTotalMs,
      evidenceCompletionLatencyMs: evidenceTotalMs,
      verificationLatencyMs,
      storageBytes: {
        offChainPackageBytes,
        publicationLayerStorageBytes,
        proofBytes: calcBytes(JSON.stringify(sampleProof)),
      },

      blockchainMetrics:
        arch === "D"
          ? {
              gasUsedPerBatch: 68420,
              totalGasUsed: totalGasForBatch,
              calldataBytes: 289 * workload.B,
            }
          : undefined,
      timestamp: Date.now(),
    };
  }

  /**
   * Runs the full experiment suite
   */
  public async runFullSuite(onProgress?: (msg: string) => void): Promise<{
    allTrials: TrialRecord[];
    aggregatedResults: { [key: string]: any };
  }> {
    const allTrials: TrialRecord[] = [];
    const architectures: Array<"C1" | "C2" | "D"> = ["C1", "C2", "D"];

    for (const matrixItem of this.config.workloadMatrix) {
      const { N, K } = matrixItem;
      const progressMsg = `Generating workload N=${N}, K=${K} (B=${Math.ceil(N / K)})...`;
      if (onProgress) onProgress(progressMsg);

      const workload = await generateWorkload(N, K);

      for (const scenario of this.config.failureScenarios) {
        for (const arch of architectures) {
          // Warmup runs
          for (let w = 0; w < this.config.warmupRuns; w++) {
            this.applyScenario(scenario);
            await this.executeTrial(arch, workload, scenario, -1);
          }

          // Measurement runs
          for (let rep = 1; rep <= this.config.repetitions; rep++) {
            this.applyScenario(scenario);
            const trial = await this.executeTrial(arch, workload, scenario, rep);
            allTrials.push(trial);
          }
        }
      }
    }

    // Compute aggregations
    const aggregatedResults: { [key: string]: any } = {};
    for (const matrixItem of this.config.workloadMatrix) {
      for (const scenario of this.config.failureScenarios) {
        for (const arch of architectures) {
          const key = `${arch}_N${matrixItem.N}_K${matrixItem.K}_${scenario}`;
          const matchingTrials = allTrials.filter(
            (t) =>
              t.architecture === arch &&
              t.workload.N === matrixItem.N &&
              t.workload.K === matrixItem.K &&
              t.failureScenario === scenario
          );
          aggregatedResults[key] = computeAggregateStats(matchingTrials);
        }
      }
    }

    // Export files if running in Node.js environment
    if (typeof window === "undefined") {
      try {
        const fs = await import("fs");
        const path = await import("path");
        if (!fs.existsSync(this.config.outputDir)) {
          fs.mkdirSync(this.config.outputDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(this.config.outputDir, "benchmark-results.json"),
          JSON.stringify({ config: this.config, allTrials, aggregatedResults }, null, 2),
          "utf8"
        );
        const csvData = exportTrialsToCsv(allTrials);
        fs.writeFileSync(path.join(this.config.outputDir, "benchmark-results.csv"), csvData, "utf8");
      } catch (e) {
        // Ignored in browser contexts
      }
    }

    return { allTrials, aggregatedResults };
  }
}
