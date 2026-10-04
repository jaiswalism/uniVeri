import { ethers, getBytes, keccak256, Signer, toUtf8Bytes, verifyMessage } from "ethers";
import { canonicalizeJson, deriveBatchContentId, deriveLogicalBatchId } from "./canonical.js";
import { BatchManifest, SchemaVersion, SignedBatchManifest, SignedRevocation } from "./types.js";

const CURRENT_SCHEMA_VERSION: SchemaVersion = "1.0.0";

/**
 * Constructs a canonical BatchManifest object
 */
export function createBatchManifest(params: {
  issuerId: string;
  issuerAddress: string;
  issuerKeyVersion: number;
  institutionBatchNumber: number;
  merkleRoot: string;
  credentialCount: number;
  issuedAt?: number;
}): BatchManifest {
  const issuedAt = params.issuedAt || Math.floor(Date.now() / 1000);

  const logicalBatchId = deriveLogicalBatchId({
    issuerId: params.issuerId,
    institutionBatchNumber: params.institutionBatchNumber,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });

  const batchContentId = deriveBatchContentId({
    logicalBatchId,
    merkleRoot: params.merkleRoot,
    issuerAddress: params.issuerAddress,
    issuerKeyVersion: params.issuerKeyVersion,
    credentialCount: params.credentialCount,
    issuedAt,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  });

  return {
    logicalBatchId,
    batchContentId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    issuerId: params.issuerId,
    issuerAddress: params.issuerAddress,
    issuerKeyVersion: params.issuerKeyVersion,
    institutionBatchNumber: params.institutionBatchNumber,
    merkleRoot: params.merkleRoot,
    credentialCount: params.credentialCount,
    issuedAt,
  };
}

/**
 * Computes deterministic ABI-encoded manifest hash matching Solidity contract
 */
export function computeSolidityManifestHash(manifest: BatchManifest): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["bytes32", "bytes32", "bytes32", "address", "uint16", "uint32", "uint64"],
    [
      manifest.logicalBatchId,
      manifest.batchContentId,
      manifest.merkleRoot,
      manifest.issuerAddress,
      manifest.issuerKeyVersion,
      manifest.credentialCount,
      manifest.issuedAt,
    ]
  );
  return keccak256(encoded);
}

/**
 * Generates the deterministic signing payload bytes for the manifest
 */
export function getManifestSigningPayload(manifest: BatchManifest): string {
  return computeSolidityManifestHash(manifest);
}

/**
 * Signs a BatchManifest using an institutional signer (ethers Wallet / Signer / HDNodeWallet)
 */
export async function signBatchManifest(
  manifest: BatchManifest,
  signer: Signer
): Promise<SignedBatchManifest> {
  const manifestHash = computeSolidityManifestHash(manifest);
  const signature = await signer.signMessage(getBytes(manifestHash));

  return {
    manifest,
    institutionSignature: signature,
  };
}

/**
 * Common signature format: 65-byte r||s||v hex string, v in {27, 28}.
 * The signed message is EIP-191 personal_sign over the 32 raw bytes of the manifest hash.
 */
export const SIGNATURE_FORMAT_REGEX = /^0x[0-9a-fA-F]{130}$/;

export function isWellFormedSignature(signature: string): boolean {
  if (typeof signature !== "string" || !SIGNATURE_FORMAT_REGEX.test(signature)) return false;
  const v = parseInt(signature.slice(130, 132), 16);
  return v === 27 || v === 28;
}

/**
 * Recomputes logicalBatchId and batchContentId from the manifest fields and reports mismatches.
 */
export function validateManifestIdentifiers(manifest: BatchManifest): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const logical = deriveLogicalBatchId({
    issuerId: manifest.issuerId,
    institutionBatchNumber: manifest.institutionBatchNumber,
    schemaVersion: manifest.schemaVersion,
  });
  if (logical.toLowerCase() !== String(manifest.logicalBatchId).toLowerCase()) {
    problems.push("logicalBatchId does not match recomputed value");
  }
  const content = deriveBatchContentId({
    logicalBatchId: manifest.logicalBatchId,
    merkleRoot: manifest.merkleRoot,
    issuerAddress: manifest.issuerAddress,
    issuerKeyVersion: manifest.issuerKeyVersion,
    credentialCount: manifest.credentialCount,
    issuedAt: manifest.issuedAt,
    schemaVersion: manifest.schemaVersion,
  });
  if (content.toLowerCase() !== String(manifest.batchContentId).toLowerCase()) {
    problems.push("batchContentId does not match recomputed value");
  }
  return { valid: problems.length === 0, problems };
}

