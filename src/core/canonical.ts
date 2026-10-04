import { getBytes, keccak256, toUtf8Bytes } from "ethers";

/**
 * RFC 8785 (JSON Canonicalization Scheme / JCS) specification implementation.
 * 
 * Implemented Subset & Conformance Rules:
 *  1. UTF-16 code unit lexicographical key ordering for all object properties.
 *  2. IEEE 754 number formatting adhering to ECMAScript Section 7.1.12.1.
 *  3. Negative zero (-0) is normalized and serialized as 0.
 *  4. Non-finite numbers (NaN, Infinity, -Infinity) are strictly prohibited per RFC 8785 / I-JSON and throw TypeError.
 *  5. Whitespace is strictly eliminated outside string literals.
 *  6. Strings are UTF-8 encoded with standard JSON character escaping.
 */
export function canonicalizeJson(obj: any): string {
  if (obj === undefined) {
    return "";
  }
  if (obj === null) {
    return "null";
  }
  if (typeof obj === "boolean") {
    return obj ? "true" : "false";
  }
  if (typeof obj === "number") {
    if (Number.isNaN(obj) || !Number.isFinite(obj)) {
      throw new TypeError("RFC 8785: Non-finite numbers (NaN, Infinity) are prohibited in canonical JSON");
    }
    // Negative zero (-0) normalization per RFC 8785 Section 3.2.2.3
    if (Object.is(obj, -0)) {
      return "0";
    }
    return JSON.stringify(obj);
  }
  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "bigint") {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => (item === undefined ? "null" : canonicalizeJson(item))).join(",") + "]";
  }
  if (typeof obj === "object") {
    // Sort object keys by UTF-16 code units (code point lexicographical order)
    const sortedKeys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pairs: string[] = [];
    for (const key of sortedKeys) {
      const val = obj[key];
      if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
        pairs.push(JSON.stringify(key) + ":" + canonicalizeJson(val));
      }
    }
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(obj);
}

/**
 * Domain separation tags to prevent cross-protocol and second-preimage collision attacks
 */
export const DOMAIN_PREFIX = {
  LEAF: "0x00",
  INTERNAL_NODE: "0x01",
  LOG_ENTRY: "0x02",
  CHECKPOINT: "0x03",
} as const;

/**
 * Computes deterministic Keccak256 hash over canonical JSON string
 */
export function hashCanonical(data: any): string {
  const canonicalString = canonicalizeJson(data);
  return keccak256(toUtf8Bytes(canonicalString));
}

/**
 * Computes the leaf hash for a certificate (with domain separation byte 0x00)
 */
export function hashCertificateLeaf(certRecord: any): string {
  const certCanonical = canonicalizeJson(certRecord);
  const certBytes = toUtf8Bytes(certCanonical);
  const leafPrefix = new Uint8Array([0x00]);
  const combined = new Uint8Array(leafPrefix.length + certBytes.length);
  combined.set(leafPrefix, 0);
  combined.set(certBytes, leafPrefix.length);
  return keccak256(combined);
}

/**
 * Merkle internal node hash (with domain separation byte 0x01)
 */
export function hashInternalNode(leftHex: string, rightHex: string): string {
  const leftBytes = getBytes(leftHex);
  const rightBytes = getBytes(rightHex);
  const prefix = new Uint8Array([0x01]);
  const combined = new Uint8Array(prefix.length + leftBytes.length + rightBytes.length);
  combined.set(prefix, 0);
  combined.set(leftBytes, prefix.length);
  combined.set(rightBytes, prefix.length + leftBytes.length);
  return keccak256(combined);
}

/**
 * Section 7 of Research Plan:
 * logicalBatchID = H(issuerID || institutionBatchNumber || schemaVersion)
 */
export function deriveLogicalBatchId(params: {
  issuerId: string;
  institutionBatchNumber: number;
  schemaVersion: string;
}): string {
  return hashCanonical({
    issuerId: params.issuerId,
    institutionBatchNumber: params.institutionBatchNumber,
    schemaVersion: params.schemaVersion,
  });
}

/**
 * Section 7 of Research Plan:
 * batchContentID = H(logicalBatchID || merkleRoot || canonicalMetadata)
 */
export function deriveBatchContentId(params: {
  logicalBatchId: string;
  merkleRoot: string;
  issuerAddress: string;
  issuerKeyVersion: number;
  credentialCount: number;
  issuedAt: number;
  schemaVersion: string;
}): string {
  return hashCanonical({
    logicalBatchId: params.logicalBatchId,
    merkleRoot: params.merkleRoot,
    issuerAddress: params.issuerAddress.toLowerCase(),
    issuerKeyVersion: params.issuerKeyVersion,
    credentialCount: params.credentialCount,
    issuedAt: params.issuedAt,
    schemaVersion: params.schemaVersion,
  });
}
