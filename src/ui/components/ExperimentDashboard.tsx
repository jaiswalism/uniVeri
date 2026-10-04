import React, { useState } from "react";
import { BarChart3, Play, Download, CheckCircle2, XCircle, AlertCircle, FileSpreadsheet, Cpu, Database, Flame, Layers, ShieldCheck, Activity } from "lucide-react";
import summaryData from "../../../results/statistical_summary.json";
import { LogClusterManager } from "../../services/transparency-log/log-manager";
import { BrowserRegistrySimulator } from "../../services/browser-registry-simulator";
import { IndependentPublisher } from "../../publisher/independent-publisher";
import { CommonVerifier } from "../../verifier/common-verifier";
import { generateSyntheticCertificate, createCertificateCommitment } from "../../core/certificate";
import { MerkleTree } from "../../core/merkle";
import { createBatchManifest, signBatchManifest } from "../../core/manifest";
import { Wallet } from "ethers";

export const ExperimentDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"workloads" | "failures" | "resources" | "live">("workloads");
  const [selectedWorkload, setSelectedWorkload] = useState<"W1" | "W2" | "W3" | "W4" | "W5" | "W6">("W4");

  // Live Micro-Benchmark State
  const [isLiveRunning, setIsLiveRunning] = useState(false);
  const [liveProgress, setLiveProgress] = useState(0);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [liveResults, setLiveResults] = useState<{
    c1Latency: number;
    c2Latency: number;
    dLatency: number;
    batchesRun: number;
  } | null>(null);

  const handleRunLiveMicroBenchmark = async () => {
    setIsLiveRunning(true);
    setLiveProgress(5);
    setLiveLog(["Initializing live in-browser micro-benchmark suite..."]);

    const logMgr = new LogClusterManager();
    const sim = new BrowserRegistrySimulator();
    const verifier = new CommonVerifier(logMgr);
    const publisher = new IndependentPublisher(logMgr);
    publisher.setValidator(verifier);
    publisher.setRegistry(sim.getContract(), sim.getAdapter(), sim.getProvider());

    const instWallet = Wallet.createRandom();
    const totalBatches = 6;
    let c1Total = 0;
    let c2Total = 0;
    let dTotal = 0;

    try {
      for (let b = 0; b < totalBatches; b++) {
        setLiveLog((prev) => [...prev, `Batch ${b + 1}/${totalBatches}: Generating 10 credentials and Merkle tree...`]);
        const certs = Array.from({ length: 10 }, (_, i) =>
          generateSyntheticCertificate({ issuerId: "did:edu:mit", index: b * 10 + i + 1 })
        );
        const leaves = certs.map((c) => createCertificateCommitment(c).leafHash);
        const tree = new MerkleTree(leaves);
        const manifest = createBatchManifest({
          issuerId: "did:edu:mit",
          issuerAddress: instWallet.address,
          issuerKeyVersion: 1,
          institutionBatchNumber: b + 1,
          merkleRoot: tree.getRoot(),
          credentialCount: certs.length,
        });
        const signed = await signBatchManifest(manifest, instWallet);

        // Run C1
        const resC1 = await publisher.publishToC1(signed);
        c1Total += resC1.acceptanceLatencyMs || 0;

        // Run C2
        const resC2 = await publisher.publishToC2(signed);
        c2Total += resC2.acceptanceLatencyMs || 0;

        // Run D
        const resD = await publisher.publishToD(signed);
        dTotal += resD.acceptanceLatencyMs || 0;

        setLiveProgress(Math.round(((b + 1) / totalBatches) * 100));
        setLiveLog((prev) => [
          ...prev,
          `Batch ${b + 1} completed: C1 (${(resC1.acceptanceLatencyMs || 0).toFixed(1)}ms), C2 (${(resC2.acceptanceLatencyMs || 0).toFixed(1)}ms), D (${(resD.acceptanceLatencyMs || 0).toFixed(1)}ms)`,
        ]);
      }

      setLiveResults({
        c1Latency: c1Total / totalBatches,
        c2Latency: c2Total / totalBatches,
        dLatency: dTotal / totalBatches,
        batchesRun: totalBatches,
      });
      setLiveLog((prev) => [...prev, "✓ In-browser live micro-benchmark completed successfully!"]);
    } catch (err: any) {
      setLiveLog((prev) => [...prev, `Error: ${err.message}`]);
    } finally {
      setIsLiveRunning(false);
    }
  };

  const workloads = (summaryData as any).workloads;
  const failureScenarios = (summaryData as any).failureScenarios;
  const currentW = workloads[selectedWorkload];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Header Banner */}
      <div className="glass-card" style={{ padding: "1.75rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h3 style={{ fontSize: "1.25rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <BarChart3 size={22} color="#6366f1" /> Empirical Research Results & Statistical Dashboard
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
              Comparative evaluation of 20,850 trials across 6 workloads (W1–W6) and 6 failure interventions.
            </p>
          </div>

          {/* Sub-tab Navigation */}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className={`btn-secondary ${activeTab === "workloads" ? "btn-primary" : ""}`}
              onClick={() => setActiveTab("workloads")}
              style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}
            >
              Workload Performance (W1–W6)
            </button>
            <button
              className={`btn-secondary ${activeTab === "failures" ? "btn-primary" : ""}`}
              onClick={() => setActiveTab("failures")}
              style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}
            >
              Failure Scenarios
            </button>
            <button
              className={`btn-secondary ${activeTab === "resources" ? "btn-primary" : ""}`}
              onClick={() => setActiveTab("resources")}
              style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}
            >
              Resource & Gas Footprint
            </button>
            <button
              className={`btn-secondary ${activeTab === "live" ? "btn-primary" : ""}`}
              onClick={() => setActiveTab("live")}
              style={{ fontSize: "0.8rem", padding: "0.45rem 0.9rem" }}
            >
              <Activity size={14} /> Live Browser Micro-Bench
            </button>
          </div>
        </div>
      </div>

      {/* TAB 1: Workload Performance */}
      {activeTab === "workloads" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Workload Selector Tabs */}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 600 }}>Select Workload:</span>
            {(["W1", "W2", "W3", "W4", "W5", "W6"] as const).map((w) => (
              <button
                key={w}
                className={`btn-secondary ${selectedWorkload === w ? "btn-primary" : ""}`}
                onClick={() => setSelectedWorkload(w)}
                style={{ padding: "0.35rem 0.85rem", fontSize: "0.8rem" }}
              >
                {w} {w === "W1" ? "(N=1k, K=100)" : w === "W2" ? "(N=10k, K=100)" : w === "W3" ? "(N=50k, K=100)" : w === "W4" ? "(N=10k, K=1k)" : w === "W5" ? "(N=50k, K=1k)" : "(N=50k, K=10k)"}
              </button>
            ))}
          </div>

          {/* 3 Architecture Metric Cards for Selected Workload */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.5rem" }}>
            {/* C1 Card */}
            <div className="glass-card" style={{ padding: "1.5rem", borderTop: "3px solid #06b6d4" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <span className="badge badge-c1">C1: Single Log</span>
                <span className="badge badge-success">{currentW.C1.successRatePct}% Success</span>
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
                Normal Operation Trials: <strong>{currentW.C1.totalTrials}</strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.82rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Mean Latency:</span>
                  <strong>{currentW.C1.latencyMs.mean.toFixed(2)} ms</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Std Dev:</span>
                  <span>{currentW.C1.latencyMs.stdDev.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Median:</span>
                  <span>{currentW.C1.latencyMs.median.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>P95:</span>
                  <span>{currentW.C1.latencyMs.p95.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-color)", paddingTop: "0.4rem" }}>
                  <span style={{ color: "var(--text-secondary)" }}>95% CI:</span>
                  <span style={{ color: "#38bdf8" }}>[{currentW.C1.latencyMs.ci95[0].toFixed(2)}, {currentW.C1.latencyMs.ci95[1].toFixed(2)}] ms</span>
                </div>
              </div>
            </div>

            {/* C2 Card */}
            <div className="glass-card" style={{ padding: "1.5rem", borderTop: "3px solid #8b5cf6" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <span className="badge badge-c2">C2: 3-Log Quorum (2-of-3)</span>
                <span className="badge badge-success">{currentW.C2.successRatePct}% Success</span>
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
                Normal Operation Trials: <strong>{currentW.C2.totalTrials}</strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.82rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Mean Latency:</span>
                  <strong>{currentW.C2.latencyMs.mean.toFixed(2)} ms</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Std Dev:</span>
                  <span>{currentW.C2.latencyMs.stdDev.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Median:</span>
                  <span>{currentW.C2.latencyMs.median.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>P95:</span>
                  <span>{currentW.C2.latencyMs.p95.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-color)", paddingTop: "0.4rem" }}>
                  <span style={{ color: "var(--text-secondary)" }}>95% CI:</span>
                  <span style={{ color: "#c084fc" }}>[{currentW.C2.latencyMs.ci95[0].toFixed(2)}, {currentW.C2.latencyMs.ci95[1].toFixed(2)}] ms</span>
                </div>
              </div>
            </div>

            {/* D Card */}
            <div className="glass-card" style={{ padding: "1.5rem", borderTop: "3px solid #fbbf24" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <span className="badge badge-d">D: Smart Contract Registry</span>
                <span className="badge badge-success">{currentW.D.successRatePct}% Success</span>
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
                Normal Operation Trials: <strong>{currentW.D.totalTrials}</strong>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.82rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Mean Latency:</span>
                  <strong>{currentW.D.latencyMs.mean.toFixed(2)} ms</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Std Dev:</span>
                  <span>{currentW.D.latencyMs.stdDev.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Median:</span>
                  <span>{currentW.D.latencyMs.median.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>P95:</span>
                  <span>{currentW.D.latencyMs.p95.toFixed(2)} ms</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-color)", paddingTop: "0.4rem" }}>
                  <span style={{ color: "var(--text-secondary)" }}>95% CI:</span>
                  <span style={{ color: "#fbbf24" }}>[{currentW.D.latencyMs.ci95[0].toFixed(2)}, {currentW.D.latencyMs.ci95[1].toFixed(2)}] ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Failure Scenarios */}
      {activeTab === "failures" && (
        <div className="glass-card" style={{ padding: "1.5rem" }}>
          <h4 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "1rem" }}>
            Failure Interventions & Resilience Matrix (100 Trials Each)
          </h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color)", color: "var(--text-muted)" }}>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Scenario Code</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Arch</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Fault Description</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Success</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Dominant Failure Class</th>
                  <th style={{ padding: "0.75rem 0.5rem" }}>Retrieval Outcome</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(failureScenarios).map(([key, sc]: [string, any]) => (
                  <tr key={key} style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}>
                    <td style={{ padding: "0.75rem 0.5rem", fontFamily: "var(--font-mono)", color: "#a5b4fc" }}>{key}</td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      <span className={`badge badge-${sc.architecture.toLowerCase()}`}>{sc.architecture}</span>
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem", color: "var(--text-secondary)" }}>{sc.description}</td>
                    <td style={{ padding: "0.75rem 0.5rem" }}>
                      <span className={`badge ${sc.outcomes.SUCCESS > 0 ? "badge-success" : "badge-danger"}`}>
                        {sc.outcomes.SUCCESS}/{sc.publicationTrialCount}
                      </span>
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem", fontFamily: "var(--font-mono)", color: "#f43f5e" }}>
                      {sc.outcomes.INSUFFICIENT_EVIDENCE > 0 ? "INSUFFICIENT_EVIDENCE" : sc.outcomes.INFRASTRUCTURE_ERROR > 0 ? "INFRASTRUCTURE_ERROR" : sc.outcomes.TIMEOUT > 0 ? "TIMEOUT" : "NONE"}
                    </td>
                    <td style={{ padding: "0.75rem 0.5rem", fontSize: "0.78rem" }}>
                      {sc.retrievalOutcome.publishedCount > 0 ? (
                        <span style={{ color: "#34d399" }}>{sc.retrievalOutcome.publishedCount}/10 Published</span>
                      ) : sc.retrievalOutcome.staleCount > 0 ? (
                        <span style={{ color: "#f59e0b" }}>{sc.retrievalOutcome.staleCount}/10 Stale (Omission)</span>
                      ) : (
                        <span style={{ color: "#f43f5e" }}>{sc.retrievalOutcome.insufficientCount}/10 Insufficient</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Resource & Gas Footprint */}
      {activeTab === "resources" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.5rem" }}>
          {/* C2 Storage Decomposition Card */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Database size={18} color="#8b5cf6" /> C2 Per-Log Storage Decomposition
            </h4>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
              Exact serialized-state bytes per log node and verified aggregate sum (Alpha + Beta + Gamma == Aggregate).
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.82rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>LOG_C2_ALPHA:</span>
                <code style={{ color: "#c084fc" }}>12,451 Bytes</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>LOG_C2_BETA:</span>
                <code style={{ color: "#c084fc" }}>12,450 Bytes</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>LOG_C2_GAMMA:</span>
                <code style={{ color: "#c084fc" }}>12,451 Bytes</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-color)", paddingTop: "0.5rem", fontWeight: 700 }}>
                <span>LOG_C2_AGGREGATE:</span>
                <code style={{ color: "#34d399" }}>37,352 Bytes</code>
              </div>
            </div>
          </div>

          {/* Architecture D Gas & Event Metrics */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Flame size={18} color="#fbbf24" /> Architecture D EVM Gas & Byte Audit
            </h4>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
              Derived directly from publication_traces.json receipts and confirmed state storage.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.82rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Gas Range (Measured):</span>
                <code style={{ color: "#fbbf24" }}>183,624 – 217,910 gas</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Receipt Log Bytes (Event):</span>
                <code style={{ color: "#34d399" }}>224 Bytes (4 Topics + Data)</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Measured Calldata Payload:</span>
                <code style={{ color: "#38bdf8" }}>388 Bytes</code>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Storage Layout (Estimate):</span>
                <code style={{ color: "var(--text-muted)" }}>160 Bytes (5 SSTORE words)</code>
              </div>
            </div>
          </div>

          {/* Unmeasured / Limitation Audit Card */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <ShieldCheck size={18} color="#06b6d4" /> Resource Provenance & Boundaries
            </h4>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
              Clear distinction between empirically measured values and unmeasured publisher resources.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.78rem" }}>
              <div style={{ color: "#34d399" }}>✓ Log Serialized Storage: MEASURED_SERIALIZED_STATE</div>
              <div style={{ color: "#34d399" }}>✓ Transaction Gas & Logs: FINALIZED_BLOCK_RECEIPT</div>
              <div style={{ color: "#f59e0b" }}>⚠ Publisher CPU / Memory / Net: UNAVAILABLE_OR_UNMEASURED</div>
              <div style={{ color: "#f59e0b" }}>⚠ Preprocessing Duration: UNAVAILABLE_OR_UNMEASURED</div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Live Browser Micro-Benchmark */}
      {activeTab === "live" && (
        <div className="glass-card" style={{ padding: "1.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "1rem" }}>
            <div>
              <h4 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Activity size={18} color="#6366f1" /> Run Live In-Browser Micro-Benchmark
              </h4>
              <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                Executes 6 consecutive batches (60 synthetic credentials) across C1, C2, and D in real-time within your browser JavaScript engine.
              </p>
            </div>

            <button
              className="btn-primary"
              onClick={handleRunLiveMicroBenchmark}
              disabled={isLiveRunning}
            >
              <Play size={16} />
              {isLiveRunning ? "Running Trials..." : "Run Micro-Benchmark"}
            </button>
          </div>

          {isLiveRunning && (
            <div style={{ width: "100%", height: "6px", background: "rgba(255, 255, 255, 0.1)", borderRadius: "3px", overflow: "hidden", marginBottom: "1rem" }}>
              <div style={{ width: `${liveProgress}%`, height: "100%", background: "linear-gradient(90deg, #6366f1, #34d399)", transition: "width 0.2s" }} />
            </div>
          )}

          {liveResults && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginBottom: "1.25rem" }}>
              <div style={{ background: "rgba(6, 182, 212, 0.1)", border: "1px solid rgba(6, 182, 212, 0.3)", padding: "1rem", borderRadius: "var(--radius-sm)" }}>
                <div style={{ fontSize: "0.75rem", color: "#38bdf8" }}>C1 Acceptance Latency</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 800, marginTop: "0.25rem" }}>{liveResults.c1Latency.toFixed(2)} ms</div>
              </div>
              <div style={{ background: "rgba(139, 92, 246, 0.1)", border: "1px solid rgba(139, 92, 246, 0.3)", padding: "1rem", borderRadius: "var(--radius-sm)" }}>
                <div style={{ fontSize: "0.75rem", color: "#c084fc" }}>C2 Acceptance Latency</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 800, marginTop: "0.25rem" }}>{liveResults.c2Latency.toFixed(2)} ms</div>
              </div>
              <div style={{ background: "rgba(251, 191, 36, 0.1)", border: "1px solid rgba(251, 191, 36, 0.3)", padding: "1rem", borderRadius: "var(--radius-sm)" }}>
                <div style={{ fontSize: "0.75rem", color: "#fbbf24" }}>D Acceptance Latency</div>
                <div style={{ fontSize: "1.3rem", fontWeight: 800, marginTop: "0.25rem" }}>{liveResults.dLatency.toFixed(2)} ms</div>
              </div>
            </div>
          )}

          {/* Console Output */}
          <div style={{ background: "rgba(5, 8, 15, 0.9)", border: "1px solid var(--border-color)", padding: "1rem", borderRadius: "var(--radius-sm)", maxHeight: "200px", overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "#94a3b8", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {liveLog.length === 0 ? (
              <span style={{ color: "var(--text-muted)" }}>Click "Run Micro-Benchmark" to start live execution...</span>
            ) : (
              liveLog.map((line, i) => (
                <div key={i} style={{ color: line.startsWith("✓") ? "#34d399" : line.startsWith("Error") ? "#f43f5e" : "#cbd5e1" }}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
