import { Wallet, HDNodeWallet } from "ethers";
import { canonicalizeJson } from "../../core/canonical.js";
import {
  computeIssuanceEntryHash,
  computeRevocationEntryHash,
  computeStatusObservationPayload,
  verifyBatchManifestSignature,
  validateManifestIdentifiers,
} from "../../core/manifest.js";
import { MerkleTree } from "../../core/merkle.js";
import {
  LogInclusionProof,
  LogStatusObservation,
  SignedBatchManifest,
  SignedRevocation,
  SignedTreeCheckpoint,
} from "../../core/types.js";

export type LogEntryKind = "ISSUANCE" | "REVOCATION";

export interface LogEntry {
  entryIndex: number;
  kind: LogEntryKind;
  entryHash: string;
  batchContentId: string;
  logicalBatchId: string;
  signedManifest?: SignedBatchManifest;
  signedRevocation?: SignedRevocation;
  receivedAt: number;
}

/**
 * Failure / intervention options. Every option declares which interface it affects:
 *  - write path: submitManifest / submitRevocation
 *  - read path : getLatestCheckpoint / getInclusionProof / getStatusObservation
 */
export interface LogFailureOptions {
  /** Affects BOTH write and read paths (HTTP 503 on every endpoint). */
  unavailable?: boolean;
  /** Affects only the write path: submissions are refused (503). Reads still work. */
  writeUnavailable?: boolean;
  /** Affects only the read path: evidence retrieval fails (503). Submissions still acknowledged and stored. */
  readUnavailable?: boolean;
  /** Delay applied to both paths before the operation executes (ms). */
  delayMs?: number;
  writeDelayMs?: number;
  readDelayMs?: number;
  /** Write path: submission rejected with an error (explicit refusal, never acknowledged). */
  censorContentIds?: Set<string>;
  censorAll?: boolean;
  /**
   * Write path: the log ACKNOWLEDGES the submission (returns success) but never incorporates it.
   * This is the "acknowledged omission" intervention; the acknowledgement must not count as publication.
   */
  acknowledgeButOmit?: boolean;
  /** Read path: corrupt the audit path of served inclusion proofs. */
  corruptProof?: boolean;
  /**
   * Read path: the log's signing clock lags by this many seconds, so every checkpoint it issues is
   * VALIDLY SIGNED but carries a timestamp that many seconds in the past (stale response).
   */
  staleCheckpointAgeSec?: number;
  /** Read path: log entry exists in store but log omits inclusion proof on read (retrieval fails). */
  readOmitProof?: boolean;
  /** Read path: log omits status observation response on read (status query fails). */
  readOmitStatus?: boolean;
}

export interface LogStorageAccounting {
  entryCount: number;
  checkpointCount: number;
  entriesSerializedBytes: number;
  checkpointsSerializedBytes: number;
  totalSerializedBytes: number;
}

/** Interval after which a log re-signs a checkpoint even if the tree is unchanged (seconds). */
export const CHECKPOINT_REFRESH_INTERVAL_SEC = 60;

/**
 * Append-only Transparency Log Engine
 * Merkle tree over canonical entry hashes; signed checkpoints; issuance and revocation entries.
 */
export class TransparencyLogEngine {
  public readonly logId: string;
  private readonly operatorWallet: Wallet | HDNodeWallet;
  private entries: LogEntry[] = [];
  private entryHashes: string[] = [];
  private issuanceIndex: Map<string, number> = new Map();
  private revocationIndexesByContentId: Map<string, number[]> = new Map();
  private checkpoints: SignedTreeCheckpoint[] = [];
  private failureOptions: LogFailureOptions = {};
  private cachedTree: MerkleTree | null = null;
  private latestCheckpoint: SignedTreeCheckpoint | null = null;
  private latestCheckpointSkewSec = 0;
  /** Injectable wall clock in seconds (tests use it for deterministic staleness). */
  public clockSec: () => number = () => Math.floor(Date.now() / 1000);

  constructor(logId: string, operatorPrivateKey?: string) {
    this.logId = logId;
    this.operatorWallet = operatorPrivateKey ? new Wallet(operatorPrivateKey) : Wallet.createRandom();
  }

  public getOperatorAddress(): string {
    return this.operatorWallet.address;
  }

  public getOperatorWallet(): Wallet | HDNodeWallet {
    return this.operatorWallet;
  }


  public setFailureOptions(options: LogFailureOptions): void {
    this.failureOptions = { ...options };
  }

  public getFailureOptions(): LogFailureOptions {
    return { ...this.failureOptions };
  }

  public clearFailureOptions(): void {
    this.failureOptions = {};
  }

  public reset(): void {
    this.entries = [];
    this.entryHashes = [];
    this.issuanceIndex.clear();
    this.revocationIndexesByContentId.clear();
    this.checkpoints = [];
    this.cachedTree = null;
    this.latestCheckpoint = null;
    this.latestCheckpointSkewSec = 0;
    this.failureOptions = {};
  }

