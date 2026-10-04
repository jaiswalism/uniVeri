import React, { useState } from "react";
import { Wallet } from "ethers";
import { PlusCircle, RefreshCw, Key, ShieldCheck, Download, FileText, Check, ChevronRight } from "lucide-react";
import { generateSyntheticCertificate, createCertificateCommitment } from "../../core/certificate";
import { MerkleTree } from "../../core/merkle";
import { createBatchManifest, signBatchManifest } from "../../core/manifest";
import { AcademicCertificate, BatchManifest, SignedBatchManifest } from "../../core/types";

export interface BatchingStudioProps {
  onBatchCreated?: (batchData: {
    certificates: AcademicCertificate[];
    signedManifest: SignedBatchManifest;
    merkleTree: MerkleTree;
  }) => void;
}

export const BatchingStudio: React.FC<BatchingStudioProps> = ({ onBatchCreated }) => {
  const [issuerId, setIssuerId] = useState("did:edu:mit");
  const [certCount, setCertCount] = useState(8);
  const [institutionWallet] = useState(() => Wallet.createRandom());
  const [generatedCerts, setGeneratedCerts] = useState<AcademicCertificate[]>([]);
  const [merkleTree, setMerkleTree] = useState<MerkleTree | null>(null);
  const [signedManifest, setSignedManifest] = useState<SignedBatchManifest | null>(null);
  const [selectedCertIndex, setSelectedCertIndex] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerateBatch = async () => {
    setIsGenerating(true);
    try {
      // 1. Generate certificates
      const certs: AcademicCertificate[] = [];
      for (let i = 0; i < certCount; i++) {
        certs.push(generateSyntheticCertificate({ issuerId, index: i + 1 }));
      }
      setGeneratedCerts(certs);

      // 2. Derive leaf hashes
      const leafHashes = certs.map((c) => createCertificateCommitment(c).leafHash);

      // 3. Construct Merkle tree
      const tree = new MerkleTree(leafHashes);
      setMerkleTree(tree);

      // 4. Create and sign batch manifest
      const manifest = createBatchManifest({
        issuerId,
        issuerAddress: institutionWallet.address,
        issuerKeyVersion: 1,
        institutionBatchNumber: 1,
        merkleRoot: tree.getRoot(),
        credentialCount: certs.length,
      });

      const signed = await signBatchManifest(manifest, institutionWallet);
      setSignedManifest(signed);
      setSelectedCertIndex(0);

      if (onBatchCreated) {
        onBatchCreated({
          certificates: certs,
          signedManifest: signed,
          merkleTree: tree,
        });
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
      {/* Configuration Header Card */}
      <div className="glass-card" style={{ padding: "1.75rem" }}>
        <h3 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <FileText size={20} color="#6366f1" /> Certificate Issuance & Merkle Tree Batching Studio
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", alignItems: "end" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              Issuer DID / Identifier
            </label>
            <input
              type="text"
              value={issuerId}
              onChange={(e) => setIssuerId(e.target.value)}
              style={{ width: "100%", padding: "0.6rem 0.8rem", background: "rgba(10, 13, 20, 0.7)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", color: "#fff", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              Batch Size (K Certificates)
            </label>
            <select
              value={certCount}
              onChange={(e) => setCertCount(Number(e.target.value))}
              style={{ width: "100%", padding: "0.6rem 0.8rem", background: "rgba(10, 13, 20, 0.7)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", color: "#fff", fontSize: "0.85rem" }}
            >
              <option value={4}>4 Certificates (Small Test)</option>
              <option value={8}>8 Certificates (Standard Tree)</option>
              <option value={16}>16 Certificates (Medium Batch)</option>
              <option value={64}>64 Certificates (Large Batch)</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              Signing Key Address
            </label>
            <div style={{ padding: "0.6rem 0.8rem", background: "rgba(10, 13, 20, 0.7)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", color: "#a5b4fc", fontFamily: "var(--font-mono)", fontSize: "0.75rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {institutionWallet.address}
            </div>
          </div>

          <div>
            <button className="btn-primary" onClick={handleGenerateBatch} disabled={isGenerating} style={{ width: "100%" }}>
              <RefreshCw size={16} className={isGenerating ? "animate-spin" : ""} />
              Generate & Sign Batch
            </button>
          </div>
        </div>
      </div>

      {/* Merkle Tree & Batch Explorer */}
      {signedManifest && merkleTree && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
          {/* Left: Certificate Selector & Leaf Commitment Details */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Batch Certificates ({generatedCerts.length})</span>
              <span className="badge badge-success">Signed Manifest Ready</span>
            </h4>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "280px", overflowY: "auto", marginBottom: "1.25rem", paddingRight: "0.5rem" }}>
              {generatedCerts.map((cert, idx) => {
                const isSelected = selectedCertIndex === idx;
                return (
                  <div
                    key={cert.certificateId}
                    onClick={() => setSelectedCertIndex(idx)}
                    style={{
                      padding: "0.75rem",
                      borderRadius: "var(--radius-sm)",
                      background: isSelected ? "rgba(99, 102, 241, 0.2)" : "rgba(16, 21, 34, 0.6)",
                      border: isSelected ? "1px solid #6366f1" : "1px solid var(--border-color)",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      transition: "all 0.2s",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{cert.studentName}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        {cert.degree} in {cert.major} (GPA: {cert.gpa})
                      </div>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: isSelected ? "#a5b4fc" : "var(--text-muted)" }}>
                      Leaf #{idx}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Selected Certificate Raw Data */}
            {generatedCerts[selectedCertIndex] && (
              <div style={{ background: "rgba(8, 11, 18, 0.8)", padding: "1rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
                <div style={{ fontSize: "0.75rem", color: "#38bdf8", fontWeight: 600, marginBottom: "0.5rem" }}>
                  Selected Leaf #{selectedCertIndex} Commitment Details:
                </div>
                <div style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <div><strong>ID:</strong> {generatedCerts[selectedCertIndex].certificateId}</div>
                  <div><strong>Salt:</strong> <span style={{ color: "#f59e0b" }}>{generatedCerts[selectedCertIndex].salt}</span></div>
                  <div><strong>Leaf Hash:</strong> <span style={{ color: "#34d399" }}>{merkleTree.getProof(selectedCertIndex).leafHash}</span></div>
                </div>
              </div>
            )}
          </div>

          {/* Right: Signed Manifest & Merkle Proof Inspector */}
          <div className="glass-card" style={{ padding: "1.5rem" }}>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Signed Batch Manifest (Section 6.1)</span>
              <span className="badge badge-c2">ECDSA Verified</span>
            </h4>

            <div className="code-block" style={{ marginBottom: "1rem", maxHeight: "280px" }}>
              <pre>{JSON.stringify(signedManifest.manifest, null, 2)}</pre>
            </div>

            <div style={{ background: "rgba(8, 11, 18, 0.8)", padding: "1rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-color)" }}>
              <div style={{ fontSize: "0.75rem", color: "#c084fc", fontWeight: 600, marginBottom: "0.35rem" }}>
                Institution secp256k1 Signature:
              </div>
              <div style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "#a5b4fc", wordBreak: "break-all" }}>
                {signedManifest.institutionSignature}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
