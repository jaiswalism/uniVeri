import { LogClusterManager } from "../services/transparency-log/log-manager.js";
import { RegistryRetrievalAdapter } from "../services/registry-adapter.js";
import {
  ArchitectureEvidence,
  C1Evidence,
  C2Evidence,
  C2LogProofEntry,
  LogStatusObservation,
  SignedBatchManifest,
} from "../core/types.js";

export interface RetrievalOutcome {
  evidence: ArchitectureEvidence | null;
  retrievalMs: number;
  errors: string[];
  /** Serialized-JSON size of the retrieved evidence (bytes); null if none */
  evidenceBytes: number | null;
  /** Number of remote reads attempted (proof + status per log, or one chain read) */
  requestsIssued: number;
}

export interface RetrieverConfig {
  /** Per-query retrieval deadline (ms). Reads still running after it are abandoned. */
  deadlineMs: number;
}

export const DEFAULT_RETRIEVER_CONFIG: RetrieverConfig = { deadlineMs: 1000 };

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${what})`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * Independent verifier-side evidence retrieval. It reads from the log servers / registry endpoint directly and
 * NEVER reuses evidence objects produced by the publisher (cache policy: FRESH_NETWORK = no cache).
 * C2 contacts all three pinned logs so that the status coverage (3/3) can be established; the retrieval
 * latency is therefore bounded by the slowest log (or the deadline).
 */
export class EvidenceRetriever {
  constructor(
    private readonly logManager: LogClusterManager,
    private readonly adapter: RegistryRetrievalAdapter | null,
    private readonly config: RetrieverConfig = DEFAULT_RETRIEVER_CONFIG
  ) {}

  public async fetch(arch: "C1" | "C2" | "D", signedManifest: SignedBatchManifest): Promise<RetrievalOutcome> {
    const start = performance.now();
    const contentId = signedManifest.manifest.batchContentId;
    const errors: string[] = [];
    let evidence: ArchitectureEvidence | null = null;
    let requests = 0;
    const dl = this.config.deadlineMs;

    if (arch === "C1") {
      const log = this.logManager.logC1;
      requests += 2;
      const [proofR, statusR] = await Promise.allSettled([
        withDeadline(log.getInclusionProof(contentId), dl, `${log.logId} proof`),
        withDeadline(log.getStatusObservation(contentId), dl, `${log.logId} status`),
      ]);
      if (proofR.status === "fulfilled") {
        const e: C1Evidence = {
          architecture: "C1",
          logId: log.logId,
          inclusionProof: proofR.value,
          checkpoint: proofR.value.checkpoint,
          retrievedAt: Math.floor(Date.now() / 1000),
        };
        if (statusR.status === "fulfilled") e.status = statusR.value;
        else e.statusError = String(statusR.reason?.message ?? statusR.reason);
        evidence = e;
      } else {
        errors.push(`${log.logId}: ${proofR.reason?.message ?? proofR.reason}`);
      }
      if (statusR.status === "rejected") errors.push(`${log.logId} status: ${statusR.reason?.message ?? statusR.reason}`);
    } else if (arch === "C2") {
      const logs = this.logManager.getC2Logs();
      requests += logs.length * 2;
      const results = await Promise.all(
        logs.map(async (log) => {
          const [proofR, statusR] = await Promise.allSettled([
            withDeadline(log.getInclusionProof(contentId), dl, `${log.logId} proof`),
            withDeadline(log.getStatusObservation(contentId), dl, `${log.logId} status`),
          ]);
          return { log, proofR, statusR };
        })
      );
      const supporting: C2LogProofEntry[] = [];
      const statuses: LogStatusObservation[] = [];
      const unavailableStatus: string[] = [];
      for (const { log, proofR, statusR } of results) {
        if (proofR.status === "fulfilled") {
          supporting.push({ logId: log.logId, inclusionProof: proofR.value, checkpoint: proofR.value.checkpoint });
        } else {
          errors.push(`${log.logId}: ${proofR.reason?.message ?? proofR.reason}`);
        }
        if (statusR.status === "fulfilled") statuses.push(statusR.value);
        else unavailableStatus.push(log.logId);
      }
      if (supporting.length > 0) {
        const e: C2Evidence = {
          architecture: "C2",
          requiredQuorum: 2,
          totalLogs: 3,
          supportingProofs: supporting,
          statusObservations: statuses,
          unavailableStatusLogIds: unavailableStatus,
          quorumMet: supporting.length >= 2,
          retrievedAt: Math.floor(Date.now() / 1000),
        };
        evidence = e;
      }
    } else {
      requests += 1;
      if (!this.adapter) {
        errors.push("no registry adapter configured");
      } else {
        try {
          evidence = await withDeadline(this.adapter.readEvidence(contentId), dl, "registry read");
        } catch (e: any) {
          errors.push(String(e?.message ?? e));
        }
      }
    }

    const retrievalMs = performance.now() - start;
    const calcBytes = (s: string) =>
      typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function"
        ? Buffer.byteLength(s, "utf8")
        : new TextEncoder().encode(s).length;
    return {
      evidence,
      retrievalMs,
      errors,
      evidenceBytes: evidence ? calcBytes(JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v))) : null,
      requestsIssued: requests,
    };
  }
}

