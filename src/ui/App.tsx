import React, { useState } from "react";
import {
  GraduationCap,
  Layers,
  FilePlus,
  Send,
  ShieldCheck,
  BarChart3,
  ExternalLink,
  BookOpen,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { ArchitectureDiagram } from "./components/ArchitectureDiagram";
import { BatchingStudio } from "./components/BatchingStudio";
import { PublicationInspector } from "./components/PublicationInspector";
import { VerificationPortal } from "./components/VerificationPortal";
import { ExperimentDashboard } from "./components/ExperimentDashboard";
import { AcademicCertificate, MerkleInclusionProof, SignedBatchManifest, ArchitectureEvidence } from "../core/types";
import { MerkleTree } from "../core/merkle";
import { LogClusterManager } from "../services/transparency-log/log-manager";
import { generateSyntheticCertificate, createCertificateCommitment } from "../core/certificate";
import { createBatchManifest, signBatchManifest } from "../core/manifest";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";

export type NavTab = "overview" | "studio" | "publisher" | "verifier" | "benchmark";

function createInitialBatch(): {
  certificates: AcademicCertificate[];
  signedManifest: SignedBatchManifest;
  merkleTree: MerkleTree;
} {
  const institutionWallet = Wallet.createRandom();
  const certs: AcademicCertificate[] = [];
  for (let i = 1; i <= 4; i++) {
    certs.push(generateSyntheticCertificate({ issuerId: "did:edu:mit", index: i }));
  }
  const leafHashes = certs.map((c) => createCertificateCommitment(c).leafHash);
  const tree = new MerkleTree(leafHashes);
  const manifest = createBatchManifest({
    issuerId: "did:edu:mit",
    issuerAddress: institutionWallet.address,
    issuerKeyVersion: 1,
    institutionBatchNumber: 1,
    merkleRoot: tree.getRoot(),
    credentialCount: certs.length,
  });

  const manifestHash = keccak256(toUtf8Bytes(JSON.stringify(manifest)));
  const sig = institutionWallet.signingKey.sign(manifestHash).serialized;
  const signedManifest: SignedBatchManifest = {
    manifest,
    institutionSignature: sig,
  };

  return {
    certificates: certs,
    signedManifest,
    merkleTree: tree,
  };
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>("overview");
  const [sharedLogManager] = useState(() => new LogClusterManager());

  // Shared state across tabs initialized with ready-to-use canonical sample
  const [batchData, setBatchData] = useState(() => createInitialBatch());
  const [activeEvidenceMap, setActiveEvidenceMap] = useState<{
    C1?: ArchitectureEvidence;
    C2?: ArchitectureEvidence;
    D?: ArchitectureEvidence;
  }>({});

  const handleBatchCreated = (newBatch: {
    certificates: AcademicCertificate[];
    signedManifest: SignedBatchManifest;
    merkleTree: MerkleTree;
  }) => {
    setBatchData(newBatch);
    setActiveEvidenceMap({}); // Reset evidence on new batch
    setActiveTab("publisher"); // Guide user to publication next
  };

  const handleEvidenceReady = (evidenceMap: {
    C1?: ArchitectureEvidence;
    C2?: ArchitectureEvidence;
    D?: ArchitectureEvidence;
  }) => {
    setActiveEvidenceMap(evidenceMap);
  };

  const handleResetSampleBatch = () => {
    const fresh = createInitialBatch();
    setBatchData(fresh);
    setActiveEvidenceMap({});
  };

  const hasEvidence = !!(activeEvidenceMap.C1 || activeEvidenceMap.C2 || activeEvidenceMap.D);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top Header Navbar */}
      <header className="header-nav">
        <div style={{ maxWidth: "1400px", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          {/* Logo & Title */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
            <div style={{ width: "42px", height: "42px", borderRadius: "var(--radius-md)", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 20px rgba(99, 102, 241, 0.4)" }}>
              <GraduationCap size={24} color="#fff" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: "1.1rem", letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span>UniVeri Research</span>
                <span className="badge badge-c2">Audited Prototype</span>
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                Academic Certificate Verification & Publication Architecture Study (C1, C2, D)
              </div>
            </div>
          </div>

          {/* Cross-Tab Status Indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "rgba(16, 21, 34, 0.8)", padding: "0.4rem 0.85rem", borderRadius: "var(--radius-md)", border: "1px solid var(--border-color)", fontSize: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#34d399" }} />
              <span>Batch: {batchData.certificates.length} certs</span>
            </div>
            <span style={{ color: "var(--border-color)" }}>|</span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: hasEvidence ? "#34d399" : "#94a3b8" }}>
              {hasEvidence ? <CheckCircle2 size={13} color="#34d399" /> : <AlertCircle size={13} color="#f59e0b" />}
              <span>Evidence: {hasEvidence ? "Published (C1/C2/D)" : "Awaiting Publish"}</span>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="nav-tabs">
            <button
              className={`nav-tab-btn ${activeTab === "overview" ? "active" : ""}`}
              onClick={() => setActiveTab("overview")}
            >
              <Layers size={16} /> Overview
            </button>
            <button
              className={`nav-tab-btn ${activeTab === "studio" ? "active" : ""}`}
              onClick={() => setActiveTab("studio")}
            >
              <FilePlus size={16} /> Batching Studio
            </button>
            <button
              className={`nav-tab-btn ${activeTab === "publisher" ? "active" : ""}`}
              onClick={() => setActiveTab("publisher")}
            >
              <Send size={16} /> Publisher
            </button>
            <button
              className={`nav-tab-btn ${activeTab === "verifier" ? "active" : ""}`}
              onClick={() => setActiveTab("verifier")}
            >
              <ShieldCheck size={16} /> Verifier
            </button>
            <button
              className={`nav-tab-btn ${activeTab === "benchmark" ? "active" : ""}`}
              onClick={() => setActiveTab("benchmark")}
            >
              <BarChart3 size={16} /> Benchmarks
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ maxWidth: "1400px", width: "100%", margin: "0 auto", padding: "2rem 1.5rem", flex: 1 }}>
        {activeTab === "overview" && <ArchitectureDiagram />}

        {activeTab === "studio" && (
          <BatchingStudio onBatchCreated={handleBatchCreated} />
        )}

        {activeTab === "publisher" && (
          <PublicationInspector
            logManager={sharedLogManager}
            signedManifest={batchData.signedManifest}
            onEvidenceReady={handleEvidenceReady}
            onNavigateToVerifier={() => setActiveTab("verifier")}
            onLoadSampleBatch={handleResetSampleBatch}
          />
        )}

        {activeTab === "verifier" && (
          <VerificationPortal
            logManager={sharedLogManager}
            certificate={batchData.certificates[0] || null}
            merkleProof={batchData.merkleTree ? batchData.merkleTree.getProof(0) : null}
            signedManifest={batchData.signedManifest}
            evidenceMap={activeEvidenceMap}
            onLoadSample={handleResetSampleBatch}
          />
        )}

        {activeTab === "benchmark" && <ExperimentDashboard />}
      </main>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border-color)", padding: "1.5rem 2rem", background: "rgba(10, 13, 20, 0.9)", textAlign: "center", fontSize: "0.8rem", color: "var(--text-muted)" }}>
        <div style={{ maxWidth: "1400px", margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            Academic Certificate Verification Research Prototype — Comparative Evaluation of C1, C2-A, and D
          </div>
          <div style={{ display: "flex", gap: "1rem" }}>
            <span>Schema v1.0.0</span>
            <span>•</span>
            <span>secp256k1 ECDSA</span>
            <span>•</span>
            <span>RFC 8785 Canonical JSON</span>
            <span>•</span>
            <span>224 Byte Receipt Logs</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