/**
 * Verifies a SignedBatchManifest against the manifest's declared issuer address.
 * Single accepted format only (see SIGNATURE_FORMAT_REGEX); no alternative payloads are tried.
 */
export function verifyBatchManifestSignature(signedManifest: SignedBatchManifest): {
  valid: boolean;
  recoveredAddress: string;
  expectedAddress: string;
  formatValid: boolean;
} {
  const expectedAddress = signedManifest.manifest.issuerAddress;
  const formatValid = isWellFormedSignature(signedManifest.institutionSignature);
  if (!formatValid) {
    return { valid: false, recoveredAddress: "", expectedAddress, formatValid };
  }
  try {
    const manifestHash = computeSolidityManifestHash(signedManifest.manifest);
    const recoveredAddress = verifyMessage(getBytes(manifestHash), signedManifest.institutionSignature);
    return {
      valid: recoveredAddress.toLowerCase() === expectedAddress.toLowerCase(),
      recoveredAddress,
      expectedAddress,
      formatValid,
    };
  } catch {
    return { valid: false, recoveredAddress: "", expectedAddress, formatValid };
  }
}

/**
 * Transparency-log leaf for an issuance entry: keccak256(RFC 8785 canonical JSON of the SignedBatchManifest).
 * Used identically by the log engine (when appending) and by the verifier (binding the proof to the
 * exact supplied signed manifest).
 */
export function computeIssuanceEntryHash(signedManifest: SignedBatchManifest): string {
  return keccak256(toUtf8Bytes(canonicalizeJson(signedManifest)));
}

/**
 * Transparency-log leaf for a revocation entry. Domain-separated from issuance entries by an explicit "type" field.
 */
export function computeRevocationEntryHash(rev: SignedRevocation): string {
  return keccak256(toUtf8Bytes(canonicalizeJson({ type: "REVOCATION", ...rev })));
}

export function computeRevocationDigest(rev: Omit<SignedRevocation, "signature">): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return keccak256(
    abiCoder.encode(
      ["bytes32", "bytes32", "address", "uint64", "bytes32"],
      [rev.logicalBatchId, rev.batchContentId, rev.issuerAddress, rev.revokedAt, keccak256(toUtf8Bytes(rev.reason))]
    )
  );
}

export async function signRevocation(
  params: Omit<SignedRevocation, "signature">,
  signer: Signer
): Promise<SignedRevocation> {
  const digest = computeRevocationDigest(params);
  const signature = await signer.signMessage(getBytes(digest));
  return { ...params, signature };
}

export function verifyRevocationSignature(rev: SignedRevocation, expectedIssuer: string): boolean {
  if (!isWellFormedSignature(rev.signature)) return false;
  try {
    const { signature, ...rest } = rev;
    const recovered = verifyMessage(getBytes(computeRevocationDigest(rest)), signature);
    return (
      recovered.toLowerCase() === expectedIssuer.toLowerCase() &&
      rev.issuerAddress.toLowerCase() === expectedIssuer.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Computes canonical payload for a log's authenticated status observation,
 * binding logId, batchContentId, checkpoint details, and revocation entry hashes.
 */
export function computeStatusObservationPayload(params: {
  logId: string;
  batchContentId: string;
  checkpointRoot: string;
  treeSize: number;
  revocationEntryHashes: string[];
  observedAt?: number;
}): string {
  return canonicalizeJson({
    logId: params.logId,
    batchContentId: params.batchContentId,
    checkpointRoot: params.checkpointRoot,
    treeSize: params.treeSize,
    revocationEntryHashes: params.revocationEntryHashes,
    ...(params.observedAt !== undefined ? { observedAt: params.observedAt } : {}),
  });
}

/**
 * Verifies that a status observation was signed by the pinned log operator.
 */
export function verifyStatusObservationSignature(
  params: {
    logId: string;
    batchContentId: string;
    checkpointRoot: string;
    treeSize: number;
    revocationEntryHashes: string[];
    observedAt?: number;
    signature: string;
  },
  expectedOperatorAddress: string
): boolean {
  if (!isWellFormedSignature(params.signature)) return false;
  try {
    const payload = computeStatusObservationPayload(params);
    const recovered = verifyMessage(payload, params.signature);
    return recovered.toLowerCase() === expectedOperatorAddress.toLowerCase();
  } catch {
    return false;
  }
}

