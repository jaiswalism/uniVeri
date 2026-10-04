import { Contract, Provider } from "ethers";
import { LogClusterManager } from "../services/transparency-log/log-manager.js";
import { RegistryRetrievalAdapter } from "../services/registry-adapter.js";
import {
  ArchitectureEvidence,
  C1Evidence,
  C2Evidence,
  C2LogProofEntry,
  DEvidence,
  LogInclusionProof,
  SignedBatchManifest,
  TrialOutcome,
} from "../core/types.js";
import {
  validateManifestIdentifiers,
  verifyBatchManifestSignature,
} from "../core/manifest.js";
import { EvidenceEvaluation, ProofClass } from "../verifier/common-verifier.js";

/**
 * Declared publisher policy (identical for C1, C2 and D).
 *  - ONE global deadline per logical batch covers submission, retries, backoff, receipt wait and state reads.
 *  - Each individual operation (e.g. one log submission) may be attempted up to maxAttempts times, with
 *    exponential backoff, but never beyond the global deadline.
 */
export interface PublisherConfig {
  maxAttempts: number;
  deadlineMs: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  /** Receipt/state polling interval (ms). */
  pollIntervalMs: number;
  /** After the deadline, how long late transaction activity is still observed and recorded separately (ms). */
  lateObservationWindowMs: number;
}

export const DEFAULT_PUBLISHER_CONFIG: PublisherConfig = {
  maxAttempts: 3,
  deadlineMs: 1000,
  initialBackoffMs: 10,
  backoffMultiplier: 2,
  pollIntervalMs: 5,
  lateObservationWindowMs: 3000,
};

/** The evidence validator the publisher uses to decide whether evidence is sufficient and VALIDATED. */
export interface PublisherEvidenceValidator {
  evaluateEvidence(signedManifest: SignedBatchManifest, evidence: ArchitectureEvidence): EvidenceEvaluation;
  classifyLogEvidence(
    arch: "C1" | "C2",
    signedManifest: SignedBatchManifest,
    logId: string,
    proof: LogInclusionProof
  ): { cls: ProofClass; notes: string[] };
}

export interface OpAttempt {
  op: string;
  target: string;
  attempt: number;
  startMs: number;
  endMs: number;
  ok: boolean;
  timedOut: boolean;
  error?: string;
  /** true if this attempt was started after the batch result had already been determined */
  afterResult?: boolean;
}

export interface LateEvent {
  op: string;
  target: string;
  completedAtMs: number;
  detail?: string;
}

export interface DTxInfo {
  txHash: string;
  blockNumber: number | null;
  blockHash: string | null;
  gasUsed: bigint | null;
  receiptStatus: number | null;
  calldataBytes: number;
  eventBytes: number | null;
  lateBlockNumber?: number;
  lateReceiptAtMs?: number;
}

export interface PublicationResult {
  architecture: "C1" | "C2" | "D";
  outcome: TrialOutcome;
  /** Precedence-ordered classification of why the trial did not succeed; null on success. */
  failureClass: string | null;
  errorCause: string | null;
  /** All times are performance.now() milliseconds (process-monotonic). null = stage did not occur. */
  submissionMs: number;
  epochAtSubmissionMs: number;
  deadlineAtMs: number;
  firstAcceptanceMs: number | null;
  quorumAcceptanceMs: number | null;
  /** Time at which sufficient VALIDATED evidence was achieved (C1: validated proof; C2: 2nd validated log; D: confirmed state read). */
  evidenceCompletionMs: number | null;
  /** D only: time a successful (status=1) receipt was obtained */
  receiptMs: number | null;
  resultMs: number;
  perLogAcceptance: Array<{ logId: string; acceptedAtMs: number; acknowledgedOmitted: boolean }>;
  perLogEvidence: Array<{ logId: string; validatedAtMs: number | null; cls: string }>;
  attempts: OpAttempt[];
  /** attempts counted at the moment the result was determined */
  attemptsAtResult: number;
  evidence?: ArchitectureEvidence;
  supportingLogIds: string[];
  d?: DTxInfo;
  late: LateEvent[];
  /** Resolves when all background activity of this batch has finished (late acceptances, third C2 log, late receipts). */
  settle: () => Promise<void>;
  // Backwards-compatible latency views (ms since submission); null when the stage did not occur
  acceptanceLatencyMs: number | null;
  evidenceCompletionLatencyMs: number | null;
  gasUsed?: bigint;
  errorMessage?: string;
}

