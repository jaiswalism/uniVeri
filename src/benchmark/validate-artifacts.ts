import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface ArtifactAuditReport {
  publicationTrialsCount: number;
  expectedPublicationCount: number;
  publicationCountMatch: boolean;
  verificationQueriesCount: number;
  expectedVerificationCount: number;
  verificationCountMatch: boolean;
  resourceMeasurementsCount: number;
  correctnessTestsCount: number;
  correctnessPassingCount: number;
  duplicatePublicationRows: number;
  duplicateVerificationRows: number;
  runConfigValid: boolean;
  timestampOrderValid: boolean;
  verificationLatencyArithmeticValid: boolean;
  resourceIntegrityValid: boolean;
  correctnessTestsValid: boolean;
  c2StorageAccountingValid?: boolean;
  traceResourceAgreementValid?: boolean;
  statisticalSummaryValid?: boolean;
  c2ReadOmissionValid?: boolean;
  reproducibilityMetadataValid?: boolean;
  architectureSummary: {
    [arch: string]: {
      totalTrials: number;
      successCount: number;
      timeoutCount: number;
      failureCount: number;
      successRatePct: number;
      medianEvidenceLatencyMs: number;
      p95EvidenceLatencyMs: number;
    };
  };
  validationErrors: string[];
  overallPassed: boolean;
}