  private async delay(path: "write" | "read"): Promise<void> {
    const ms = (this.failureOptions.delayMs || 0) + (path === "write" ? this.failureOptions.writeDelayMs || 0 : this.failureOptions.readDelayMs || 0);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private assertWritable(): void {
    if (this.failureOptions.unavailable || this.failureOptions.writeUnavailable) {
      throw new Error(`Log ${this.logId} is currently UNAVAILABLE (HTTP 503) [write path]`);
    }
  }

  private assertReadable(): void {
    if (this.failureOptions.unavailable || this.failureOptions.readUnavailable) {
      throw new Error(`Log ${this.logId} is UNAVAILABLE (HTTP 503) [read path]`);
    }
  }

  private isCensored(batchContentId: string): boolean {
    const idLower = batchContentId.toLowerCase();
    if (this.failureOptions.censorAll) return true;
    if (this.failureOptions.censorContentIds) {
      for (const id of this.failureOptions.censorContentIds) {
        if (id.toLowerCase() === idLower) return true;
      }
    }
    return false;
  }

  private append(entry: Omit<LogEntry, "entryIndex">): number {
    const entryIndex = this.entries.length;
    this.entries.push({ ...entry, entryIndex });
    this.entryHashes.push(entry.entryHash);
    this.cachedTree = null;
    return entryIndex;
  }

  /**
   * Appends a signed manifest. Returns an ACKNOWLEDGEMENT only (no checkpoint): evidence of inclusion
   * must be retrieved separately via getInclusionProof.
   */
  public async submitManifest(signedManifest: SignedBatchManifest): Promise<{
    entryIndex: number;
    acknowledgedAtMs: number;
    omitted: boolean;
  }> {
    await this.delay("write");
    this.assertWritable();

    // Enforce publication predicate (Research Plan Section 19): valid signed manifest
    const sigCheck = verifyBatchManifestSignature(signedManifest);
    const idCheck = validateManifestIdentifiers(signedManifest.manifest);
    if (!sigCheck.valid || !idCheck.valid) {
      throw new Error(`Log ${this.logId} rejected manifest: invalid institutional manifest signature or identifiers`);
    }

    const { batchContentId, logicalBatchId } = signedManifest.manifest;
    if (this.isCensored(batchContentId)) {
      throw new Error(`Log ${this.logId} rejected publication (CENSORED)`);
    }

    if (this.failureOptions.acknowledgeButOmit) {
      // Acknowledge but never incorporate: no entry is appended.
      return { entryIndex: -1, acknowledgedAtMs: performance.now(), omitted: true };
    }

    const normContentId = batchContentId.toLowerCase();
    const existing = this.issuanceIndex.get(normContentId);
    if (existing !== undefined) {
      return { entryIndex: existing, acknowledgedAtMs: performance.now(), omitted: false };
    }

    const entryIndex = this.append({
      kind: "ISSUANCE",
      entryHash: computeIssuanceEntryHash(signedManifest),
      batchContentId,
      logicalBatchId,
      signedManifest,
      receivedAt: this.clockSec(),
    });
    this.issuanceIndex.set(normContentId, entryIndex);
    return { entryIndex, acknowledgedAtMs: performance.now(), omitted: false };
  }

  /**
   * Appends an issuer-signed revocation event (write path). Signature authorization is NOT judged here;
   * verifiers validate it against their pinned issuer key.
   */
  public async submitRevocation(rev: SignedRevocation): Promise<{ entryIndex: number }> {
    await this.delay("write");
    this.assertWritable();
    if (this.isCensored(rev.batchContentId)) {
      throw new Error(`Log ${this.logId} rejected revocation (CENSORED)`);
    }
    if (this.failureOptions.acknowledgeButOmit) {
      return { entryIndex: -1 };
    }
    const normContentId = rev.batchContentId.toLowerCase();
    const entryIndex = this.append({
      kind: "REVOCATION",
      entryHash: computeRevocationEntryHash(rev),
      batchContentId: rev.batchContentId,
      logicalBatchId: rev.logicalBatchId,
      signedRevocation: rev,
      receivedAt: this.clockSec(),
    });
    const list = this.revocationIndexesByContentId.get(normContentId) ?? [];
    list.push(entryIndex);
    this.revocationIndexesByContentId.set(normContentId, list);
    return { entryIndex };
  }

  private getTree(): MerkleTree {
    if (!this.cachedTree) {
      this.cachedTree = new MerkleTree(this.entryHashes);
    }
    return this.cachedTree;
  }

  /**
   * Generates and signs a Tree Checkpoint. The signing timestamp is the log clock (plus any injected lag).
   */
  public async createCheckpoint(): Promise<SignedTreeCheckpoint> {
    const treeSize = this.entries.length;
    const skew = -(this.failureOptions.staleCheckpointAgeSec || 0);
    const timestamp = this.clockSec() + skew;

    const rootHash = treeSize === 0 ? "0x" + "00".repeat(32) : this.getTree().getRoot();
    const checkpointPayload = canonicalizeJson({ logId: this.logId, treeSize, rootHash, timestamp });
    const signature = await this.operatorWallet.signMessage(checkpointPayload);

    const checkpoint: SignedTreeCheckpoint = { logId: this.logId, treeSize, rootHash, timestamp, signature };
    this.latestCheckpoint = checkpoint;
    this.latestCheckpointSkewSec = skew;
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  private async currentCheckpoint(): Promise<SignedTreeCheckpoint> {
    const skew = -(this.failureOptions.staleCheckpointAgeSec || 0);
    const cp = this.latestCheckpoint;
    if (
      cp &&
      cp.treeSize === this.entries.length &&
      this.latestCheckpointSkewSec === skew &&
      this.clockSec() + skew - cp.timestamp < CHECKPOINT_REFRESH_INTERVAL_SEC
    ) {
      return cp;
    }
    return this.createCheckpoint();
  }

  public async getLatestCheckpoint(): Promise<SignedTreeCheckpoint> {
    await this.delay("read");
    this.assertReadable();
    return this.currentCheckpoint();
  }

  /**
   * Generates an Inclusion Proof for an issuance entry (read path)
   */
  public async getInclusionProof(batchContentId: string): Promise<LogInclusionProof> {
    await this.delay("read");
    this.assertReadable();

    if (this.failureOptions.readOmitProof) {
      throw new Error(`Log ${this.logId} omitted inclusion proof on read path`);
    }

    const normContentId = batchContentId.toLowerCase();
    const leafIndex = this.issuanceIndex.get(normContentId);
    if (leafIndex === undefined) {
      throw new Error(`Entry with batchContentId ${batchContentId} not found in log ${this.logId}`);
    }
    return this.buildProof(leafIndex);
  }

  private async buildProof(leafIndex: number): Promise<LogInclusionProof> {
    const checkpoint = await this.currentCheckpoint();
    const proof = this.getTree().getProof(leafIndex);
    const auditPath = proof.proof.map((s) => ({ ...s }));
    if (this.failureOptions.corruptProof) {
      if (auditPath.length > 0) {
        auditPath[0] = { position: auditPath[0].position, data: "0x" + "ff".repeat(32) };
      } else {
        auditPath.push({ position: "left", data: "0x" + "ff".repeat(32) });
      }
    }
    return {
      logId: this.logId,
      leafIndex,
      treeSize: this.entries.length,
      leafHash: this.entryHashes[leafIndex],
      auditPath,
      checkpoint,
    };
  }

  /**
   * Status query (read path): returns every revocation entry held for the batch, with inclusion proofs
   * against a single signed checkpoint, or an empty list.
   */
  public async getStatusObservation(batchContentId: string): Promise<LogStatusObservation> {
    await this.delay("read");
    this.assertReadable();

    if (this.failureOptions.readOmitStatus) {
      throw new Error(`Log ${this.logId} omitted status observation on read path`);
    }

    const checkpoint = await this.currentCheckpoint();
    const idxs = this.revocationIndexesByContentId.get(batchContentId.toLowerCase()) ?? [];
    const revocations = [];
    for (const idx of idxs) {
      const inclusionProof = await this.buildProof(idx);
      revocations.push({ event: this.entries[idx].signedRevocation!, inclusionProof });
    }
    const observedAt = this.clockSec();
    const payload = computeStatusObservationPayload({
      logId: this.logId,
      batchContentId,
      checkpointRoot: checkpoint.rootHash,
      treeSize: checkpoint.treeSize,
      revocationEntryHashes: revocations.map((r) => r.inclusionProof.leafHash),
      observedAt,
    });
    const operatorSignature = await this.operatorWallet.signMessage(payload);
    return {
      logId: this.logId,
      batchContentId,
      checkpoint,
      revocations,
      operatorSignature,
      observedAt,
    };
  }

  public getEntryCount(): number {
    return this.entries.length;
  }

  /**
   * Serialized-bytes accounting of the in-memory log state (JSON of entries and of every signed checkpoint
   * ever issued). This is a measurement of serialized size, not of on-disk usage.
   */
  public getStorageAccounting(): LogStorageAccounting {
    const calcBytes = (s: string) =>
      typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function"
        ? Buffer.byteLength(s, "utf8")
        : new TextEncoder().encode(s).length;
    const entriesBytes = calcBytes(JSON.stringify(this.entries));
    const cpBytes = calcBytes(JSON.stringify(this.checkpoints));
    return {
      entryCount: this.entries.length,
      checkpointCount: this.checkpoints.length,
      entriesSerializedBytes: entriesBytes,
      checkpointsSerializedBytes: cpBytes,
      totalSerializedBytes: entriesBytes + cpBytes,
    };
  }


  public getStorageSizeBytes(): number {
    return this.getStorageAccounting().totalSerializedBytes;
  }
}
