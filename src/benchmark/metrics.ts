import { TrialRecord } from "../core/types.js";

export interface AggregateStats {
  count: number;
  successCount: number;
  successRatePercent: number;
  medianAcceptanceLatencyMs: number;
  p95AcceptanceLatencyMs: number;
  meanAcceptanceLatencyMs: number;
  medianEvidenceLatencyMs: number;
  p95EvidenceLatencyMs: number;
  meanEvidenceLatencyMs: number;
  medianVerificationLatencyMs: number;
  p95VerificationLatencyMs: number;
  meanVerificationLatencyMs: number;
  avgOffChainStorageBytes: number;
  avgPublicationStorageBytes: number;
  avgGasUsedPerBatch?: number;
  totalGasUsed?: number;
  ci95AcceptanceLatencyMs: [number, number]; // 95% Confidence interval [lower, upper]
  ci95EvidenceLatencyMs: [number, number];
}

/**
 * Computes percentile from a sorted array of numbers
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * Computes mean and standard deviation
 */
export function calculateMeanAndStdDev(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / Math.max(1, values.length - 1);
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Calculates 95% Confidence Interval for the mean using t-distribution approximation (1.96 * SE)
 */
export function calculate95ConfidenceInterval(values: number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  const { mean, stdDev } = calculateMeanAndStdDev(values);
  const standardError = stdDev / Math.sqrt(values.length);
  const margin = 1.96 * standardError;
  return [Math.max(0, mean - margin), mean + margin];
}

/**
 * Aggregates a series of trial records for a specific architecture and workload
 */
export function computeAggregateStats(trials: TrialRecord[]): AggregateStats {
  const count = trials.length;
  if (count === 0) {
    return {
      count: 0,
      successCount: 0,
      successRatePercent: 0,
      medianAcceptanceLatencyMs: 0,
      p95AcceptanceLatencyMs: 0,
      meanAcceptanceLatencyMs: 0,
      medianEvidenceLatencyMs: 0,
      p95EvidenceLatencyMs: 0,
      meanEvidenceLatencyMs: 0,
      medianVerificationLatencyMs: 0,
      p95VerificationLatencyMs: 0,
      meanVerificationLatencyMs: 0,
      avgOffChainStorageBytes: 0,
      avgPublicationStorageBytes: 0,
      ci95AcceptanceLatencyMs: [0, 0],
      ci95EvidenceLatencyMs: [0, 0],
    };
  }

  const successTrials = trials.filter((t) => t.outcome === "SUCCESS");
  const successCount = successTrials.length;
  const successRatePercent = (successCount / count) * 100;

  const acceptanceLatencies = trials.map((t) => t.acceptanceLatencyMs);
  const evidenceLatencies = trials.map((t) => t.evidenceCompletionLatencyMs);
  const verificationLatencies = trials.map((t) => t.verificationLatencyMs);

  const { mean: meanAcceptance } = calculateMeanAndStdDev(acceptanceLatencies);
  const { mean: meanEvidence } = calculateMeanAndStdDev(evidenceLatencies);
  const { mean: meanVerification } = calculateMeanAndStdDev(verificationLatencies);

  const offChainBytes = trials.map((t) => t.storageBytes.offChainPackageBytes);
  const pubStorageBytes = trials.map((t) => t.storageBytes.publicationLayerStorageBytes);

  const avgOffChainStorageBytes = offChainBytes.reduce((s, v) => s + v, 0) / count;
  const avgPublicationStorageBytes = pubStorageBytes.reduce((s, v) => s + v, 0) / count;

  let totalGas = 0;
  let gasCount = 0;
  for (const t of trials) {
    if (t.blockchainMetrics) {
      totalGas += t.blockchainMetrics.totalGasUsed;
      gasCount++;
    }
  }

  return {
    count,
    successCount,
    successRatePercent,
    medianAcceptanceLatencyMs: calculatePercentile(acceptanceLatencies, 50),
    p95AcceptanceLatencyMs: calculatePercentile(acceptanceLatencies, 95),
    meanAcceptanceLatencyMs: meanAcceptance,
    medianEvidenceLatencyMs: calculatePercentile(evidenceLatencies, 50),
    p95EvidenceLatencyMs: calculatePercentile(evidenceLatencies, 95),
    meanEvidenceLatencyMs: meanEvidence,
    medianVerificationLatencyMs: calculatePercentile(verificationLatencies, 50),
    p95VerificationLatencyMs: calculatePercentile(verificationLatencies, 95),
    meanVerificationLatencyMs: meanVerification,
    avgOffChainStorageBytes,
    avgPublicationStorageBytes,
    avgGasUsedPerBatch: gasCount > 0 ? totalGas / gasCount : undefined,
    totalGasUsed: gasCount > 0 ? totalGas : undefined,
    ci95AcceptanceLatencyMs: calculate95ConfidenceInterval(acceptanceLatencies),
    ci95EvidenceLatencyMs: calculate95ConfidenceInterval(evidenceLatencies),
  };
}

/**
 * Converts trial records to CSV format
 */
export function exportTrialsToCsv(trials: TrialRecord[]): string {
  const headers = [
    "trialId",
    "repetitionIndex",
    "architecture",
    "N",
    "K",
    "B",
    "failureScenario",
    "outcome",
    "acceptanceLatencyMs",
    "evidenceCompletionLatencyMs",
    "verificationLatencyMs",
    "offChainStorageBytes",
    "pubLayerStorageBytes",
    "gasUsedPerBatch",
    "totalGasUsed",
    "timestamp",
  ];

  const rows = trials.map((t) => [
    t.trialId,
    t.repetitionIndex,
    t.architecture,
    t.workload.N,
    t.workload.K,
    t.workload.B,
    `"${t.failureScenario}"`,
    t.outcome,
    t.acceptanceLatencyMs.toFixed(3),
    t.evidenceCompletionLatencyMs.toFixed(3),
    t.verificationLatencyMs.toFixed(3),
    t.storageBytes.offChainPackageBytes,
    t.storageBytes.publicationLayerStorageBytes,
    t.blockchainMetrics?.gasUsedPerBatch || 0,
    t.blockchainMetrics?.totalGasUsed || 0,
    t.timestamp,
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}
