import React, { useState, useEffect } from "react";
import { Send, CheckCircle2, XCircle, Clock, Database, Layers, ShieldCheck, AlertCircle, RefreshCw, ArrowRight } from "lucide-react";
import { SignedBatchManifest, ArchitectureEvidence } from "../../core/types";
import { LogClusterManager } from "../../services/transparency-log/log-manager";
import { IndependentPublisher, PublicationResult } from "../../publisher/independent-publisher";
import { CommonVerifier } from "../../verifier/common-verifier";
import { BrowserRegistrySimulator } from "../../services/browser-registry-simulator";

export interface PublicationInspectorProps {
  logManager?: LogClusterManager;
  signedManifest: SignedBatchManifest | null;
  onEvidenceReady?: (evidenceMap: { C1?: ArchitectureEvidence; C2?: ArchitectureEvidence; D?: ArchitectureEvidence }) => void;
  onNavigateToVerifier?: () => void;
  onLoadSampleBatch?: () => void;
}

export const PublicationInspector: React.FC<PublicationInspectorProps> = ({
  logManager: injectedLogManager,
  signedManifest,
  onEvidenceReady,
  onNavigateToVerifier,
  onLoadSampleBatch,
}) => {
  const [localLogManager] = useState(() => new LogClusterManager());
  const logManager = injectedLogManager || localLogManager;
  const [simulator] = useState(() => new BrowserRegistrySimulator());

  const [publisher] = useState(() => {
    const pub = new IndependentPublisher(logManager);
    pub.setValidator(new CommonVerifier(logManager, undefined, simulator.contractAddress));
    pub.setRegistry(simulator.getContract(), simulator.getAdapter(), simulator.getProvider());
    return pub;
  });


  const [c1Result, setC1Result] = useState<PublicationResult | null>(null);
  const [c2Result, setC2Result] = useState<PublicationResult | null>(null);
  const [dResult, setDResult] = useState<PublicationResult | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);

  // Failure simulation switches
  const [c1Outage, setC1Outage] = useState(false);
  const [c2LogAlphaDown, setC2LogAlphaDown] = useState(false);
  const [c2LogBetaDown, setC2LogBetaDown] = useState(false);
  const [dRpcDown, setDRpcDown] = useState(false);

  // Sync simulator faults
  useEffect(() => {
    simulator.config.endpointUnavailable = dRpcDown;
  }, [dRpcDown, simulator]);

  const handlePublishAll = async () => {
    if (!signedManifest) {
      if (onLoadSampleBatch) {
        onLoadSampleBatch();
      }
      return;
    }

    setIsPublishing(true);
    setPubError(null);

    // Apply failure injection
    logManager.resetAll();
    simulator.reset();
    simulator.config.endpointUnavailable = dRpcDown;

    if (c1Outage) {
      logManager.configureC1Failure({ unavailable: true });
    }

    const failingC2Logs: string[] = [];
    if (c2LogAlphaDown) failingC2Logs.push("LOG_C2_ALPHA");
    if (c2LogBetaDown) failingC2Logs.push("LOG_C2_BETA");
    if (failingC2Logs.length > 0) {
      logManager.configureC2Failure({ failingLogIds: failingC2Logs });
    }

    try {
      // Publish to C1, C2, D in parallel through Common Independent Publisher
      const [resC1, resC2, resD] = await Promise.all([
        publisher.publishToC1(signedManifest),
        publisher.publishToC2(signedManifest),
        publisher.publishToD(signedManifest),
      ]);

      setC1Result(resC1);
      setC2Result(resC2);
      setDResult(resD);

      if (onEvidenceReady) {
        onEvidenceReady({
          C1: resC1.evidence,
          C2: resC2.evidence,
          D: resD.evidence,
        });
      }
    } catch (err: any) {
      console.error("Publication error:", err);
      setPubError(err?.message || String(err));
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
      {/* Action Banner */}
      <div className="glass-card" style={{ padding: "1.75rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h3 style={{ fontSize: "1.2rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Send size={20} color="#6366f1" /> Independent Multi-Architecture Publication
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
              Submit signed batch manifest simultaneously to C1 (Single Log), C2 (3-Log Quorum), and D (Smart Contract Registry).
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            {onLoadSampleBatch && (
              <button
                className="btn-secondary"
                onClick={onLoadSampleBatch}
                title="Loads a fresh canonical test batch"
              >
                <RefreshCw size={15} />
                Load Sample Batch
              </button>
            )}

            <button
              className="btn-primary"
              onClick={handlePublishAll}
              disabled={isPublishing}
            >
              <Send size={16} />
              {isPublishing ? "Publishing to All..." : "Publish to C1, C2 & D"}
            </button>
          </div>
        </div>

        {/* Current Batch Information */}
        {signedManifest ? (
          <div style={{ marginTop: "1.25rem", padding: "0.85rem 1rem", background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.25)", borderRadius: "var(--radius-sm)", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", fontSize: "0.82rem" }}>
            <div>
              <span style={{ color: "var(--text-muted)", marginRight: "0.5rem" }}>Logical Batch ID:</span>
              <code style={{ color: "#a5b4fc" }}>{signedManifest.manifest.logicalBatchId.slice(0, 18)}...</code>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)", marginRight: "0.5rem" }}>Root:</span>
              <code style={{ color: "#34d399" }}>{signedManifest.manifest.merkleRoot.slice(0, 16)}...</code>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)", marginRight: "0.5rem" }}>Credentials:</span>
              <strong>{signedManifest.manifest.credentialCount}</strong>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)", marginRight: "0.5rem" }}>Issuer:</span>
              <code style={{ color: "#fbbf24" }}>{signedManifest.manifest.issuerAddress.slice(0, 12)}...</code>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.3)", borderRadius: "var(--radius-sm)", fontSize: "0.82rem", color: "#fcd34d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>No batch loaded. Click "Load Sample Batch" or create one in the Batching Studio.</span>
            {onLoadSampleBatch && (
              <button className="btn-secondary" onClick={onLoadSampleBatch} style={{ padding: "0.3rem 0.75rem", fontSize: "0.75rem" }}>
                Load Demo Batch
              </button>
            )}
          </div>
        )}

        {pubError && (
          <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "rgba(244, 63, 94, 0.15)", border: "1px solid rgba(244, 63, 94, 0.4)", borderRadius: "var(--radius-sm)", color: "#f43f5e", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <AlertCircle size={16} />
            <span>{pubError}</span>
          </div>
        )}

        {/* Live Failure Switches */}
        <div style={{ marginTop: "1.25rem", paddingTop: "1.25rem", borderTop: "1px solid var(--border-color)", display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)" }}>Simulate Live Faults:</span>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", cursor: "pointer" }}>
            <input type="checkbox" checked={c1Outage} onChange={(e) => setC1Outage(e.target.checked)} />
            <span style={{ color: c1Outage ? "#f43f5e" : "var(--text-secondary)" }}>C1 Log Down (503)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", cursor: "pointer" }}>
            <input type="checkbox" checked={c2LogAlphaDown} onChange={(e) => setC2LogAlphaDown(e.target.checked)} />
            <span style={{ color: c2LogAlphaDown ? "#f59e0b" : "var(--text-secondary)" }}>C2 Log Alpha Down (1-of-3)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", cursor: "pointer" }}>
            <input type="checkbox" checked={c2LogBetaDown} onChange={(e) => setC2LogBetaDown(e.target.checked)} />
            <span style={{ color: c2LogBetaDown ? "#f43f5e" : "var(--text-secondary)" }}>C2 Log Beta Down (2-of-3)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", cursor: "pointer" }}>
            <input type="checkbox" checked={dRpcDown} onChange={(e) => setDRpcDown(e.target.checked)} />
            <span style={{ color: dRpcDown ? "#f43f5e" : "var(--text-secondary)" }}>D Blockchain RPC Error</span>
          </label>
        </div>
      </div>

      {/* Navigation Shortcut after Publishing */}
      {(c1Result || c2Result || dResult) && onNavigateToVerifier && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-primary" onClick={onNavigateToVerifier} style={{ background: "linear-gradient(135deg, #10b981, #059669)" }}>
            <ShieldCheck size={16} /> Open in Verification Portal <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* 3 Publication Target Results */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.5rem" }}>
        {/* C1 Result */}
        <div className="glass-card" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-c1">C1: Single Log</span>
            {c1Result && (
              <span className={`badge ${c1Result.outcome === "SUCCESS" ? "badge-success" : "badge-danger"}`}>
                {c1Result.outcome}
              </span>
            )}
          </div>
          <div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Target Service:</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "#38bdf8" }}>LOG_C1_PRIMARY</div>
          </div>
          {c1Result ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
              <div><strong>Acceptance Latency:</strong> {c1Result.acceptanceLatencyMs !== null ? `${c1Result.acceptanceLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              <div><strong>Evidence Completion:</strong> {c1Result.evidenceCompletionLatencyMs !== null ? `${c1Result.evidenceCompletionLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              {c1Result.errorMessage && <div style={{ color: "#f43f5e" }}><strong>Error:</strong> {c1Result.errorMessage}</div>}
              {c1Result.evidence && (
                <div style={{ color: "#34d399", marginTop: "0.25rem" }}>
                  Checkpoint Tree Size: {(c1Result.evidence as any).checkpoint.treeSize}
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: "rgba(8, 11, 18, 0.4)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Waiting for publication command...
            </div>
          )}
        </div>

        {/* C2 Result */}
        <div className="glass-card" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-c2">C2: 3-Log 2-of-3</span>
            {c2Result && (
              <span className={`badge ${c2Result.outcome === "SUCCESS" ? "badge-success" : "badge-danger"}`}>
                {c2Result.outcome}
              </span>
            )}
          </div>
          <div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Log Cluster:</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "#c084fc" }}>Alpha, Beta, Gamma</div>
          </div>
          {c2Result ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
              <div><strong>Acceptance Latency:</strong> {c2Result.acceptanceLatencyMs !== null ? `${c2Result.acceptanceLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              <div><strong>Evidence Completion:</strong> {c2Result.evidenceCompletionLatencyMs !== null ? `${c2Result.evidenceCompletionLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              {c2Result.errorMessage && <div style={{ color: "#f43f5e" }}><strong>Error:</strong> {c2Result.errorMessage}</div>}
              {c2Result.evidence && (
                <div style={{ color: "#34d399", marginTop: "0.25rem" }}>
                  Quorum: {(c2Result.evidence as any).supportingProofs.length}/3 Logs Responded
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: "rgba(8, 11, 18, 0.4)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Waiting for publication command...
            </div>
          )}
        </div>

        {/* D Result */}
        <div className="glass-card" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-d">D: Blockchain</span>
            {dResult && (
              <span className={`badge ${dResult.outcome === "SUCCESS" ? "badge-success" : "badge-danger"}`}>
                {dResult.outcome}
              </span>
            )}
          </div>
          <div>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Smart Contract:</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "#fbbf24" }}>AcademicCertificateRegistry.sol</div>
          </div>
          {dResult ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(8, 11, 18, 0.7)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
              <div><strong>Acceptance Latency:</strong> {dResult.acceptanceLatencyMs !== null ? `${dResult.acceptanceLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              <div><strong>Evidence Completion:</strong> {dResult.evidenceCompletionLatencyMs !== null ? `${dResult.evidenceCompletionLatencyMs.toFixed(2)} ms` : "N/A"}</div>
              {dResult.gasUsed && <div><strong>Gas Used:</strong> {dResult.gasUsed.toString()} gas</div>}
              {dResult.errorMessage && <div style={{ color: "#f43f5e" }}><strong>Error:</strong> {dResult.errorMessage}</div>}
              {dResult.evidence && (
                <div style={{ color: "#34d399", marginTop: "0.25rem" }}>
                  Mined at Block #{(dResult.evidence as any).registeredBlockNumber} (224 Receipt Log Bytes)
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: "rgba(8, 11, 18, 0.4)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Waiting for publication command...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
