import { Wallet, ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// Deterministic private keys for the 4 QBFT validator nodes
export const VALIDATOR_KEYS = [
  "8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c694be66",
  "c87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3",
  "ae6cb872f5856e61571cc73c0ce418ea8a83b479cb087d3b730498ac9f579b9c",
  "278a523fa558830e77d52b99b78164b0ab38fb32f5d88b189790c1f1048bde00",
];

// Pre-funded test accounts (e.g. Hardhat default account #0 and issuer account)
export const FUNDED_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // Publisher / Deployer
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Institutional Issuer
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Secondary / Verifier
];

export function generateBesuConfig() {
  const baseDir = path.resolve("./docker/besu");
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const validators: { index: number; key: string; address: string; nodeDir: string }[] = [];

  for (let i = 0; i < VALIDATOR_KEYS.length; i++) {
    const rawKey = VALIDATOR_KEYS[i];
    const wallet = new Wallet("0x" + rawKey);
    const nodeDir = path.join(baseDir, `validator${i + 1}`);
    const dataDir = path.join(nodeDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    // Save private key for Besu node
    fs.writeFileSync(path.join(dataDir, "key"), rawKey, "utf-8");

    validators.push({
      index: i + 1,
      key: rawKey,
      address: wallet.address.toLowerCase(),
      nodeDir,
    });
  }

  // Build ExtraData for Besu QBFT
  // In QBFT, extraData is an RLP list: [ vanity (32 bytes), [validators], [], round (empty/0x), [] ]
  const vanity = "0x" + "00".repeat(32);
  const validatorAddresses = validators.map((v) => v.address);
  const extraData = ethers.encodeRlp([
    vanity,
    validatorAddresses,
    [],
    "0x",
    [],
  ]);

  const alloc: Record<string, { balance: string }> = {};
  for (const acc of FUNDED_ACCOUNTS) {
    alloc[acc.toLowerCase()] = {
      balance: "0x10000000000000000000000000000000", // 100,000,000 ETH
    };
  }
  for (const v of validators) {
    alloc[v.address] = {
      balance: "0x10000000000000000000000000000000",
    };
  }

  const genesis = {
    config: {
      chainId: 1337,
      homesteadBlock: 0,
      eip150Block: 0,
      eip155Block: 0,
      eip158Block: 0,
      byzantiumBlock: 0,
      constantinopleBlock: 0,
      petersburgBlock: 0,
      istanbulBlock: 0,
      berlinBlock: 0,
      londonBlock: 0,
      qbft: {
        blockperiodseconds: 1,
        epochlength: 30000,
        requesttimeoutseconds: 4,
        validators: validatorAddresses,
      },
    },
    nonce: "0x0",
    timestamp: "0x58ee40ba",
    extraData: extraData,
    gasLimit: "0x1fffffffffffff",
    difficulty: "0x1",
    mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    alloc: alloc,
  };

  const genesisPath = path.join(baseDir, "genesis.json");
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2), "utf-8");

  console.log(`[Besu QBFT Config] Genesis generated at: ${genesisPath}`);
  console.log(`[Besu QBFT Config] Validators:`);
  validators.forEach((v) => console.log(`  Validator ${v.index}: ${v.address}`));

  return { genesisPath, validators };
}

if (process.argv[1]?.includes("setup-besu-cluster")) {
  generateBesuConfig();
}

