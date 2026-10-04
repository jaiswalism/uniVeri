import { hashInternalNode } from "./canonical.js";
import { MerkleInclusionProof, MerkleProofStep } from "./types.js";

/**
 * Merkle Tree Implementation with Domain Separation
 */
export class MerkleTree {
  private leaves: string[];
  private layers: string[][];

  constructor(leafHashes: string[]) {
    if (leafHashes.length === 0) {
      throw new Error("Cannot construct Merkle tree with zero leaves");
    }
    this.leaves = [...leafHashes];
    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree(): void {
    let currentLayer = this.leaves;
    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        if (i + 1 < currentLayer.length) {
          const right = currentLayer[i + 1];
          nextLayer.push(hashInternalNode(left, right));
        } else {
          // If odd number of nodes, promote single node to next level
          // (RFC 6962 / standard approach for balanced subtrees)
          nextLayer.push(left);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  /**
   * Returns the Merkle Root
   */
  public getRoot(): string {
    return this.layers[this.layers.length - 1][0];
  }

  /**
   * Returns total number of leaves
   */
  public getLeafCount(): number {
    return this.leaves.length;
  }

  /**
   * Generates Merkle Inclusion Proof for leaf at given index
   */
  public getProof(leafIndex: number): MerkleInclusionProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of bounds (0..${this.leaves.length - 1})`);
    }

    const proof: MerkleProofStep[] = [];
    let currentIndex = leafIndex;

    for (let layerIndex = 0; layerIndex < this.layers.length - 1; layerIndex++) {
      const currentLayer = this.layers[layerIndex];
      const isRightChild = currentIndex % 2 === 1;
      const siblingIndex = isRightChild ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < currentLayer.length) {
        proof.push({
          position: isRightChild ? "left" : "right",
          data: currentLayer[siblingIndex],
        });
      }
      // Integer division for parent index
      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leafHash: this.leaves[leafIndex],
      leafIndex,
      merkleRoot: this.getRoot(),
      totalLeaves: this.leaves.length,
      proof,
    };
  }

  /**
   * Verifies a Merkle Inclusion Proof
   */
  public static verifyProof(proof: MerkleInclusionProof): boolean {
    let currentHash = proof.leafHash;

    for (const step of proof.proof) {
      if (step.position === "left") {
        currentHash = hashInternalNode(step.data, currentHash);
      } else {
        currentHash = hashInternalNode(currentHash, step.data);
      }
    }

    return currentHash.toLowerCase() === proof.merkleRoot.toLowerCase();
  }
}
