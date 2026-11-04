# uniVeri: Academic Certificate Verification & Comparative Publication Architecture

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636.svg)](https://soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22-yellow.svg)](https://hardhat.org/)
[![Hyperledger Besu](https://img.shields.io/badge/Hyperledger%20Besu-QBFT-green.svg)](https://www.hyperledger.org/projects/besu)
[![Docker](https://img.shields.io/badge/Docker%20Compose-Testbed-2496ED.svg)](https://www.docker.com/)

**uniVeri** is a high-integrity academic certificate verification and publication benchmarking testbed. It provides a standardized cryptographic pipeline and comparative empirical benchmarks across three distinct publication architectures:

1. **C1 (Single Transparency Log):** Append-only transparency log with Signed Tree Heads (STH) and RFC 6962-style cryptographic Merkle audit inclusion proofs (served via standalone HTTP REST daemons).
2. **C2 (3-Log Multi-Quorum):** Distributed log cluster requiring at least a 2-of-3 independent quorum of valid inclusion proofs across isolated services (`Log Alpha`, `Log Beta`, `Log Gamma`).
3. **D (Hyperledger Besu QBFT Blockchain Registry):** Permissionless, on-chain smart contract registry on a 4-node enterprise QBFT private EVM network with on-chain institutional ECDSA signature verification (`ecrecover`), storage-slot mapping, and event-based auditability.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Issuer ["1. Academic Institution (Issuer)"]
        Cert["Academic Certificate (JSON)"] --> Salt["High-Entropy Salt"]
        Salt --> Comm["Privacy Commitment: SHA256(Canonical(Cert) || Salt)"]
        Comm --> Leaves["Batch of Leaves (K Certificates)"]
        Leaves --> MT["Binary Merkle Tree"]
        MT --> Root["Merkle Root (Content ID)"]
        Root --> Sign["ECDSA Secp256k1 Signature (Manifest)"]
    end

    subgraph Pub ["2. Common Independent Publisher"]
        Sign --> Adapter{"Publication Adapter"}
    end

    subgraph C1 ["Architecture C1: Single Log"]
        Adapter -->|Submit Batch| LogPrimary["Transparency Log Daemon (Port 9001)"]
        LogPrimary --> STH1["Signed Tree Head (STH) + Merkle Audit Path"]
    end

    subgraph C2 ["Architecture C2: 3-Log Quorum"]
        Adapter -->|Submit Batch| Cluster["Log Alpha (9002) / Beta (9003) / Gamma (9004)"]
        Cluster --> Quorum["2-of-3 Quorum Verification Proofs"]
    end

    subgraph D ["Architecture D: 4-Node Besu QBFT Cluster"]
        Adapter -->|EVM Tx (Port 8545)| BesuCluster["Hyperledger Besu 4-Node QBFT"]
        BesuCluster --> SmartContract["AcademicCertificateRegistry.sol"]
        SmartContract --> EVMState["State Slots: ecrecover + Finality"]
    end

    subgraph Verifier ["3. Common Verifier Engine"]
        STH1 --> VEngine["Evidence Retriever & Evaluator"]
        Quorum --> VEngine
        EVMState --> VEngine
        VEngine --> Verdict["Decision Matrix: AUTHENTIC / NOT_AUTHENTIC / REVOKED / SAFE UNCERTAINTY"]
    end
```

---

## Key Features

### 1. Common Cryptographic Core & Privacy Protection
- **RFC 8785 Canonical JSON Serialization:** Deterministic byte-exact hashing regardless of JSON key order.
- **Privacy-Preserving Commitments:** Raw student personal identifiable information (PII) never leaves the institution. Only `SHA256(Canonical(Cert) || Salt)` leaves enter the public Merkle tree.
- **Binary Merkle Tree:** Deterministic sorted leaf pairing, leaf hashing (`0x00` prefix), and node hashing (`0x01` prefix) with verifiable inclusion proofs.
- **Institutional ECDSA Signatures:** secp256k1 institutional signatures verified on-chain via `ecrecover` and off-chain via ethers.js.

### 2. Multi-Container Testbed Environment
- **Architecture D (4-Node Hyperledger Besu QBFT Cluster):**
  - 4 validator nodes (`besu-node-1` to `besu-node-4`) with deterministic QBFT genesis configuration:
    - 1-second block period (`blockperiodseconds: 1`)
    - 30,000 block epoch length (`epochlength: 30000`)
    - 4-second request timeout (`requesttimeoutseconds: 4`)
  - Enforced per-container resource boundaries: `cpus: "2.0"`, `mem_limit: 4g`.
- **Architectures C1 and C2 (Standalone REST Log Daemons):**
  - Standalone Node.js/Express service containers (`services/log-daemon/`):
    - `log-c1-primary` on Port `9001`
    - `log-c2-alpha` on Port `9002`, `log-c2-beta` on Port `9003`, `log-c2-gamma` on Port `9004` (2-of-3 quorum).
  - Genuine REST endpoints: `/v1/manifests`, `/v1/proofs/:batchContentId`, `/v1/checkpoint`, and `/v1/admin/fault`.
- **Network Link Delay Emulation (`tc netem`):**
  - Kernel-level packet delay enforcement via [`scripts/setup-netem.sh`](scripts/setup-netem.sh) applying configurable link delays $\Delta \in \{20\text{ ms}, 50\text{ ms}\}$.

### 3. Evaluated Publication Architectures
| Property | C1: Single Transparency Log | C2: 3-Log 2-of-3 Quorum | D: Hyperledger Besu QBFT Registry |
|---|---|---|---|
| **Publication Method** | HTTP REST Log Service (`:9001`) | Multi-Log Cluster Orchestration (`:9002–9004`) | Live QBFT Transaction (`:8545`, `registerBatch`) |
| **Consensus / Trust** | Single Log Operator | Decentralized Quorum (2-of-3) | QBFT Byzantine Fault Tolerant Consensus |
| **Evidence Artifact** | Signed Tree Head (STH) + Audit Path | Distinct Multi-Log Inclusions | Block Finality + Transaction Receipt |
| **Fault Tolerance** | Zero tolerance to log downtime | Resilient to single log outage/omission | Resilient to 1 Byzantine/failed validator ($F < N/3$) |
| **Cost Profile** | Zero on-chain fees | Zero on-chain fees | ~183k to 328k Gas per batch |
| **Verification Speed** | Fast (~55 ms median) | Fast (~70 ms median) | Ultra-fast local/RPC query (~21 ms) |

### 4. Executable Fault Injection Suite
The testbed includes executable fault injectors in [`scripts/faults/`](scripts/faults/):
- **D-F2b (`fault-d-f2b-stop-proposer.ts`):** Dynamically computes the active QBFT round leader/proposer:
  $$\text{ProposerIndex} = (\text{blockNumber} + \text{round}) \pmod N$$
  and executes `docker pause` / `docker stop` on that specific validator container to induce consensus round changes.
- **D-F5 (`fault-d-f5-rpc-proxy.ts`):** High-performance intercepting proxy on port 8547 that drops connections or returns HTTP 503 errors to test client resilience without killing nodes.
- **C1 & C2 REST Fault Controllers (`fault-c1-omission.ts`, `fault-c2-quorum-failure.ts`):** Programmatic fault toggles for HTTP 503 outages, omission attacks, and stale checkpoint injection.

### 5. Formal Verification Vocabulary & Safe Uncertainty Semantics
The verification engine strictly adheres to standardized security semantics:
- **`AUTHENTIC`**: Cryptographic integrity valid, issuer signature verified, evidence proven in target publication architecture, and active status confirmed.
- **`NOT_AUTHENTIC`**: Signature invalid, Merkle proof mismatch, or corrupted commitment.
- **`REVOKED_AS_OF_EVIDENCE`**: Explicit on-chain revocation or revocation log entry verified.
- **`SAFE UNCERTAINTY` (`STATUS_UNKNOWN`)**: Correctly distinguishes complete proof of validity vs. degraded network states (e.g., when a log is omitted in C2, producing safe partial evidence rather than false assertions).

---

## Experimental Benchmark Engine & Results

The repository includes a comprehensive benchmark suite evaluated across a 240-run matrix:
- **Workload Sizes:** Workloads W1–W6 scaling $N \in \{1,000, 10,000, 50,000\}$ certificates and $K \in \{100, 1,000, 10,000\}$ batch sizes.
- **Failure Interventions:** 6 fault injection scenarios (C1 Log Outage, C1 Omission, C2 Single Log Outage, C2 Single Log Omission, D RPC Outage, D Proposer Stop/Delay).
- **Execution Scale:** **20,850 publication trials**, **180 verification queries**, **1,800 cgroup resource samples** with real container CPU and memory counters, and **8 Section 5 correctness tests** (all passing).

### Artifacts Generated
All raw data artifacts strictly conform to the research specifications in [`results/`](results/):
- [`results/run_config.json`](results/run_config.json): Reproducibility parameters, Besu QBFT configuration, retry policies, and SHA-256 hashes.
- [`results/publication_trials.csv`](results/publication_trials.csv): 20,850 batch trial records with nanosecond submission and acceptance timestamps.
- [`results/verification_queries.csv`](results/verification_queries.csv): Retrieval and verification latencies under fresh and cached network conditions.
- [`results/resource_measurements.csv`](results/resource_measurements.csv): Container cgroup CPU percentage and memory bytes alongside EVM gas counters.
- [`results/correctness_tests.csv`](results/correctness_tests.csv): 8/8 passing security correctness and safe uncertainty test cases.

---

## Project Structure

```
uniVeri/
├── contracts/                              # Smart Contracts
│   └── AcademicCertificateRegistry.sol     # Merkle batch registry with ecrecover & revocation
├── docker/
│   └── besu/                               # Hyperledger Besu genesis.json & validator keys
├── docker-compose.testbed.yml              # 8-container testbed (4 Besu nodes + 4 Log daemons)
├── services/
│   └── log-daemon/                         # Standalone Express REST Transparency Log service
├── scripts/
│   ├── run-all-benchmarks.ts               # Complete dual-mode benchmark suite runner
│   ├── run-correctness-and-queries.ts      # Section 5 correctness evaluator & query generator
│   ├── setup-besu-cluster.ts               # Besu deterministic cluster key generator
│   ├── setup-netem.sh                      # Kernel tc netem network emulation script
│   ├── cgroup-collector.ts                 # Docker container stats / cgroup metrics sampler
│   └── faults/                             # Real-world fault injection scripts
│       ├── fault-d-f2b-stop-proposer.ts    # Halts active QBFT round proposer
│       ├── fault-d-f5-rpc-proxy.ts         # Injects RPC connection drops on port 8547
│       ├── fault-c1-omission.ts            # C1 omission & stale checkpoint injector
│       └── fault-c2-quorum-failure.ts      # C2 single log failure injector
├── src/
│   ├── benchmark/                          # Workload definitions & artifact validators
│   ├── core/                               # RFC 8785 Canonical JSON, Merkle tree, manifests
│   ├── publisher/                          # Unified publication client with retries
│   ├── services/                           # HTTP REST client and EVM contract adapters
│   └── verifier/                           # Multi-architecture verdict decision logic
├── test/                                   # Hardhat contract tests and Vitest suites
├── results/                                # Raw & Processed Benchmark Artifacts
├── hardhat.config.ts                       # Solidity 0.8.24 viaIR configuration
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **Docker Desktop**: With Docker Compose support (for containerized testbed)

### Installation
```bash
# Clone the repository
git clone https://github.com/jaiswalism/uniVeri.git
cd uniVeri

# Install dependencies
npm install
```

### Build & Compile
```bash
# Compile Solidity contracts and generate Typechain definitions
npm run compile

# Build TypeScript codebase
npm run build
```

### Running Tests
```bash
# Run all tests (Hardhat contracts + Vitest cryptographic & artifact suites)
npm test

# Run contract tests only
npm run test:contracts
```

### Running the Multi-Container Testbed & Benchmarks

1. **Start the Multi-Container Cluster:**
   ```bash
   docker compose -f docker-compose.testbed.yml up -d --build
   ```

2. **Verify Cluster Health:**
   ```bash
   # Check Besu JSON-RPC
   curl -X POST http://127.0.0.1:8545 -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   
   # Check Log Daemons
   curl http://127.0.0.1:9001/v1/checkpoint
   ```

3. **Execute the Benchmarking Suite:**
   ```bash
   # Execute the complete benchmark across all architectures and workloads (W1–W6, 10 reps)
   npm run benchmark:testbed

   # Or execute the Section 5 Correctness Suite (TC-1 to TC-8) standalone against the live cluster
   npm run benchmark:correctness
   ```

4. **Execute Fault Injections:**
   ```bash
   # Stop the active QBFT round leader
   npm run fault:proposer
   
   # Start RPC connection drop proxy
   npm run fault:proxy
   ```

---

## License

This project is licensed under the [MIT License](LICENSE).
