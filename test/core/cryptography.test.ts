import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  canonicalizeJson,
  deriveBatchContentId,
  deriveLogicalBatchId,
  hashCertificateLeaf,
} from "../../src/core/canonical.js";
import { MerkleTree } from "../../src/core/merkle.js";
import {
  generateSyntheticCertificate,
  createCertificateCommitment,
} from "../../src/core/certificate.js";
import { createBatchManifest, signBatchManifest, verifyBatchManifestSignature } from "../../src/core/manifest.js";

describe("Milestone 1: Cryptographic Core & Data Models", () => {
  it("RFC 8785 Canonical JSON: key ordering and nested structures", () => {
    const objA = { z: 1, a: "hello", m: { b: 2, a: 1 }, arr: [{ d: 4, c: 3 }, 5] };
    const objB = { arr: [{ c: 3, d: 4 }, 5], a: "hello", m: { a: 1, b: 2 }, z: 1 };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(canonicalizeJson(objA)).toBe('{"a":"hello","arr":[{"c":3,"d":4},5],"m":{"a":1,"b":2},"z":1}');
  });

  it("RFC 8785 Canonical JSON: number formatting, integer/decimal, exponents, and negative zero", () => {
    // Integer and decimal values
    expect(canonicalizeJson({ int: 42, dec: 3.14159 })).toBe('{"dec":3.14159,"int":42}');
    
    // Negative zero (-0) MUST serialize as 0 per RFC 8785 Section 3.2.2.3
    expect(canonicalizeJson({ negZero: -0, posZero: 0 })).toBe('{"negZero":0,"posZero":0}');

    // Exponent notation according to ES6 Section 7.1.12.1
    expect(canonicalizeJson({ large: 1e21, small: 1e-7 })).toBe('{"large":1e+21,"small":1e-7}');
  });

  it("RFC 8785 Canonical JSON: Unicode handling, escapes, and UTF-16 code unit ordering", () => {
    const obj = {
      "\u20ac": "euro",
      "emoji": "🎓 Academic Certificate",
      "controls": "line1\nline2\ttab\"quoted\"",
      "b": 1,
      "a": 2,
      "aa": 3,
    };
    // Expected UTF-16 ordering: "a", "aa", "b", "controls", "emoji", "\u20ac"
    const expected = '{"a":2,"aa":3,"b":1,"controls":"line1\\nline2\\ttab\\"quoted\\"","emoji":"🎓 Academic Certificate","€":"euro"}';
    expect(canonicalizeJson(obj)).toBe(expected);
  });

  it("RFC 8785 Canonical JSON: Non-finite numbers (NaN, Infinity) are strictly prohibited and throw TypeError", () => {
    expect(() => canonicalizeJson({ val: NaN })).toThrow(TypeError);
    expect(() => canonicalizeJson({ val: Infinity })).toThrow(TypeError);
    expect(() => canonicalizeJson({ val: -Infinity })).toThrow(TypeError);
    expect(() => canonicalizeJson([1, 2, NaN])).toThrow(TypeError);
  });

  it("Certificate leaf commitment preserves privacy and uses high-entropy salt", () => {
    const cert = generateSyntheticCertificate({ issuerId: "did:edu:mit", index: 1 });
    const commitment = createCertificateCommitment(cert);

    expect(commitment.leafHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(cert.salt).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(hashCertificateLeaf(cert)).toBe(commitment.leafHash);

    // Tampering with any field changes leaf hash
    const tampered = { ...cert, gpa: "4.00" };
    expect(hashCertificateLeaf(tampered)).not.toBe(commitment.leafHash);
  });

  it("Merkle Tree should construct root, generate proofs, and verify inclusion", () => {
    const certs = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      generateSyntheticCertificate({ issuerId: "did:edu:mit", index: i })
    );
    const leafHashes = certs.map((c) => createCertificateCommitment(c).leafHash);

    const tree = new MerkleTree(leafHashes);
    const root = tree.getRoot();

    expect(root).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify all leaf proofs
    for (let i = 0; i < leafHashes.length; i++) {
      const proof = tree.getProof(i);
      expect(MerkleTree.verifyProof(proof)).toBe(true);

      // Corrupted proof should fail
      const corruptedProof = {
        ...proof,
        proof: [{ position: "left" as const, data: "0x" + "00".repeat(32) }],
      };
      expect(MerkleTree.verifyProof(corruptedProof)).toBe(false);
    }
  });

  it("Section 7 Separation: logicalBatchID remains constant while batchContentID changes if Merkle root changes", () => {
    const issuerId = "did:edu:harvard";
    const institutionBatchNumber = 42;
    const schemaVersion = "1.0.0";
    const issuerAddress = "0x1111111111111111111111111111111111111111";

    const logicalBatchId = deriveLogicalBatchId({
      issuerId,
      institutionBatchNumber,
      schemaVersion,
    });

    const root1 = "0x" + "aa".repeat(32);
    const root2 = "0x" + "bb".repeat(32);

    const contentId1 = deriveBatchContentId({
      logicalBatchId,
      merkleRoot: root1,
      issuerAddress,
      issuerKeyVersion: 1,
      credentialCount: 100,
      issuedAt: 1700000000,
      schemaVersion,
    });

    const contentId2 = deriveBatchContentId({
      logicalBatchId,
      merkleRoot: root2,
      issuerAddress,
      issuerKeyVersion: 1,
      credentialCount: 100,
      issuedAt: 1700000000,
      schemaVersion,
    });

    // Content IDs must be different for different roots
    expect(contentId1).not.toBe(contentId2);
  });

  it("Batch Manifest signing and institutional ECDSA verification", async () => {
    const wallet = Wallet.createRandom();
    const manifest = createBatchManifest({
      issuerId: "did:edu:stanford",
      issuerAddress: wallet.address,
      issuerKeyVersion: 1,
      institutionBatchNumber: 1,
      merkleRoot: "0x" + "12".repeat(32),
      credentialCount: 50,
    });

    const signed = await signBatchManifest(manifest, wallet);
    const verifyResult = verifyBatchManifestSignature(signed);

    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.recoveredAddress.toLowerCase()).toBe(wallet.address.toLowerCase());

    // Tampered manifest should fail verification
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, credentialCount: 51 },
    };
    const tamperedResult = verifyBatchManifestSignature(tampered);
    expect(tamperedResult.valid).toBe(false);
  });
});