export interface PublisherHooks {
  /** Test/instrumentation hook invoked right after the node accepted a transaction (before waiting for the receipt). */
  afterSubmit?: (info: { txHash: string; batchContentId: string }) => void;
}

class DeadlineExceededError extends Error {
  constructor(public readonly op: string, public readonly deadlineMs: number) {
    super(`DEADLINE_EXCEEDED during ${op} (global batch deadline ${deadlineMs}ms)`);
  }
}

interface BatchCtx {
  startMs: number;
  deadlineAtMs: number;
  attempts: OpAttempt[];
  late: LateEvent[];
  background: Promise<unknown>[];
  resultMs: number | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function classifyFailure(err: unknown): { outcome: TrialOutcome; failureClass: string; cause: string } {
  const msg = (err as any)?.shortMessage || (err as any)?.message || String(err);
  if (err instanceof DeadlineExceededError) {
    return { outcome: "TIMEOUT", failureClass: "DEADLINE", cause: msg };
  }
  if (/UNAVAILABLE|503|ECONNREFUSED|unreachable/i.test(msg)) {
    return { outcome: "INFRASTRUCTURE_ERROR", failureClass: "ENDPOINT_UNAVAILABLE", cause: msg };
  }
  if (/CENSORED|rejected|LogicalBatchConflict|BatchAlreadyRegistered|IssuerNotRegistered|InvalidSignature|reverted|CALL_EXCEPTION/i.test(msg)) {
    return { outcome: "REJECTED", failureClass: "EXPLICIT_REJECTION", cause: msg };
  }
  if (/not found/i.test(msg)) {
    return { outcome: "INSUFFICIENT_EVIDENCE", failureClass: "EVIDENCE_NOT_FOUND", cause: msg };
  }
  return { outcome: "INFRASTRUCTURE_ERROR", failureClass: "OTHER", cause: msg };
}

/**
 * Common Independent Publisher Client
 * Fair publication client used uniformly across C1, C2, and D (same deadline, same retry policy).
 */
export class IndependentPublisher {
  private config: PublisherConfig;
  private logManager: LogClusterManager;
  private registryContract?: Contract;
  private adapter?: RegistryRetrievalAdapter;
  private provider?: Provider;
  private validator?: PublisherEvidenceValidator;
  public hooks: PublisherHooks = {};

  constructor(logManager: LogClusterManager, config: Partial<PublisherConfig> = {}) {
    this.logManager = logManager;
    this.config = { ...DEFAULT_PUBLISHER_CONFIG, ...config };
  }

  public getConfig(): PublisherConfig {
    return { ...this.config };
  }

  public setValidator(v: PublisherEvidenceValidator): void {
    this.validator = v;
  }

  /** Configures Architecture D: writer-connected contract, trusted read adapter, and provider for receipt polling. */
  public setRegistry(contract: Contract, adapter: RegistryRetrievalAdapter, provider: Provider): void {
    this.registryContract = contract;
    this.adapter = adapter;
    this.provider = provider;
  }

  public clearRegistry(): void {
    this.registryContract = undefined;
    this.adapter = undefined;
    this.provider = undefined;
  }

  // ---------------------------------------------------------------- helpers

  private newCtx(): BatchCtx {
    const startMs = performance.now();
    return { startMs, deadlineAtMs: startMs + this.config.deadlineMs, attempts: [], late: [], background: [], resultMs: null };
  }

