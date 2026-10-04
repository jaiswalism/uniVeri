import React from "react";
import { ShieldCheck, Database, Layers, ArrowRight, CheckCircle2, Lock, GitBranch, Cpu, AlertTriangle } from "lucide-react";

export const ArchitectureDiagram: React.FC = () => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Research Statement Header */}
      <div className="glass-card glass-card-glow" style={{ padding: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <span className="badge" style={{ background: "rgba(99, 102, 241, 0.2)", color: "#a5b4fc", border: "1px solid rgba(99, 102, 241, 0.4)" }}>
            Frozen Research Scope
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            C1 vs C2-A vs D Publication Layer Trade-off Study
          </span>
        </div>
        <h2 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.025em", marginBottom: "0.75rem" }}>
          Common Pipeline with 3 Independent Publication Layers
        </h2>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: "900px", fontSize: "0.95rem" }}>
          All three architectures receive the <strong>exact same cryptographic objects</strong> (canonical certificate records, high-entropy privacy salts, binary Merkle roots, and ECDSA-signed batch manifests). The publication layer is the independent variable, holding the publisher, workload, and verifier constant.
        </p>
      </div>

      {/* Visual Pipeline Flow */}
      <div className="glass-card" style={{ padding: "2rem" }}>
        <h3 style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Layers size={20} color="#6366f1" /> End-to-End Cryptographic Flow
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", alignItems: "center" }}>
          {/* Step 1 */}
          <div style={{ background: "rgba(16, 21, 34, 0.8)", padding: "1.25rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700 }}>1</div>
              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>Institution</span>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              Authoritative issuing university signs canonical academic claims with high-entropy salt commitments.
            </p>
          </div>

          {/* Step 2 */}
          <div style={{ background: "rgba(16, 21, 34, 0.8)", padding: "1.25rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#8b5cf6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700 }}>2</div>
              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>Merkle Batching</span>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              N certificates partitioned into batches of size K. Binary Merkle tree computes root commitment and inclusion proofs.
            </p>
          </div>

          {/* Step 3 */}
          <div style={{ background: "rgba(16, 21, 34, 0.8)", padding: "1.25rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#06b6d4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700 }}>3</div>
              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>Signed Manifest</span>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              Separates <code>logicalBatchID</code> vs <code>batchContentID</code>. Signed with institution ECDSA key.
            </p>
          </div>

          {/* Step 4 */}
          <div style={{ background: "rgba(16, 21, 34, 0.8)", padding: "1.25rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: "#10b981", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700 }}>4</div>
              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>Independent Publisher</span>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              Single uniform client applies identical retry, timeout, and submission policy across C1, C2, and D.
            </p>
          </div>
        </div>
      </div>

      {/* 3 Architecture Comparison Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.5rem" }}>
        {/* Architecture C1 */}
        <div className="glass-card" style={{ padding: "1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-c1">Architecture C1</span>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Single Operator</span>
          </div>
          <h3 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Single Transparency Log</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Conventional append-only Merkle log operated by a designated entity. Generates Signed Tree Checkpoints (STH) and log inclusion proofs.
          </p>
          <div style={{ background: "rgba(8, 11, 18, 0.6)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
            <div style={{ color: "#38bdf8", fontWeight: 600, marginBottom: "0.35rem" }}>Strengths:</div>
            <div style={{ color: "var(--text-secondary)", marginBottom: "0.75rem" }}>Minimal storage overhead, low latency under normal conditions.</div>
            <div style={{ color: "#f43f5e", fontWeight: 600, marginBottom: "0.35rem" }}>Vulnerability:</div>
            <div style={{ color: "var(--text-secondary)" }}>Single operator failure domain (100% publication outage if operator is unavailable or censoring).</div>
          </div>
        </div>

        {/* Architecture C2 */}
        <div className="glass-card" style={{ padding: "1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-c2">Architecture C2-A</span>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>2-of-3 Quorum</span>
          </div>
          <h3 style={{ fontSize: "1.25rem", fontWeight: 700 }}>3 Independent Transparency Logs</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Signed batch manifests are submitted to 3 configured logs (Alpha, Beta, Gamma). Verification requires valid inclusion proofs from ≥ 2 logs.
          </p>
          <div style={{ background: "rgba(8, 11, 18, 0.6)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
            <div style={{ color: "#c084fc", fontWeight: 600, marginBottom: "0.35rem" }}>Strengths:</div>
            <div style={{ color: "var(--text-secondary)", marginBottom: "0.75rem" }}>Tolerates 1 unavailable or censoring log with zero downtime without blockchain costs.</div>
            <div style={{ color: "#f43f5e", fontWeight: 600, marginBottom: "0.35rem" }}>Limitation:</div>
            <div style={{ color: "var(--text-secondary)" }}>3x aggregate storage overhead; reports <code>NO_REVOCATION_OBSERVED</code> rather than global non-revocation.</div>
          </div>
        </div>

        {/* Architecture D */}
        <div className="glass-card" style={{ padding: "1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="badge badge-d">Architecture D</span>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Smart Contract</span>
          </div>
          <h3 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Blockchain Registry</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Permissionless smart contract registry. Verifies institutional signatures on-chain, prevents duplicate batches, and records finalized commitments.
          </p>
          <div style={{ background: "rgba(8, 11, 18, 0.6)", padding: "1rem", borderRadius: "var(--radius-sm)", fontSize: "0.8rem" }}>
            <div style={{ color: "#fbbf24", fontWeight: 600, marginBottom: "0.35rem" }}>Strengths:</div>
            <div style={{ color: "var(--text-secondary)", marginBottom: "0.75rem" }}>Contract-enforced canonical state, permissionless submission, explicit conflict detection.</div>
            <div style={{ color: "#f43f5e", fontWeight: 600, marginBottom: "0.35rem" }}>Trade-off:</div>
            <div style={{ color: "var(--text-secondary)" }}>Gas fees (~68k gas/batch), blockchain confirmation latency, transaction-path dependency.</div>
          </div>
        </div>
      </div>
    </div>
  );
};
