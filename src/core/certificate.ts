import { getBytes, hexlify, randomBytes } from "ethers";
import { hashCertificateLeaf } from "./canonical.js";
import { AcademicCertificate, CertificateCommitment } from "./types.js";

const SAMPLE_MAJORS = [
  "Computer Science",
  "Electrical Engineering",
  "Mechanical Engineering",
  "Data Science & AI",
  "Biomedical Engineering",
  "Mathematics & Statistics",
  "Physics",
  "Civil Engineering",
  "Information Systems",
  "Robotics & Automation",
];

const SAMPLE_DEGREES = [
  "Bachelor of Science",
  "Master of Science",
  "Bachelor of Technology",
  "Doctor of Philosophy",
];

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Casey", "Riley", "Avery", "Jamie", "Quinn", "Priya", "Rahul", "Chen", "Wei", "Fatima", "Tariq", "Elena", "Mateo", "Sophie", "Lucas"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Patel", "Sharma", "Zhang", "Liu", "Khan", "Ali", "Ivanov", "Silva", "Dubois", "Schmidt"];

/**
 * Generates high-entropy cryptographic salt (32 bytes hex)
 */
export function generateSalt(): string {
  return hexlify(randomBytes(32));
}

/**
 * Generates a synthetic academic certificate record
 */
export function generateSyntheticCertificate(params: {
  issuerId: string;
  index: number;
  issuedAt?: number;
}): AcademicCertificate {
  const firstName = FIRST_NAMES[params.index % FIRST_NAMES.length];
  const lastName = LAST_NAMES[Math.floor(params.index / FIRST_NAMES.length) % LAST_NAMES.length];
  const major = SAMPLE_MAJORS[params.index % SAMPLE_MAJORS.length];
  const degree = SAMPLE_DEGREES[params.index % SAMPLE_DEGREES.length];
  const gpa = (3.0 + (params.index % 100) / 100).toFixed(2);
  const graduationYear = 2024 - (params.index % 5);

  return {
    certificateId: `cert-${params.issuerId}-${params.index.toString().padStart(6, "0")}`,
    studentId: `STU-${(100000 + params.index).toString()}`,
    studentName: `${firstName} ${lastName}`,
    degree,
    major,
    graduationDate: `${graduationYear}-05-15`,
    gpa,
    issuerId: params.issuerId,
    issuedAt: params.issuedAt || Math.floor(Date.now() / 1000),
    salt: generateSalt(),
  };
}

/**
 * Generates N synthetic certificates for a given issuer
 */
export function generateWorkloadCertificates(
  count: number,
  issuerId: string,
  issuedAt?: number
): AcademicCertificate[] {
  const certs: AcademicCertificate[] = [];
  const baseTime = issuedAt || Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    certs.push(generateSyntheticCertificate({ issuerId, index: i, issuedAt: baseTime }));
  }
  return certs;
}

/**
 * Converts a certificate to a privacy-preserving leaf commitment
 */
export function createCertificateCommitment(cert: AcademicCertificate): CertificateCommitment {
  const leafHash = hashCertificateLeaf(cert);
  return {
    certificateId: cert.certificateId,
    leafHash,
    salt: cert.salt,
  };
}

/**
 * Partitions a list of certificates into batches of size K
 */
export function partitionIntoBatches<T>(items: T[], batchSize: K): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
type K = number;
