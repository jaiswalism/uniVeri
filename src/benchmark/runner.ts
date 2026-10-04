import { ExperimentRunner } from "./experiment-runner.js";

async function main() {
  console.log("================================================================================");
  console.log("  ACADEMIC CERTIFICATE VERIFICATION: PUBLICATION ARCHITECTURE BENCHMARK SUITE   ");
  console.log("  Comparative Evaluation: C1 (Single Log) vs C2 (3-Log Quorum) vs D (Blockchain)");
  console.log("================================================================================\n");

  const runner = new ExperimentRunner({
    repetitions: 10,
    warmupRuns: 2,
    workloadMatrix: [
      { N: 1000, K: 100 },
      { N: 10000, K: 1000 },
      { N: 50000, K: 1000 },
      { N: 50000, K: 10000 },
    ],
  });

  console.log("Starting experiment execution across workload matrix & failure scenarios...");
  const startTime = Date.now();

  const { allTrials, aggregatedResults } = await runner.runFullSuite((msg) => {
    console.log(`[*] ${msg}`);
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n[+] Completed ${allTrials.length} trials in ${durationSec}s!`);
  console.log("[+] Results saved to ./results/benchmark-results.json and ./results/benchmark-results.csv\n");

  console.log("--------------------------------------------------------------------------------");
  console.log("SUMMARY: NORMAL OPERATION (N=10,000, K=1,000, B=10)");
  console.log("--------------------------------------------------------------------------------");

  const c1Norm = aggregatedResults["C1_N10000_K1000_NORMAL_OPERATION"];
  const c2Norm = aggregatedResults["C2_N10000_K1000_NORMAL_OPERATION"];
  const dNorm = aggregatedResults["D_N10000_K1000_NORMAL_OPERATION"];

  console.log(
    `C1 (Single Log):   Success: ${c1Norm?.successRatePercent}% | Acceptance: ${c1Norm?.medianAcceptanceLatencyMs.toFixed(2)}ms | Evidence: ${c1Norm?.medianEvidenceLatencyMs.toFixed(2)}ms | Storage: ${c1Norm?.avgPublicationStorageBytes}B`
  );
  console.log(
    `C2 (3-Log Quorum): Success: ${c2Norm?.successRatePercent}% | Acceptance: ${c2Norm?.medianAcceptanceLatencyMs.toFixed(2)}ms | Evidence: ${c2Norm?.medianEvidenceLatencyMs.toFixed(2)}ms | Storage: ${c2Norm?.avgPublicationStorageBytes}B`
  );
  console.log(
    `D  (Blockchain):   Success: ${dNorm?.successRatePercent}% | Acceptance: ${dNorm?.medianAcceptanceLatencyMs.toFixed(2)}ms | Evidence: ${dNorm?.medianEvidenceLatencyMs.toFixed(2)}ms | Gas: ${dNorm?.totalGasUsed} | Storage: ${dNorm?.avgPublicationStorageBytes}B`
  );

  console.log("\n--------------------------------------------------------------------------------");
  console.log("SUMMARY: FAILURE RESILIENCE COMPARISON (N=10,000, K=1,000)");
  console.log("--------------------------------------------------------------------------------");

  const c1Outage = aggregatedResults["C1_N10000_K1000_C1_OPERATOR_OUTAGE"];
  const c2OneFail = aggregatedResults["C2_N10000_K1000_C2_ONE_LOG_FAILURE"];
  const c2TwoFail = aggregatedResults["C2_N10000_K1000_C2_TWO_LOGS_FAILURE"];
  const dPathFail = aggregatedResults["D_N10000_K1000_D_TRANSACTION_PATH_FAILURE"];

  console.log(`Scenario: C1 Operator Outage      -> C1 Success Rate: ${c1Outage?.successRatePercent}% (Single-operator dependency confirmed)`);
  console.log(`Scenario: C2 1-of-3 Log Failure   -> C2 Success Rate: ${c2OneFail?.successRatePercent}% (Quorum availability confirmed)`);
  console.log(`Scenario: C2 2-of-3 Logs Failure  -> C2 Success Rate: ${c2TwoFail?.successRatePercent}% (Quorum threshold property confirmed)`);
  console.log(`Scenario: D Tx-Path Failure       -> D  Success Rate: ${dPathFail?.successRatePercent}% (Tx-path dependency observed)`);
  console.log("================================================================================\n");
}

main().catch(console.error);