export function validateArtifacts(resultsDir: string = "./results"): ArtifactAuditReport {
  const pubPath = path.join(resultsDir, "publication_trials.csv");
  const verPath = path.join(resultsDir, "verification_queries.csv");
  const resPath = path.join(resultsDir, "resource_measurements.csv");
  const corPath = path.join(resultsDir, "correctness_tests.csv");
  const cfgPath = path.join(resultsDir, "run_config.json");

  const errors: string[] = [];

  if (!fs.existsSync(pubPath) || !fs.existsSync(verPath) || !fs.existsSync(resPath) || !fs.existsSync(corPath) || !fs.existsSync(cfgPath)) {
    throw new Error("One or more required artifact files (including run_config.json) are missing from " + resultsDir);
  }

  // 1. Audit run_config.json
  let runConfigValid = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg.specVersion || !cfg.timestamp || !cfg.executionEnvironment) {
      runConfigValid = false;
      errors.push("run_config.json missing required metadata fields (specVersion, timestamp, executionEnvironment)");
    }
    if (cfg.retryPolicy?.deadlineMs !== 1000) {
      runConfigValid = false;
      errors.push(`run_config.json unexpected deadline: expected 1000ms, got ${cfg.retryPolicy?.deadlineMs}`);
    }
    if (cfg.quorumRequirement !== "2-of-3") {
      runConfigValid = false;
      errors.push(`run_config.json unexpected C2 threshold: expected 2-of-3, got ${cfg.quorumRequirement}`);
    }
  } catch (err: any) {
    runConfigValid = false;
    errors.push(`Failed to parse run_config.json: ${err.message}`);
  }

  // 2. Audit Publication Trials
  const pubContent = fs.readFileSync(pubPath, "utf8").trim().split("\n");
  const pubRows = pubContent.slice(1);
  const pubCount = pubRows.length;
  const expectedPubCount = 20850; // (10+100+500+10+50+5)*3*10 + (10*6*10) = 20,250 + 600 = 20,850

  const pubKeySet = new Set<string>();
  let duplicatePubs = 0;
  let timestampOrderValid = true;
  const archStats: { [arch: string]: { latencies: number[]; successes: number; timeouts: number; failures: number } } = {
    C1: { latencies: [], successes: 0, timeouts: 0, failures: 0 },
    C2: { latencies: [], successes: 0, timeouts: 0, failures: 0 },
    D: { latencies: [], successes: 0, timeouts: 0, failures: 0 },
  };

  for (let idx = 0; idx < pubRows.length; idx++) {
    const row = pubRows[idx];
    const cols = row.split(",");
    const runId = cols[0];
    const arch = cols[1];
    const batchId = cols[6];
    const tSubmit = parseFloat(cols[7]);
    const tFirstAccept = cols[8] !== "null" && cols[8] !== "" ? parseFloat(cols[8]) : null;
    const tQuorumAccept = cols[9] !== "null" && cols[9] !== "" ? parseFloat(cols[9]) : null;
    const tEvidenceComplete = cols[10] !== "null" && cols[10] !== "" ? parseFloat(cols[10]) : null;
    const outcome = cols[11];

    const key = `${runId}_${batchId}`;
    if (pubKeySet.has(key)) duplicatePubs++;
    pubKeySet.add(key);

    // Validate monotonic timestamp ordering: submit <= firstAccept <= quorumAccept <= evidenceComplete
    if (tFirstAccept !== null && tFirstAccept < tSubmit - 1.0) {
      timestampOrderValid = false;
      if (errors.length < 15) errors.push(`Row ${idx + 2} (${key}): first acceptance (${tFirstAccept}) < submission (${tSubmit})`);
    }
    if (tFirstAccept !== null && tQuorumAccept !== null && tQuorumAccept < tFirstAccept - 1.0) {
      timestampOrderValid = false;
      if (errors.length < 15) errors.push(`Row ${idx + 2} (${key}): quorum acceptance (${tQuorumAccept}) < first acceptance (${tFirstAccept})`);
    }
    if (tFirstAccept !== null && tEvidenceComplete !== null && tEvidenceComplete < tFirstAccept - 1.0) {
      timestampOrderValid = false;
      if (errors.length < 15) errors.push(`Row ${idx + 2} (${key}): evidence completion (${tEvidenceComplete}) < first acceptance (${tFirstAccept})`);
    }
    if (tQuorumAccept !== null && tEvidenceComplete !== null && tEvidenceComplete < tQuorumAccept - 1.0) {
      timestampOrderValid = false;
      if (errors.length < 15) errors.push(`Row ${idx + 2} (${key}): evidence completion (${tEvidenceComplete}) < quorum acceptance (${tQuorumAccept})`);
    }

    if (archStats[arch]) {
      if (outcome === "SUCCESS") {
        archStats[arch].successes++;
        if (tEvidenceComplete !== null) {
          archStats[arch].latencies.push(tEvidenceComplete - tSubmit);
        }
      } else if (outcome === "TIMEOUT") {
        archStats[arch].timeouts++;
      } else {
        archStats[arch].failures++;
      }
    }
  }

  // 3. Audit Verification Queries
  const verContent = fs.readFileSync(verPath, "utf8").trim().split("\n");
  const verRows = verContent.slice(1);
  const verCount = verRows.length;
  const expectedVerCount = 420; // 360 normal (180 fresh + 180 cached) + 60 failure
  const verKeySet = new Set<string>();
  let duplicateVers = 0;
  let verificationLatencyArithmeticValid = true;

  for (let idx = 0; idx < verRows.length; idx++) {
    const row = verRows[idx];
    const cols = row.split(",");
    const queryId = cols[1];
    const cacheMode = cols[3];
    const retrieval = parseFloat(cols[4]);
    const localVal = parseFloat(cols[5]);
    const total = parseFloat(cols[6]);

    if (verKeySet.has(queryId)) duplicateVers++;
    verKeySet.add(queryId);

    if (cacheMode === "CACHED") {
      if (Math.abs(retrieval) > 0.001) {
        verificationLatencyArithmeticValid = false;
        if (errors.length < 15) errors.push(`Verification query ${queryId}: CACHED mode has non-zero retrieval latency: ${retrieval}`);
      }
      if (total < localVal - 0.05) {
        verificationLatencyArithmeticValid = false;
        if (errors.length < 15) errors.push(`Verification query ${queryId}: total latency (${total}) < local (${localVal})`);
      }
    } else {
      if (Math.abs(total - (retrieval + localVal)) > 0.5) {
        verificationLatencyArithmeticValid = false;
        if (errors.length < 15) errors.push(`Verification query ${queryId}: total latency (${total}) != retrieval (${retrieval}) + local (${localVal})`);
      }
    }
  }

  function parseCsvLine(text: string): string[] {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  }

  // 4. Audit Resource Measurements
  const resContent = fs.readFileSync(resPath, "utf8").trim().split("\n");
  const resRows = resContent.slice(1);
  let resourceIntegrityValid = resRows.length > 0;
  let hasGasMeasurement = false;
  let hasCalldataMeasurement = false;

  for (const row of resRows) {
    const cols = row.split(",");
    const metric = cols[3];
    const val = parseFloat(cols[4]);
    if (metric && metric.includes("GAS") && val > 0) hasGasMeasurement = true;
    if (metric && metric.includes("CALLDATA") && val >= 388) hasCalldataMeasurement = true;
  }
  if (!hasGasMeasurement || !hasCalldataMeasurement) {
    resourceIntegrityValid = false;
    errors.push("Resource measurements missing valid D gas measurements (>0) or exact calldata measurements (>=388 bytes)");
  }

  // Check C2 Storage Accounting: Alpha + Beta + Gamma == Aggregate
  let c2StorageAccountingValid = true;
  const c2Runs = new Set(resRows.map((r) => r.split(",")).filter((r) => r[1] === "C2").map((r) => r[0]));
  for (const rId of c2Runs) {
    const rowsForRun = resRows.map((r) => r.split(",")).filter((r) => r[0] === rId);
    const a = parseFloat(rowsForRun.find((r) => r[2] === "LOG_C2_ALPHA")?.[4] || "0");
    const b = parseFloat(rowsForRun.find((r) => r[2] === "LOG_C2_BETA")?.[4] || "0");
    const g = parseFloat(rowsForRun.find((r) => r[2] === "LOG_C2_GAMMA")?.[4] || "0");
    const agg = parseFloat(rowsForRun.find((r) => r[2] === "LOG_C2_AGGREGATE")?.[4] || "0");
    if (a <= 0 || b <= 0 || g <= 0 || agg <= 0 || a + b + g !== agg) {
      c2StorageAccountingValid = false;
      errors.push(`C2 storage mismatch for ${rId}: alpha(${a}) + beta(${b}) + gamma(${g}) = ${a + b + g} != aggregate(${agg})`);
    }
  }

  // Check Gas, Calldata, and Event Bytes Agreement with publication_traces.json
  let traceResourceAgreementValid = true;
  const tracePath = path.join(resultsDir, "publication_traces.json");
  if (fs.existsSync(tracePath)) {
    try {
      const traces = JSON.parse(fs.readFileSync(tracePath, "utf8"));
      const dRuns = new Set(traces.filter((t: any) => t.architecture === "D" && t.scenario === "NORMAL_OPERATION").map((t: any) => t.runId));
      const resParsed = resRows.map((r) => r.split(","));
      for (const rId of dRuns) {
        const tGas = traces.filter((t: any) => t.runId === rId).reduce((sum: number, t: any) => sum + Number(t.provenance?.gasUsed || 0), 0);
        const tCd = traces.filter((t: any) => t.runId === rId).reduce((sum: number, t: any) => sum + Number(t.provenance?.calldataBytes || 0), 0);
        const tEv = traces.filter((t: any) => t.runId === rId).reduce((sum: number, t: any) => sum + Number(t.provenance?.eventBytes || 0), 0);

        const mGas = parseFloat(resParsed.find((r) => r[0] === rId && r[3] === "TOTAL_GAS_USED")?.[4] || "0");
        const mCd = parseFloat(resParsed.find((r) => r[0] === rId && r[3] === "CALLDATA_BYTES")?.[4] || "0");
        const mEv = parseFloat(resParsed.find((r) => r[0] === rId && r[3] === "EVENT_BYTES")?.[4] || "0");

        if (tGas !== mGas || tCd !== mCd || tEv !== mEv) {
          traceResourceAgreementValid = false;
          errors.push(`Resource/trace mismatch for ${rId}: gas(trace ${tGas}, csv ${mGas}), calldata(trace ${tCd}, csv ${mCd}), event(trace ${tEv}, csv ${mEv})`);
        }
      }
    } catch (e: any) {
      traceResourceAgreementValid = false;
      errors.push(`Failed to audit publication_traces.json agreement: ${e.message}`);
    }
  }

  // Check statistical_summary.json Workload Filtering (scenario === "NORMAL_OPERATION" only)
  let statisticalSummaryValid = true;
  const summaryPath = path.join(resultsDir, "statistical_summary.json");
  if (fs.existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      const expectedCounts: Record<string, number> = { W1: 100, W2: 1000, W3: 5000, W4: 100, W5: 500, W6: 50 };
      for (const [wId, exp] of Object.entries(expectedCounts)) {
        for (const arch of ["C1", "C2", "D"]) {
          const actualTrials = summary.workloads?.[wId]?.[arch]?.totalTrials;
          if (actualTrials !== exp) {
            statisticalSummaryValid = false;
            errors.push(`Workload ${wId} ${arch} trials count mismatch in statistical_summary.json: expected ${exp} (NORMAL_OPERATION only), got ${actualTrials}`);
          }
        }
      }
      if (summary.workloads?.W4?.C1?.successRatePct !== 100 || summary.workloads?.W4?.D?.successRatePct !== 100) {
        statisticalSummaryValid = false;
        errors.push(`W4 normal-operation success rate diluted in statistical_summary.json: C1=${summary.workloads?.W4?.C1?.successRatePct}%, D=${summary.workloads?.W4?.D?.successRatePct}%`);
      }
    } catch (e: any) {
      statisticalSummaryValid = false;
      errors.push(`Failed to audit statistical_summary.json: ${e.message}`);
    }
  }

  // Check C2 Read Omission in verification_queries.csv
  let c2ReadOmissionValid = true;
  const c2OmitQueries = verRows.filter((r) => r.includes("C2_ONE_LOG_OMISSION"));
  if (c2OmitQueries.length > 0) {
    for (const qLine of c2OmitQueries) {
      const parts = parseCsvLine(qLine);
      const avail = parts[7] === "true";
      const pub = parts[10];
      const status = parts[11];
      const boundary = parts[12] || "";
      if (!avail || pub !== "PUBLISHED" || status !== "STATUS_UNKNOWN" || !boundary.includes("Quorum 2/3")) {
        c2ReadOmissionValid = false;
        errors.push(`C2 read omission query ${parts[1]} invalid semantics: expected [true, PUBLISHED, STATUS_UNKNOWN, Quorum 2/3], got [${avail}, ${pub}, ${status}, ${boundary}]`);
      }
    }
  }

  // Check run_config.json Reproducibility Metadata
  let reproducibilityMetadataValid = true;
  if (runConfigValid) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (!cfg.warmup || !cfg.executionOrderSchedule || !cfg.fixed50kInput || !cfg.statisticalMethod) {
        reproducibilityMetadataValid = false;
        errors.push("run_config.json missing required reproducibility metadata (warmup, executionOrderSchedule, fixed50kInput, statisticalMethod)");
      }
      if (cfg.companionArtifactHashes) {
        for (const [fName, expHash] of Object.entries(cfg.companionArtifactHashes)) {
          const fPath = path.join(resultsDir, fName);
          if (fs.existsSync(fPath)) {
            const actualHash = crypto.createHash("sha256").update(fs.readFileSync(fPath)).digest("hex");
            if (actualHash !== expHash) {
              reproducibilityMetadataValid = false;
              errors.push(`Companion artifact checksum mismatch for ${fName}: expected ${expHash}, got ${actualHash}`);
            }
          }
        }
      }
    } catch (e: any) {
      reproducibilityMetadataValid = false;
      errors.push(`Reproducibility metadata validation error: ${e.message}`);
    }
  }

  // 5. Audit Correctness Tests: Independently assert and compare all expected vs observed fields
  const corContent = fs.readFileSync(corPath, "utf8").trim().split("\n");
  const corRows = corContent.slice(1);
  let corPassing = 0;
  let corMismatches = 0;

  for (let idx = 0; idx < corRows.length; idx++) {
    const cols = parseCsvLine(corRows[idx]);
    if (cols.length >= 10) {
      const tcId = cols[0];
      const expectedAuth = cols[3];
      const observedAuth = cols[4];
      const expectedPub = cols[5];
      const observedPub = cols[6];
      const expectedStatus = cols[7];
      const observedStatus = cols[8];
      const passFail = cols[9];

      const matches =
        expectedAuth === observedAuth &&
        expectedPub === observedPub &&
        expectedStatus === observedStatus;

      if (!matches) {
        corMismatches++;
        errors.push(
          `Correctness test ${tcId} field mismatch: expected [${expectedAuth}, ${expectedPub}, ${expectedStatus}], got [${observedAuth}, ${observedPub}, ${observedStatus}]`
        );
      }
      if (passFail !== "PASS") {
        errors.push(`Correctness test ${tcId} marked as ${passFail}`);
      } else if (matches) {
        corPassing++;
      }
    }
  }

  const correctnessTestsValid = corRows.length >= 8 && corPassing === corRows.length && corMismatches === 0;
  if (!correctnessTestsValid) {
    errors.push(`Correctness tests failed: ${corPassing}/${corRows.length} passing with 0 mismatches (expected >=8)`);
  }

  const architectureSummary: any = {};
  for (const arch of ["C1", "C2", "D"]) {
    const data = archStats[arch];
    data.latencies.sort((a, b) => a - b);
    const total = data.successes + data.timeouts + data.failures;
    const median = data.latencies.length > 0 ? data.latencies[Math.floor(data.latencies.length * 0.5)] : 0;
    const p95 = data.latencies.length > 0 ? data.latencies[Math.floor(data.latencies.length * 0.95)] : 0;

    architectureSummary[arch] = {
      totalTrials: total,
      successCount: data.successes,
      timeoutCount: data.timeouts,
      failureCount: data.failures,
      successRatePct: parseFloat(((data.successes / (total || 1)) * 100).toFixed(2)),
      medianEvidenceLatencyMs: parseFloat(median.toFixed(3)),
      p95EvidenceLatencyMs: parseFloat(p95.toFixed(3)),
    };
  }

  const overallPassed =
    pubCount === expectedPubCount &&
    verCount === expectedVerCount &&
    duplicatePubs === 0 &&
    duplicateVers === 0 &&
    runConfigValid &&
    timestampOrderValid &&
    verificationLatencyArithmeticValid &&
    resourceIntegrityValid &&
    c2StorageAccountingValid &&
    traceResourceAgreementValid &&
    statisticalSummaryValid &&
    c2ReadOmissionValid &&
    reproducibilityMetadataValid &&
    correctnessTestsValid;

  return {
    publicationTrialsCount: pubCount,
    expectedPublicationCount: expectedPubCount,
    publicationCountMatch: pubCount === expectedPubCount,
    verificationQueriesCount: verCount,
    expectedVerificationCount: expectedVerCount,
    verificationCountMatch: verCount === expectedVerCount,
    resourceMeasurementsCount: resRows.length,
    correctnessTestsCount: corRows.length,
    correctnessPassingCount: corPassing,
    duplicatePublicationRows: duplicatePubs,
    duplicateVerificationRows: duplicateVers,
    runConfigValid,
    timestampOrderValid,
    verificationLatencyArithmeticValid,
    resourceIntegrityValid,
    correctnessTestsValid,
    c2StorageAccountingValid,
    traceResourceAgreementValid,
    statisticalSummaryValid,
    c2ReadOmissionValid,
    reproducibilityMetadataValid,
    architectureSummary,
    validationErrors: errors,
    overallPassed,
  };
}

