import hre from "hardhat";

async function main() {
  console.log("Connecting to Hardhat EVM...");
  const [deployer, issuer, publisher] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Issuer:", issuer.address);
  console.log("Publisher:", publisher.address);

  const Factory = await hre.ethers.getContractFactory("AcademicCertificateRegistry");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("Contract deployed at:", address);

  // Register issuer
  const txReg = await contract.registerIssuer("did:edu:mit", issuer.address);
  const rcReg = await txReg.wait();
  if (!rcReg) throw new Error("Transaction receipt was null");
  console.log("Issuer registered in block:", rcReg.blockNumber, "Gas:", rcReg.gasUsed.toString());

  console.log("Real EVM execution is 100% operational!");
}

main().catch(console.error);