  /**
   * Runs `op` with the shared global deadline. Retries (up to maxAttempts) only on thrown errors; a deadline
   * expiry is terminal for the batch. If an operation completes after the deadline, that completion is
   * recorded as a LATE event and never converted into an in-deadline success.
   */
  private async guarded<T>(ctx: BatchCtx, opName: string, target: string, op: () => Promise<T>, retry = true): Promise<T> {
    let backoff = this.config.initialBackoffMs;
    let lastErr: unknown;
    const maxAttempts = retry ? this.config.maxAttempts : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = ctx.deadlineAtMs - performance.now();
      if (remaining <= 0) throw new DeadlineExceededError(opName, this.config.deadlineMs);
      const startMs = performance.now();
      const p = Promise.resolve().then(op);
      let timer: any;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(opName, this.config.deadlineMs)), remaining);
      });
      try {
        const res = await Promise.race([p, timeout]);
        clearTimeout(timer);
        ctx.attempts.push({ op: opName, target, attempt, startMs, endMs: performance.now(), ok: true, timedOut: false, afterResult: ctx.resultMs !== null });
        return res;
      } catch (err: any) {
        clearTimeout(timer);
        const timedOut = err instanceof DeadlineExceededError;
        ctx.attempts.push({
          op: opName, target, attempt, startMs, endMs: performance.now(), ok: false, timedOut,
          error: err?.shortMessage || err?.message || String(err), afterResult: ctx.resultMs !== null,
        });
        if (timedOut) {
          // the operation may still finish later: record it, never count it as within-deadline
          const tracked = p.then(
            () => { ctx.late.push({ op: opName, target, completedAtMs: performance.now(), detail: "completed after deadline" }); },
            () => undefined
          );
          ctx.background.push(tracked);
          throw err;
        }
        lastErr = err;
        if (attempt < maxAttempts) {
          const wait = Math.min(backoff, Math.max(0, ctx.deadlineAtMs - performance.now()));
          await sleep(wait);
          backoff *= this.config.backoffMultiplier;
        }
      }
    }
    throw lastErr;
  }

  private finalize(
    ctx: BatchCtx,
    base: {
      architecture: "C1" | "C2" | "D";
      outcome: TrialOutcome;
      failureClass: string | null;
      errorCause: string | null;
      firstAcceptanceMs: number | null;
      quorumAcceptanceMs: number | null;
      evidenceCompletionMs: number | null;
      receiptMs?: number | null;
      perLogAcceptance?: PublicationResult["perLogAcceptance"];
      perLogEvidence?: PublicationResult["perLogEvidence"];
      evidence?: ArchitectureEvidence;
      supportingLogIds?: string[];
      d?: DTxInfo;
      gasUsed?: bigint;
    }
  ): PublicationResult {
    const resultMs = performance.now();
    ctx.resultMs = resultMs;
    const epochNow = Date.now();
    const result: PublicationResult = {
      architecture: base.architecture,
      outcome: base.outcome,
      failureClass: base.failureClass,
      errorCause: base.errorCause,
      submissionMs: ctx.startMs,
      epochAtSubmissionMs: epochNow - (resultMs - ctx.startMs),
      deadlineAtMs: ctx.deadlineAtMs,
      firstAcceptanceMs: base.firstAcceptanceMs,
      quorumAcceptanceMs: base.quorumAcceptanceMs,
      evidenceCompletionMs: base.evidenceCompletionMs,
      receiptMs: base.receiptMs ?? null,
      resultMs,
      perLogAcceptance: base.perLogAcceptance ?? [],
      perLogEvidence: base.perLogEvidence ?? [],
      attempts: ctx.attempts,
      attemptsAtResult: ctx.attempts.length,
      evidence: base.evidence,
      supportingLogIds: base.supportingLogIds ?? [],
      d: base.d,
      late: ctx.late,
      settle: async () => {
        // drain until no new background work appears
        let seen = 0;
        while (seen < ctx.background.length) {
          const slice = ctx.background.slice(seen);
          seen = ctx.background.length;
          await Promise.allSettled(slice);
        }
      },
      acceptanceLatencyMs: base.firstAcceptanceMs === null ? null : base.firstAcceptanceMs - ctx.startMs,
      evidenceCompletionLatencyMs: base.evidenceCompletionMs === null ? null : base.evidenceCompletionMs - ctx.startMs,
      gasUsed: base.gasUsed,
      errorMessage: base.errorCause ?? undefined,
    };
    return result;
  }

  private requireValidator(): PublisherEvidenceValidator {
    if (!this.validator) throw new Error("IndependentPublisher: evidence validator not configured");
    return this.validator;
  }

  /**
   * Enforces the valid-signed-manifest publication predicate (Research Plan Section 19).
   * Timing boundary: Pre-submission boundary (t0). Evaluated before attempting network
   * transmission or storage admission across all architectures (C1, C2, D).
   */
  private validateManifestPredicate(
    signedManifest: SignedBatchManifest,
    arch: "C1" | "C2" | "D",
    ctx: BatchCtx
  ): PublicationResult | null {
    const sigCheck = verifyBatchManifestSignature(signedManifest);
    const idCheck = validateManifestIdentifiers(signedManifest.manifest);
    if (!sigCheck.valid || !idCheck.valid) {
      const cause = !sigCheck.valid
        ? "invalid institutional manifest signature for declared issuer address"
        : `invalid manifest structure: ${idCheck.problems.join("; ")}`;
      return this.finalize(ctx, {
        architecture: arch,
        outcome: "REJECTED",
        failureClass: "INVALID_MANIFEST_PREDICATE",
        errorCause: `Publication predicate failed at pre-submission boundary: ${cause}`,
        firstAcceptanceMs: null,
        quorumAcceptanceMs: null,
        evidenceCompletionMs: null,
        perLogAcceptance: [],
        perLogEvidence: [],
        evidence: undefined,
        supportingLogIds: [],
      });
    }
    return null;
  }

  // ---------------------------------------------------------------- C1

  public async publishToC1(signedManifest: SignedBatchManifest): Promise<PublicationResult> {
    const ctx = this.newCtx();
    const predicateFailure = this.validateManifestPredicate(signedManifest, "C1", ctx);
    if (predicateFailure) return predicateFailure;

    const validator = this.requireValidator();
    const log = this.logManager.logC1;
    const contentId = signedManifest.manifest.batchContentId;
    let firstAcceptance: number | null = null;
    const perLogAcceptance: PublicationResult["perLogAcceptance"] = [];

    try {
      const sub = await this.guarded(ctx, "SUBMIT", log.logId, () => log.submitManifest(signedManifest));
      firstAcceptance = performance.now();
      perLogAcceptance.push({ logId: log.logId, acceptedAtMs: firstAcceptance, acknowledgedOmitted: sub.omitted });

      const proof = await this.guarded(ctx, "FETCH_EVIDENCE", log.logId, () => log.getInclusionProof(contentId));
      let statusObs: any = undefined;
      try {
        statusObs = await log.getStatusObservation(contentId);
      } catch {
        statusObs = undefined;
      }
      const evidence: C1Evidence = {
        architecture: "C1",
        logId: log.logId,
        inclusionProof: proof,
        checkpoint: proof.checkpoint,
        status: statusObs,
        retrievedAt: Math.floor(Date.now() / 1000),
      };
      const evaluation = validator.evaluateEvidence(signedManifest, evidence);
      const completion = performance.now();
      const perLogEvidence = [{ logId: log.logId, validatedAtMs: evaluation.publicationStatus === "PUBLISHED" ? completion : null, cls: evaluation.publicationStatus }];

      if (completion > ctx.deadlineAtMs) {
        return this.finalize(ctx, {
          architecture: "C1", outcome: "TIMEOUT", failureClass: "DEADLINE",
          errorCause: "validated evidence completed after the global deadline",
          firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
          perLogAcceptance, perLogEvidence, evidence, supportingLogIds: [],
        });
      }
      if (evaluation.publicationStatus !== "PUBLISHED") {
        const outcome: TrialOutcome = evaluation.publicationStatus === "STALE_EVIDENCE" ? "STALE_EVIDENCE" : "INSUFFICIENT_EVIDENCE";
        return this.finalize(ctx, {
          architecture: "C1", outcome, failureClass: evaluation.publicationStatus, errorCause: evaluation.evidenceSummary,
          firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
          perLogAcceptance, perLogEvidence, evidence, supportingLogIds: [],
        });
      }
      return this.finalize(ctx, {
        architecture: "C1", outcome: "SUCCESS", failureClass: null, errorCause: null,
        firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: completion,
        perLogAcceptance, perLogEvidence, evidence, supportingLogIds: [log.logId],
      });
    } catch (err) {
      const c = classifyFailure(err);
      return this.finalize(ctx, {
        architecture: "C1", outcome: c.outcome, failureClass: c.failureClass, errorCause: c.cause,
        firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
        perLogAcceptance, perLogEvidence: [],
      });
    }
  }

  // ---------------------------------------------------------------- C2

  public async publishToC2(signedManifest: SignedBatchManifest): Promise<PublicationResult> {
    const ctx = this.newCtx();
    const predicateFailure = this.validateManifestPredicate(signedManifest, "C2", ctx);
    if (predicateFailure) return predicateFailure;

    const validator = this.requireValidator();
    const logs = this.logManager.getC2Logs();
    const contentId = signedManifest.manifest.batchContentId;
    const threshold = 2;

    const perLogAcceptance: PublicationResult["perLogAcceptance"] = [];
    const perLogEvidence: PublicationResult["perLogEvidence"] = [];
    const validEntries: C2LogProofEntry[] = [];
    const validAt = new Map<string, number>();
    const logErrors: Array<{ logId: string; err: unknown }> = [];
    let quorumAt: number | null = null;
    let resolveQuorum!: () => void;
    const quorumPromise = new Promise<void>((r) => (resolveQuorum = r));
    let finishedLogs = 0;

    const pipelines = logs.map(async (log) => {
      try {
        const sub = await this.guarded(ctx, "SUBMIT", log.logId, () => log.submitManifest(signedManifest));
        perLogAcceptance.push({ logId: log.logId, acceptedAtMs: performance.now(), acknowledgedOmitted: sub.omitted });
        const proof = await this.guarded(ctx, "FETCH_EVIDENCE", log.logId, () => log.getInclusionProof(contentId));
        const { cls, notes } = validator.classifyLogEvidence("C2", signedManifest, log.logId, proof);
        const t = performance.now();
        perLogEvidence.push({ logId: log.logId, validatedAtMs: cls === "VALID_FRESH" ? t : null, cls });
        if (cls === "VALID_FRESH") {
          validEntries.push({ logId: log.logId, inclusionProof: proof, checkpoint: proof.checkpoint });
          validAt.set(log.logId, t);
          if (quorumAt === null && validEntries.length >= threshold) {
            quorumAt = t;
            resolveQuorum();
          }
        } else {
          logErrors.push({ logId: log.logId, err: new Error(`evidence ${cls}: ${notes.join("; ")}`) });
        }
      } catch (err) {
        logErrors.push({ logId: log.logId, err });
      } finally {
        finishedLogs++;
        if (finishedLogs === logs.length) resolveQuorum();
      }
    });
    // pipelines continue after the batch result is determined (e.g. the third log); they are drained by settle()
    ctx.background.push(...pipelines);

    await quorumPromise;

    const acc = [...perLogAcceptance].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
    // acceptances that happened before the result time only
    const resultCut = performance.now();
    const firstAcceptance = acc.length > 0 && acc[0].acceptedAtMs <= resultCut ? acc[0].acceptedAtMs : null;
    const quorumAcceptance = acc.length >= threshold ? acc[threshold - 1].acceptedAtMs : null;

    if (validEntries.length >= threshold && quorumAt !== null && quorumAt <= ctx.deadlineAtMs) {
      const statusObsResults = await Promise.all(
        logs.map(async (l) => {
          try {
            return await l.getStatusObservation(contentId);
          } catch {
            return null;
          }
        })
      );
      const validStatuses = statusObsResults.filter((s): s is any => s !== null);

      const evidence: C2Evidence = {
        architecture: "C2",
        requiredQuorum: 2,
        totalLogs: 3,
        supportingProofs: validEntries.slice(0, validEntries.length),
        statusObservations: validStatuses,
        quorumMet: true,
        retrievedAt: Math.floor(Date.now() / 1000),
      };
      const evaluation = validator.evaluateEvidence(signedManifest, evidence);
      if (evaluation.publicationStatus === "PUBLISHED") {
        return this.finalize(ctx, {
          architecture: "C2", outcome: "SUCCESS", failureClass: null, errorCause: null,
          firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: quorumAcceptance, evidenceCompletionMs: quorumAt,
          perLogAcceptance, perLogEvidence, evidence, supportingLogIds: validEntries.map((e) => e.logId),
        });
      }
      return this.finalize(ctx, {
        architecture: "C2", outcome: "INSUFFICIENT_EVIDENCE", failureClass: evaluation.publicationStatus,
        errorCause: evaluation.evidenceSummary,
        firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: quorumAcceptance, evidenceCompletionMs: null,
        perLogAcceptance, perLogEvidence, evidence, supportingLogIds: [],
      });
    }

    // Failure precedence: deadline > endpoint unavailable (when all logs fail) > quorum not reached
    const classes = logErrors.map((e) => classifyFailure(e.err));
    const allLogsFailed = logErrors.length === logs.length && classes.every((c) => c.outcome === "INFRASTRUCTURE_ERROR");
    const pick =
      classes.find((c) => c.outcome === "TIMEOUT") ??
      (allLogsFailed ? classes[0] : undefined);
    const outcome: TrialOutcome = pick ? pick.outcome : "INSUFFICIENT_EVIDENCE";
    const failureClass = pick ? pick.failureClass : "QUORUM_NOT_REACHED";
    const cause = `${validEntries.length}/${logs.length} logs produced validated evidence (need ${threshold}); ` +
      logErrors.map((e) => `${e.logId}: ${(e.err as any)?.message ?? e.err}`).join(" | ");
    return this.finalize(ctx, {
      architecture: "C2", outcome, failureClass, errorCause: cause,
      firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: quorumAcceptance, evidenceCompletionMs: null,
      perLogAcceptance, perLogEvidence, supportingLogIds: [],
    });
  }

  // ---------------------------------------------------------------- D

  private eventBytesOf(receipt: any): number {
    let n = 0;
    for (const l of receipt.logs ?? []) {
      n += (String(l.data).length - 2) / 2 + 32 * (l.topics?.length ?? 0);
    }
    return n;
  }

  public async publishToD(signedManifest: SignedBatchManifest): Promise<PublicationResult> {
    const ctx = this.newCtx();
    const predicateFailure = this.validateManifestPredicate(signedManifest, "D", ctx);
    if (predicateFailure) return predicateFailure;

    const validator = this.requireValidator();
    const contract = this.registryContract;
    const adapter = this.adapter;
    const provider = this.provider;

    if (!contract || !adapter || !provider) {
      return this.finalize(ctx, {
        architecture: "D", outcome: "INFRASTRUCTURE_ERROR", failureClass: "NOT_CONFIGURED",
        errorCause: "Registry contract/adapter not configured on publisher",
        firstAcceptanceMs: null, quorumAcceptanceMs: null, evidenceCompletionMs: null,
      });
    }

    const m = signedManifest.manifest;
    let firstAcceptance: number | null = null;
    let receiptMs: number | null = null;
    let dInfo: DTxInfo | undefined;

    try {
      // 1. Submission: the node accepts the transaction (returns a tx hash)
      const tx: any = await this.guarded(ctx, "SUBMIT_TX", "registry", () =>
        contract.registerBatch(
          m.logicalBatchId, m.batchContentId, m.merkleRoot, m.issuerAddress,
          m.issuerKeyVersion, m.credentialCount, m.issuedAt, signedManifest.institutionSignature
        )
      );
      firstAcceptance = performance.now();
      const calldataBytes = (String(tx.data).length - 2) / 2;
      dInfo = {
        txHash: tx.hash, blockNumber: null, blockHash: null, gasUsed: null, receiptStatus: null,
        calldataBytes, eventBytes: null,
      };
      this.hooks.afterSubmit?.({ txHash: tx.hash, batchContentId: m.batchContentId });

      // 2. Receipt: poll until mined or the global deadline expires
      let receipt: any = null;
      try {
        receipt = await this.guarded(ctx, "WAIT_RECEIPT", "registry", async () => {
          for (;;) {
            const r = await provider.getTransactionReceipt(tx.hash);
            if (r) return r;
            await sleep(this.config.pollIntervalMs);
          }
        }, false);
      } catch (err) {
        if (err instanceof DeadlineExceededError) {
          // Late observation: does NOT turn the trial into a within-deadline success
          const info = dInfo;
          const watcher = (async () => {
            const until = performance.now() + this.config.lateObservationWindowMs;
            while (performance.now() < until) {
              const r: any = await provider.getTransactionReceipt(tx.hash);
              if (r) {
                info.lateBlockNumber = Number(r.blockNumber);
                info.lateReceiptAtMs = performance.now();
                info.blockNumber = Number(r.blockNumber);
                info.blockHash = r.blockHash;
                info.gasUsed = r.gasUsed;
                info.receiptStatus = Number(r.status);
                info.eventBytes = this.eventBytesOf(r);
                ctx.late.push({ op: "WAIT_RECEIPT", target: "registry", completedAtMs: performance.now(), detail: `tx mined in block ${r.blockNumber} after deadline (status ${r.status})` });
                return;
              }
              await sleep(this.config.pollIntervalMs);
            }
          })();
          ctx.background.push(watcher);
        }
        throw err;
      }
      receiptMs = performance.now();
      dInfo.blockNumber = Number(receipt.blockNumber);
      dInfo.blockHash = receipt.blockHash;
      dInfo.gasUsed = receipt.gasUsed;
      dInfo.receiptStatus = Number(receipt.status);
      dInfo.eventBytes = this.eventBytesOf(receipt);
      if (Number(receipt.status) !== 1) {
        throw new Error("transaction reverted (receipt status 0)");
      }

      // 3. Confirmation-qualified, explicit-block state read through the trusted adapter
      const evidence: DEvidence = await this.guarded(ctx, "READ_CONFIRMED_STATE", "registry", async () => {
        for (;;) {
          const head = await provider.getBlockNumber();
          if (head >= Number(receipt.blockNumber) + adapter.getConfirmationDepth() - 1) break;
          await sleep(this.config.pollIntervalMs);
        }
        return adapter.readEvidence(m.batchContentId, { blockNumber: Number(receipt.blockNumber) });
      });
      evidence.receipt = {
        transactionHash: tx.hash, blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed, confirmations: adapter.getConfirmationDepth(),
      };
      const evaluation = validator.evaluateEvidence(signedManifest, evidence);
      const completion = performance.now();
      const blockHashMatches = evidence.observedBlockHash.toLowerCase() === String(receipt.blockHash).toLowerCase();

      if (completion > ctx.deadlineAtMs) {
        return this.finalize(ctx, {
          architecture: "D", outcome: "TIMEOUT", failureClass: "DEADLINE",
          errorCause: "confirmed state read completed after the global deadline",
          firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
          receiptMs, evidence, d: dInfo, gasUsed: receipt.gasUsed, supportingLogIds: [],
        });
      }
      if (evaluation.publicationStatus !== "PUBLISHED" || !blockHashMatches) {
        return this.finalize(ctx, {
          architecture: "D", outcome: "REJECTED", failureClass: "STATE_MISMATCH",
          errorCause: blockHashMatches ? evaluation.evidenceSummary : "observed block hash differs from receipt block hash",
          firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
          receiptMs, evidence, d: dInfo, gasUsed: receipt.gasUsed, supportingLogIds: [],
        });
      }
      return this.finalize(ctx, {
        architecture: "D", outcome: "SUCCESS", failureClass: null, errorCause: null,
        firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: completion,
        receiptMs, evidence, d: dInfo, gasUsed: receipt.gasUsed, supportingLogIds: ["BLOCKCHAIN_EVM"],
      });
    } catch (err) {
      const c = classifyFailure(err);
      return this.finalize(ctx, {
        architecture: "D", outcome: c.outcome, failureClass: c.failureClass, errorCause: c.cause,
        firstAcceptanceMs: firstAcceptance, quorumAcceptanceMs: null, evidenceCompletionMs: null,
        receiptMs, d: dInfo, gasUsed: dInfo?.gasUsed ?? undefined,
      });
    }
  }
}
