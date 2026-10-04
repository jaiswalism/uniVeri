import { Wallet, HDNodeWallet } from "ethers";
import {
  AcademicCertificate,
  BatchManifest,
  MerkleInclusionProof,
  SignedBatchManifest,
} from "../core/types.js";
import {
  createCertificateCommitment,
  generateWorkloadCertificates,
  partitionIntoBatches,
} from "../core/certificate.js";
import { MerkleTree } from "../core/merkle.js";
import { createBatchManifest, signBatchManifest } from "../core/manifest.js";

export interface BatchBundle {
  manifest: BatchManifest;
  signedManifest: SignedBatchManifest;
  merkleTree: MerkleTree;
  certificates: AcademicCertificate[];
  leafProofs: MerkleInclusionProof[];
}

export interface WorkloadPackage {
  N: number; // Total certificates
  K: number; // Batch size
  B: number; // Batch count
  issuerId: string;
  issuerWallet: Wallet | HDNodeWallet;
  batches: BatchBundle[];
  totalGenerationTimeMs: number;
}

/**
 * Generates an end-to-end synthetic certificate workload partitioned into B batches
 */
export async function generateWorkload(
  N: number,
  K: number,
  issuerId: string = "did:edu:mit",
  customWallet?: Wallet | HDNodeWallet,
  existingCertificates?: AcademicCertificate[]
): Promise<WorkloadPackage> {
  const startTime = performance.now();
  const issuerWallet = customWallet || Wallet.createRandom();

  // 1. Generate N canonical certificates or reuse existing records for controlled comparisons
  const certificates = existingCertificates || generateWorkloadCertificates(N, issuerId);

  // 2. Partition into batches of size K
  const certBatches = partitionIntoBatches(certificates, K);
  const B = certBatches.length;

  const batches: BatchBundle[] = [];

  for (let bIndex = 0; bIndex < B; bIndex++) {
    const batchCerts = certBatches[bIndex];
    const commitments = batchCerts.map(createCertificateCommitment);
    const leafHashes = commitments.map((c) => c.leafHash);

    // Build Merkle Tree
    const merkleTree = new MerkleTree(leafHashes);
    const merkleRoot = merkleTree.getRoot();

    // Create & Sign Batch Manifest
    const manifest = createBatchManifest({
      issuerId,
      issuerAddress: issuerWallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: bIndex + 1,
      merkleRoot,
      credentialCount: batchCerts.length,
    });

    const signedManifest = await signBatchManifest(manifest, issuerWallet);

    // Generate sample proof for benchmark verification
    const sampleProof = merkleTree.getProof(0);

    batches.push({
      manifest,
      signedManifest,
      merkleTree,
      certificates: batchCerts,
      leafProofs: [sampleProof],
    });
  }

  const totalGenerationTimeMs = performance.now() - startTime;

  return {
    N,
    K,
    B,
    issuerId,
    issuerWallet,
    batches,
    totalGenerationTimeMs,
  };
}
