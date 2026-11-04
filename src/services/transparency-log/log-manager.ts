import { verifyMessage } from "ethers";
import { canonicalizeJson } from "../../core/canonical.js";
import { MerkleTree } from "../../core/merkle.js";
import { LogInclusionProof, SignedTreeCheckpoint } from "../../core/types.js";
import { LogFailureOptions, TransparencyLogEngine } from "./log-engine.js";

export interface PinnedLog {
  logId: string;
  operatorAddress: string;
}

/**
 * Manages Transparency Log instances for C1 (Single Log) and C2 (3 Logs, 2-of-3 Quorum)
 */
export class LogClusterManager {
  // C1 Single Log
  public readonly logC1: TransparencyLogEngine;

  // C2 Three Independent Logs
  public readonly logC2A: TransparencyLogEngine;
  public readonly logC2B: TransparencyLogEngine;
  public readonly logC2C: TransparencyLogEngine;

  private operatorKeys: Map<string, string> = new Map();

  constructor() {
    this.logC1 = new TransparencyLogEngine("LOG_C1_PRIMARY");
    this.logC2A = new TransparencyLogEngine("LOG_C2_ALPHA");
    this.logC2B = new TransparencyLogEngine("LOG_C2_BETA");
    this.logC2C = new TransparencyLogEngine("LOG_C2_GAMMA");

    this.operatorKeys.set(this.logC1.logId, this.logC1.getOperatorAddress());
    this.operatorKeys.set(this.logC2A.logId, this.logC2A.getOperatorAddress());
    this.operatorKeys.set(this.logC2B.logId, this.logC2B.getOperatorAddress());
    this.operatorKeys.set(this.logC2C.logId, this.logC2C.getOperatorAddress());
  }

  public setLog(role: "C1" | "C2A" | "C2B" | "C2C", log: any): void {
    if (role === "C1") (this as any).logC1 = log;
    else if (role === "C2A") (this as any).logC2A = log;
    else if (role === "C2B") (this as any).logC2B = log;
    else if (role === "C2C") (this as any).logC2C = log;
    this.operatorKeys.set(log.logId, log.getOperatorAddress());
  }

  public getOperatorAddress(logId: string): string | undefined {
    return this.operatorKeys.get(logId);
  }

  public getC2Logs(): TransparencyLogEngine[] {
    return [this.logC2A, this.logC2B, this.logC2C];
  }

  public getAllLogs(): TransparencyLogEngine[] {
    return [this.logC1, ...this.getC2Logs()];
  }

  /** Pinned identity (logId + operator key) of the C1 log, for building a verifier policy. */
  public getPinnedC1(): PinnedLog {
    return {
      logId: this.logC1.logId,
      operatorAddress: this.getOperatorAddress(this.logC1.logId) || this.logC1.getOperatorAddress(),
    };
  }

  /** Pinned identities of the three C2 logs, for building a verifier policy. */
  public getPinnedC2(): PinnedLog[] {
    return this.getC2Logs().map((l) => ({
      logId: l.logId,
      operatorAddress: this.getOperatorAddress(l.logId) || l.getOperatorAddress(),
    }));
  }

  public getLogById(logId: string): TransparencyLogEngine | undefined {
    return this.getAllLogs().find((l) => l.logId === logId);
  }

  /**
   * Resets all logs for fresh experiment runs (entries, checkpoints, failure options)
   */
  public async resetAll(): Promise<void> {
    for (const l of this.getAllLogs()) await l.reset();
  }

  public async clearAllFailures(): Promise<void> {
    for (const l of this.getAllLogs()) await l.clearFailureOptions();
  }

  /**
   * Configures failure injection for C1
   */
  public configureC1Failure(options: LogFailureOptions): void {
    this.logC1.setFailureOptions(options);
  }

  /**
   * Configures failure injection per C2 log (by log id). Logs absent from the map are healthy.
   */
  public configureC2Logs(optionsByLogId: { [logId: string]: LogFailureOptions }): void {
    for (const log of this.getC2Logs()) {
      log.setFailureOptions(optionsByLogId[log.logId] ?? {});
    }
  }

  /**
   * Configures failure injection for C2
   */
  public configureC2Failure(options: {
    failingLogIds?: string[];
    censoringLogIds?: string[];
    delays?: { [logId: string]: number };
    corruptProofs?: string[];
    readOmitProofLogIds?: string[];
    readOmitStatusLogIds?: string[];
    acknowledgeButOmitLogIds?: string[];
  }): void {
    const logs = this.getC2Logs();
    for (const log of logs) {
      const isFailing = options.failingLogIds?.includes(log.logId);
      const isCensoring = options.censoringLogIds?.includes(log.logId);
      const isCorrupting = options.corruptProofs?.includes(log.logId);
      const delayMs = options.delays?.[log.logId] || 0;
      const readOmitProof = options.readOmitProofLogIds?.includes(log.logId);
      const readOmitStatus = options.readOmitStatusLogIds?.includes(log.logId);
      const acknowledgeButOmit = options.acknowledgeButOmitLogIds?.includes(log.logId);

      log.setFailureOptions({
        unavailable: isFailing,
        censorAll: isCensoring,
        corruptProof: isCorrupting,
        delayMs,
        readOmitProof,
        readOmitStatus,
        acknowledgeButOmit,
      });
    }
  }

  /**
   * Cryptographically verifies a Signed Tree Checkpoint
   */
  public static verifyCheckpoint(checkpoint: SignedTreeCheckpoint, expectedOperatorAddress: string): boolean {
    try {
      const payload = canonicalizeJson({
        logId: checkpoint.logId,
        treeSize: checkpoint.treeSize,
        rootHash: checkpoint.rootHash,
        timestamp: checkpoint.timestamp,
      });
      const recovered = verifyMessage(payload, checkpoint.signature);
      return recovered.toLowerCase() === expectedOperatorAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Cryptographically verifies a Log Inclusion Proof against a checkpoint
   */
  public static verifyLogInclusionProof(
    proof: LogInclusionProof,
    expectedOperatorAddress: string
  ): boolean {
    // 1. Verify checkpoint signature
    if (!this.verifyCheckpoint(proof.checkpoint, expectedOperatorAddress)) {
      return false;
    }

    // 2. Verify Merkle proof resolves to checkpoint root
    const validMerkle = MerkleTree.verifyProof({
      leafHash: proof.leafHash,
      leafIndex: proof.leafIndex,
      merkleRoot: proof.checkpoint.rootHash,
      totalLeaves: proof.treeSize,
      proof: proof.auditPath,
    });

    // 3. Binding: the proof's log identity must equal its checkpoint's log identity
    if (proof.logId !== proof.checkpoint.logId) {
      return false;
    }

    // 4. The checkpoint must commit to the claimed tree size
    if (proof.treeSize !== proof.checkpoint.treeSize) {
      return false;
    }

    return validMerkle;
  }
}
