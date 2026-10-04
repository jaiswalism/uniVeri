import hre from "hardhat";
import { generateWorkload } from "../src/benchmark/workload.js";
import { LogClusterManager } from "../src/services/transparency-log/log-manager.js";
import { IndependentPublisher } from "../src/publisher/independent-publisher.js";
import { CommonVerifier, buildVerifierPolicy } from "../src/verifier/common-verifier.js";
import { RegistryRetrievalAdapter } from "../src/services/registry-adapter.js";

async function testEVMIntegration() {
  console.log("[*] Initializing Hardhat EVM...");
  const [deployer, publisherSigner] = await hre.ethers.getSigners();

  const Factory = await hre.ethers.getContractFactory("AcademicCertificateRegistry");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  console.log("[+] AcademicCertificateRegistry deployed to EVM at:", contractAddress);

  const provider = hre.ethers.provider;
  const adapter = new RegistryRetrievalAdapter(contract as any, provider as any, 1);

  const logManager = new LogClusterManager();
  const publisher = new IndependentPublisher(logManager);
  publisher.setRegistry(contract.connect(publisherSigner) as any, adapter, provider as any);

  // Generate workload for 10 batches
  console.log("[*] Generating workload (N=100, K=10, B=10)...");
  const workload = await generateWorkload(100, 10, "did:edu:mit");

  const policy = buildVerifierPolicy({
    logManager,
    issuer: { issuerId: workload.issuerId, address: workload.issuerWallet.address, keyVersion: 1 },
    d: { chainId: 31337, contractAddress, confirmationDepth: 1 },
  });
  const verifier = new CommonVerifier(policy);
  publisher.setValidator(verifier);

  // Register issuer in contract
  console.log("[*] Registering issuer on EVM contract...");
  const regTx = await (contract.connect(deployer) as any).registerIssuer(workload.issuerId, workload.issuerWallet.address);
  await regTx.wait(1);
  console.log("[+] Issuer registered successfully on-chain!");

  console.log("[*] Publishing batches directly to EVM contract...");
  let totalGas = 0n;
  for (let i = 0; i < workload.batches.length; i++) {
    const b = workload.batches[i];
    const pubD = await publisher.publishToD(b.signedManifest);
    if (pubD.outcome !== "SUCCESS") {
      throw new Error(`Publish failed on batch ${i}: ${pubD.errorMessage}`);
    }
    totalGas += pubD.gasUsed || 0n;
    console.log(`    Batch ${i+1}/${workload.batches.length} registered! Gas used: ${pubD.gasUsed} | Mined Block: ${(pubD.evidence as any).registeredBlockNumber}`);
  }

  console.log(`\n[+] Successfully executed all ${workload.batches.length} batches on real EVM! Total gas: ${totalGas}`);

  // Test Verifier against real EVM state
  console.log("[*] Running Common Verifier on batch 0 with EVM evidence...");
  const firstBatch = workload.batches[0];
  const evidenceD = await adapter.readEvidence(firstBatch.manifest.batchContentId);
  const vReport = verifier.verifyCertificate({
    certificate: firstBatch.certificates[0],
    merkleProof: firstBatch.leafProofs[0],
    signedManifest: firstBatch.signedManifest,
    evidence: evidenceD,
    trustedIssuerAddress: workload.issuerWallet.address,
  });

  console.log("[+] Verification result:", vReport.authStatus, "|", vReport.publicationStatus, "|", vReport.revocationStatus);
}

testEVMIntegration().catch(console.error);