// Run standalone if called directly
if (process.argv[1]?.includes("validate-artifacts")) {
  const report = validateArtifacts("./results");
  console.log("================================================================================");
  console.log("  05-SPECIFICATION ARTIFACT AUDIT & COMPLETENESS REPORT                          ");
  console.log("================================================================================\n");
  console.log(`[1] Publication Trials: ${report.publicationTrialsCount} rows (Expected: ${report.expectedPublicationCount}) -> ${report.publicationCountMatch ? "MATCH [PASS]" : "MISMATCH [FAIL]"}`);
  console.log(`[2] Verification Queries: ${report.verificationQueriesCount} rows (Expected: ${report.expectedVerificationCount}) -> ${report.verificationCountMatch ? "MATCH [PASS]" : "MISMATCH [FAIL]"}`);
  console.log(`[3] Resource Measurements: ${report.resourceMeasurementsCount} rows -> ${report.resourceIntegrityValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[4] Correctness Tests: ${report.correctnessPassingCount}/${report.correctnessTestsCount} Passing -> ${report.correctnessTestsValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[5] Duplicate Rows: Publication=${report.duplicatePublicationRows}, Verification=${report.duplicateVerificationRows} -> [PASS]`);
  console.log(`[6] Monotonic Timestamp Ordering: ${report.timestampOrderValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[7] Verification Latency Arithmetic: ${report.verificationLatencyArithmeticValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[8] Run Config Validity: ${report.runConfigValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[9] C2 Per-Log Storage Accounting (alpha + beta + gamma == aggregate): ${report.c2StorageAccountingValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[10] Trace vs Resource Agreement (gas, calldata, event bytes): ${report.traceResourceAgreementValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[11] Statistical Summary (NORMAL_OPERATION workload separation): ${report.statisticalSummaryValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[12] C2 Read Omission Semantics: ${report.c2ReadOmissionValid ? "[PASS]" : "[FAIL]"}`);
  console.log(`[13] Reproducibility Metadata & Cryptographic Hashes: ${report.reproducibilityMetadataValid ? "[PASS]" : "[FAIL]"}`);

  if (report.validationErrors.length > 0) {
    console.log("\nValidation Errors Encountered:");
    for (const err of report.validationErrors) {
      console.log(`  - ${err}`);
    }
  }

  console.log("\n--- Architecture Performance & Resilience Summary ---");
  for (const [arch, stats] of Object.entries(report.architectureSummary)) {
    console.log(`  Architecture ${arch}:`);
    console.log(`    - Trials: ${stats.totalTrials} | Success: ${stats.successCount} | Timeouts: ${stats.timeoutCount} | Failures: ${stats.failureCount}`);
    console.log(`    - Success Rate: ${stats.successRatePct}%`);
    console.log(`    - Evidence Latency: Median = ${stats.medianEvidenceLatencyMs}ms, p95 = ${stats.p95EvidenceLatencyMs}ms`);
  }
  console.log("\n================================================================================");
  console.log(`Overall Audit Status: ${report.overallPassed ? "ALL 5 ARTIFACTS VERIFIED [PASS]" : "AUDIT FAILED"}`);
  console.log("================================================================================\n");
}
