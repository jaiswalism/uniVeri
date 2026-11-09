# Project Progress — Academic Certificate Verification Research Prototype

> **Goal:** Build and experimentally evaluate a common academic certificate-verification prototype comparing three publication architectures (**C1**: Single Log, **C2**: 3-Log 2-of-3 Quorum Evidence, **D**: Hyperledger Besu QBFT Blockchain Registry) strictly adhering to `Academic_Certificate_Verification_Frozen_Research_Plan.md` and `05-experiment-results-specification.md`.

---

## Milestone Tracker

- [x] **Milestone 0: Project Setup & Progress Tracking**
  - [x] Analyze research plan and frozen constraints
  - [x] Create and maintain `progress.md`
  - [x] Setup repository structure, package management, and TypeScript toolchain

- [x] **Milestone 1: Common Cryptographic Core & Data Models**
  - [x] Canonical JSON serialization & deterministic hashing (RFC 8785 strict subset)
  - [x] Certificate model & high-entropy commitment generation (privacy boundary: `SHA256(Canonical(Cert) || Salt)`)
  - [x] Binary Merkle Tree implementation (leaf hashing `0x00`, node hashing `0x01`, proof generation & verification)
  - [x] Logical Batch ID vs. Content ID derivation formulas
  - [x] Signed Batch Manifest model & ECDSA (secp256k1) institution signing/verification matching Solidity ABI encoding
  - [x] Comprehensive unit test suite for cryptographic core (8/8 test suites passing)

- [x] **Milestone 2: Transparency Log Architecture (C1 & C2 Services)**
  - [x] Append-only Transparency Log engine with signed tree checkpoints (STH)
  - [x] RFC 6962-style Merkle audit/inclusion proof generation for log entries
  - [x] Case-insensitive `batchContentId` indexing (`.toLowerCase()`) preventing map lookup misses
  - [x] Configurable Failure Injection Layer (unavailability 503, delay, omission/censorship, corrupted proofs, stale checkpoints)
  - [x] Multi-log cluster manager orchestrating Log Alpha, Log Beta, Log Gamma (for C2) and Log Primary (for C1)
  - [x] Containerized HTTP REST Log Daemons (`services/log-daemon/`):
    - `log-c1-primary` on Port `9001`
    - `log-c2-alpha` on Port `9002`, `log-c2-beta` on Port `9003`, `log-c2-gamma` on Port `9004` (2-of-3 quorum)
  - [x] `HttpLogEngineClient` with asynchronous `/health` initialization and operator address cache synchronization

- [x] **Milestone 3: Blockchain Registry Architecture (D — Smart Contracts & Besu QBFT)**
  - [x] Solidity Smart Contract: `AcademicCertificateRegistry.sol` (Solidity 0.8.24 viaIR)
    - [x] Issuer registration and institutional public key management
    - [x] Permissionless batch registration with institutional signature verification (`ecrecover`)
    - [x] Content ID vs Logical Batch ID conflict and duplicate handling (`BatchConflictDetected`)
    - [x] Batch status & dual-mode revocation tracking (signed revocation events or authorized caller calls)
    - [x] Gas-optimized storage & event emissions (`388 bytes` calldata, `224 bytes` receipt logs)
  - [x] Containerized Hyperledger Besu 4-Node QBFT Cluster (`hyperledger/besu:24.7.0`):
    - [x] 4 validator nodes (`besu-node-1` to `besu-node-4`) on dedicated Docker network `testbed-net` (`172.28.0.0/16`)
    - [x] 1-second block period (`blockperiodseconds: 1`), 30k epoch length, 4s request timeout
    - [x] Deterministic QBFT genesis configuration with pre-allocated accounts and RLP-encoded validator seals
    - [x] Per-container CFS resource limits (`cpus: "2.0"`, `mem_limit: 4g`)
  - [x] Hardhat / ethers test suite verifying contract correctness and gas consumption

- [x] **Milestone 4: Common Independent Publisher & Verifier**
  - [x] Common Independent Publisher client (unified retry policy, timeout, batch submission directly to EVM & Logs)
  - [x] Concurrent mempool pipelining (`CHUNK_SIZE = 8` pending transactions per 1s block) on Besu D
  - [x] Publisher adapters for C1, C2, and D with `RegistryRetrievalAdapter`
  - [x] Common Verifier engine implementing frozen verification vocabulary:
    - `AUTHENTIC`, `NOT_AUTHENTIC`
    - `PUBLISHED`, `STALE_EVIDENCE`, `INSUFFICIENT_EVIDENCE`
    - `REVOKED_AS_OF_EVIDENCE`, `NO_REVOCATION_OBSERVED`, `STATUS_UNKNOWN`
    - `ACCEPTED_AS_OF_EVIDENCE_BOUNDARY`, `REJECTED`, `INCONCLUSIVE`
  - [x] Multi-architecture evidence evaluator (C1 single-log, C2 2-of-3 quorum, D block finality)

- [x] **Milestone 5: Benchmark Execution & Specification Artifacts**
  - [x] Workload Matrix W1–W6 ($N \in \{1k, 10k, 50k\}$, $K \in \{100, 1k, 10k\}$, $B = \lceil N/K \rceil$)
  - [x] 6 Failure Interventions on W4:
    - C1 Log Outage (`C1_SOLE_LOG_UNAVAILABLE`)
    - C1 Omission (`C1_SOLE_LOG_OMISSION`)
    - C2 Single Log Outage (`C2_ONE_LOG_UNAVAILABLE`)
    - C2 Single Log Omission (`C2_ONE_LOG_OMISSION`)
    - D RPC Outage (`D_ENDPOINT_UNAVAILABLE` via proxy)
    - D Processing Delay (`D_PROCESSING_DELAYED` past deadline)
  - [x] Executable Fault Injectors:
    - `scripts/faults/fault-d-f2b-stop-proposer.ts`: Dynamically calculates active QBFT proposer index and pauses container
    - `scripts/faults/fault-d-f5-rpc-proxy.ts`: Port 8547 proxy injecting connection resets and HTTP 503 errors
    - `scripts/setup-netem.sh`: Kernel link delay emulation ($\Delta \in \{20\text{ ms}, 50\text{ ms}\}$)
  - [x] Full execution scale: **240 runs**, **20,850 publication trials**, **180 verification queries**, **1,800 cgroup resource samples**
  - [x] Section 5 Correctness Suite: **8/8 targeted test cases passing (`PASS`)**
  - [x] Standalone Phase 3 runner: `npm run benchmark:correctness` (`--phase3-only`, ~25s execution)
  - [x] Raw data artifacts in `results/`:
    1. `results/run_config.json`
    2. `results/publication_trials.csv` (20,850 trial rows)
    3. `results/verification_queries.csv` (180 query rows covering fresh and cached modes)
    4. `results/resource_measurements.csv` (cgroup CPU%, memory bytes, net bytes, and gas)
    5. `results/correctness_tests.csv` (8/8 passing tests)
    6. `results/publication_traces.json` (receipt provenance and gas logs)
  - [x] Automated artifact validator: `npm run validate:artifacts`

- [x] **Milestone 6: Licensing & Documentation**
  - [x] Established **uniVeri Research & Academic Evaluation License** in `LICENSE`
  - [x] Research & study permitted with mandatory reference & citation; strictly no unreferenced recreation
  - [x] Resolved Mermaid flowchart render syntax error on GitHub
  - [x] Comprehensive Section 4 benchmark setup and hardware report documented in `README.md`

---

## Section 4 Benchmark Setup & Environmental Baseline

### 1. Host Hardware
* **CPU Model:** AMD Ryzen 5 5600H with Radeon Graphics (6 Cores / 12 Logical Processors, Base 3.3 GHz, Boost 4.2 GHz).
* **RAM:** 16 GB DDR4 (15.4 GB usable).
* **Storage:** 512 GB NVMe PCIe 3.0 x4 M.2 SSD (`INTEL SSDPEKNU512GZ`).
* **Host Operating System:** Windows 11 Home Single Language 64-bit (Build 26200 / 24H2) with WSL2 Linux backend.
* **Docker Environment:** Docker Desktop 4.93.0 / Docker Engine `v29.8.1` (API `v1.56`, containerd `v2.3.5`, runc `v1.5.1`).
* **Host Topology:** Single-host bridge network (`testbed-net`, subnet `172.28.0.0/16`). No rigid core pinning; CFS quotas (`cpus: "2.0"`, `mem_limit: 4g` for Besu).

### 2. Software Versions & Consensus Specifications
* **Hyperledger Besu (Architecture D):** `hyperledger/besu:24.7.0` on OpenJDK 64-Bit Server VM (`21.0.3+9-Ubuntu-1ubuntu1`).
* **Consensus Engine:** QBFT (4 validator nodes, $3F+1$, $F=1$, 1-second block period, 4s request timeout, 30k block epoch).
* **Solidity:** `0.8.24`, optimizer enabled (`runs: 200`), `viaIR: true`.
* **Runtime:** Node.js `v22.12.0` / TypeScript `5.7.2` via `tsx` (esbuild).
* **Web3 & Cryptography:** `ethers.js v6.13.4` (secp256k1 ECDSA, `ecrecover`, `verifyMessage`).
* **Canonical JSON:** Strict subset of RFC 8785 (`src/core/canonical.ts`).
* **REST Framework:** Express `v4.21.2`, CORS `v2.8.5`.

### 3. Parameters & Timers
* **Link Delay ($\Delta$):** `tc netem` on bridge interface `172.28.0.1` ($\Delta = 20\text{ ms} \pm 5\text{ ms}$, 25% correlation).
* **Timeout Thresholds ($T$):**
  * $T_\text{deadline}$: $1,000\text{ ms}$ (C1/C2) / $6,000\text{ ms}$ (Besu D).
  * $T_\text{late}$: $3,000\text{ ms}$ (C1/C2) / $12,000\text{ ms}$ (Besu D).
* **Publisher Release Rates:**
  * C1: Sequential HTTP burst ($\sim 40\text{–}100\text{ batches/sec}$).
  * C2: Parallel 3-log dispatch with 2-of-3 quorum ($\sim 25\text{–}40\text{ batches/sec}$).
  * D: Concurrent mempool batching (`CHUNK_SIZE = 8` pending nonces per 1s block) yielding $\sim 8\text{–}15\text{ batches/sec}$.

---

## Experimental Results & Evidence-Based Audit

### 1. Correctness Test Suite Results ([`results/correctness_tests.csv`](results/correctness_tests.csv))

All 8 targeted correctness tests pass (**8/8 `PASS`**):

| Test ID | Description | Architecture | Expected Auth | Observed Auth | Expected Pub | Observed Pub | Expected Status | Observed Status | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **TC-1** | Unmodified certificate claim | C1 | `AUTHENTIC` | `AUTHENTIC` | `PUBLISHED` | `PUBLISHED` | `NO_REVOCATION_OBSERVED` | `NO_REVOCATION_OBSERVED` | **PASS** |
| **TC-2** | Modified certificate claim | C1 | `NOT_AUTHENTIC` | `NOT_AUTHENTIC` | `PUBLISHED` | `PUBLISHED` | `NO_REVOCATION_OBSERVED` | `NO_REVOCATION_OBSERVED` | **PASS** |
| **TC-3** | Invalid Merkle proof path | C1 | `NOT_AUTHENTIC` | `NOT_AUTHENTIC` | `PUBLISHED` | `PUBLISHED` | `NO_REVOCATION_OBSERVED` | `NO_REVOCATION_OBSERVED` | **PASS** |
| **TC-4** | Invalid institution signature | C1 | `NOT_AUTHENTIC` | `NOT_AUTHENTIC` | `INSUFFICIENT_EVIDENCE` | `INSUFFICIENT_EVIDENCE` | `STATUS_UNKNOWN` | `STATUS_UNKNOWN` | **PASS** |
| **TC-5** | Unavailable publication evidence | C1 | `AUTHENTIC` | `AUTHENTIC` | `INSUFFICIENT_EVIDENCE` | `INSUFFICIENT_EVIDENCE` | `STATUS_UNKNOWN` | `STATUS_UNKNOWN` | **PASS** |
| **TC-6** | Genuinely signed stale checkpoint (>300s) | C1 | `AUTHENTIC` | `AUTHENTIC` | `STALE_EVIDENCE` | `STALE_EVIDENCE` | `STATUS_UNKNOWN` | `STATUS_UNKNOWN` | **PASS** |
| **TC-7** | Verified on-chain revocation | D | `AUTHENTIC` | `AUTHENTIC` | `PUBLISHED` | `PUBLISHED` | `REVOKED_AS_OF_EVIDENCE` | `REVOKED_AS_OF_EVIDENCE` | **PASS** |
| **TC-8** | Two C2 issuance proofs with Alpha down | C2 | `AUTHENTIC` | `AUTHENTIC` | `PUBLISHED` | `PUBLISHED` | `STATUS_UNKNOWN` | `STATUS_UNKNOWN` | **PASS** |

### 2. Experimental Completeness & Reconciled Matrix
- **Normal Operation Runs:** 6 Workloads (W1–W6) $\times$ 3 Architectures $\times$ 10 Repetitions = **180 runs**.
- **Failure Runs:** 6 Interventions on W4 $\times$ 10 Repetitions = **60 runs**.
- **Total Workload Runs:** **240 runs**.
- **Reconciled Publication Batch Trials:**
  - Normal trials: $675 \text{ batches} \times 3 \times 10 = 20,250$ trials.
  - Failure trials: $10 \text{ batches} \times 6 \times 10 = 600$ trials.
  - Total publication trials recorded: **20,850 rows** (0 missing, 0 duplicates).
- **Verification Queries:** 180 queries across normal and failure scenarios under fresh and cached modes.
- **Resource Measurements:** 1,800 measurements capturing container cgroup CPU percentages, memory RSS bytes, network I/O bytes, and EVM gas.

### 3. Concrete Gas & Byte Footprint (Receipt Traces)
* **Transaction Calldata:** Exactly **388 bytes** measured from `tx.data`.
* **Receipt Event Logs:** Exactly **224 bytes** (`BatchRegistered` event topic + data).
* **Gas Consumption per Batch Registration:**
  * Minimum: **294,299 gas**
  * Median: **294,323 gas**
  * Maximum: **294,351 gas**

---

## Research Validity Categorization & System Boundaries

### 1. Implemented
- **RFC 8785 Strict Subset Canonicalization:** Deterministic JSON serialization with UTF-16 code unit key sorting, negative zero normalization, and strict rejection of non-finite numbers.
- **Cryptographic Manifest Predicate:** Pre-submission publication predicate validating identity derivation, Merkle root integrity, credential count, and institutional ECDSA signatures before write dispatch.
- **Transparency Log Engines (C1 & C2):** Append-only verifiable Merkle logs with signed tree checkpoints, inclusion proof generation, independent status queries, and isolated failure controls.
- **Containerized Testbed:** 4-node Hyperledger Besu QBFT cluster alongside 4 standalone REST log daemon containers running on isolated Docker bridge networks with netem link emulation.
- **Dynamic Consensus Round Faults:** Proposer calculation $\text{index} = (\text{blockNumber} + 1) \pmod 4$ to halt active round proposers and measure QBFT view-change failover.
- **Common Verifier:** Multi-architecture verification engine implementing standardized formal security vocabulary.

### 2. Unit-Tested
- **Cryptographic Conformance Suite (`test/core/cryptography.test.ts`):** 8 test suites verifying RFC 8785 canonical JSON, non-finite number rejection, negative zero normalization, leaf commitments, Merkle proofs, ID separation, and ECDSA verification.
- **Verification Regression Suite (`test/verifier/verification-regression.test.ts`):** 22 test suites covering pinned issuer policy enforcement, tampered revocation entry handling, C2 read-path omission, and single-log quorum drop.
- **Smart Contract Suite (`test/contracts/AcademicCertificateRegistry.test.ts`):** 5 Hardhat suites testing issuer registration, permissionless batch registration, duplicate content ID rejection, logical batch conflict detection, and institution-authorized revocation.
- **Artifact Negative Fixture Suite (`test/benchmark/validate-artifacts.test.ts`):** 5 fixture suites verifying rejection of corrupted artifacts (TC-4 mismatch, timestamp inversion, latency arithmetic mismatch, duplicate rows, invalid run configuration).

### 3. Measured and Artifact-Validated
- **Publication Trials (`results/publication_trials.csv`):** 20,850 rows across 240 runs with monotonic timestamp ordering and no duplicate submissions.
- **Verification Queries (`results/verification_queries.csv`):** Retrieval and verification latencies under fresh network and cached conditions.
- **Resource Measurements (`results/resource_measurements.csv`):** Container cgroup CPU percentage and memory RSS bytes alongside EVM gas counters.
- **Reproducibility Metadata (`results/run_config.json`):** Complete execution configuration including warmup specifications, Latin-square execution order schedule, fixed 50k dataset hash, Besu QBFT parameters, retry policies, and companion artifact SHA-256 hashes.

### 4. Unmeasured or Limited
- **On-Chain Admission Control Scope:** The Solidity contract receives no `issuerId` string, `schemaVersion`, or `institutionBatchNumber` in calldata. The contract validates active issuer registration, ECDSA authorization, duplicate content IDs, and logical-batch conflicts over the supplied fields; it does not independently recompute off-chain string/schema derivation formulas.
- **Network Topology Scope:** All containers run within a single host's Docker bridge network with software-emulated delays (`tc netem`); physical WAN routing and BGP latency jitter are simulated rather than physically geographically distributed.

---

## Activity Log
- **2026-10-04**: Initialized repository structure and progress tracker.
- **2026-10-04**: Implemented canonical serialization, binary Merkle tree, and signed manifest models.
- **2026-10-04**: Built transparency log engine, cluster manager, and signed checkpoints with failure injection.
- **2026-10-04**: Developed `AcademicCertificateRegistry.sol` smart contract with institutional signature recovery and conflict handling; verified with Hardhat test suite.
- **2026-10-04**: Created `IndependentPublisher` client and `CommonVerifier` supporting frozen verification vocabulary.
- **2026-10-04**: Connected live Hardhat EVM contract deployment and direct on-chain execution to the specification benchmark suite.
- **2026-10-04**: Completed full research-validity correction pass (tampered revocation defense, genuine C2 read omission, workload filtering, event-byte & gas reporting, TC-7 authorization, C2 per-log accounting, reproducibility metadata, RFC 8785 conformance).
- **2026-11-04**: Containerized Architecture D on a 4-Node Hyperledger Besu QBFT cluster (`besu-node-1` to `besu-node-4`, chain ID 1337). Generated deterministic genesis with RLP-encoded validator seals and allocated accounts.
- **2026-11-04**: Built standalone Express/TypeScript REST microservices for transparency logs (`services/log-daemon/`), hosting `log-c1-primary` (9001), `log-c2-alpha` (9002), `log-c2-beta` (9003), and `log-c2-gamma` (9004).
- **2026-11-04**: Implemented kernel-level packet delay emulation (`scripts/setup-netem.sh`) and container resource stats sampler (`scripts/cgroup-collector.ts`).
- **2026-11-04**: Developed executable fault injectors: dynamic QBFT proposer halting (`fault-d-f2b-stop-proposer.ts`) and socket-resetting RPC proxy on port 8547 (`fault-d-f5-rpc-proxy.ts`).
- **2026-11-05**: Optimized Besu block period to 1 second (`blockperiodseconds: 1`) and introduced concurrent mempool transaction pipelining (`CHUNK_SIZE = 8`) to achieve $\sim 8\text{–}15\text{ batches/sec}$.
- **2026-11-05**: Resolved C1/C2 proof verification issues: initialized `HttpLogEngineClient` operator keys asynchronously, normalized `batchContentId` indexing to lowercase, and fixed TC-3 Merkle step corruption and TC-6 stale checkpoint generation.
- **2026-11-05**: Executed Phase 3 Correctness Test Suite with 8/8 passing tests (`PASS`) and added standalone runner flag (`npm run benchmark:correctness`).
- **2026-11-06**: Established proprietary **uniVeri Research & Academic Evaluation License** allowing non-commercial research and study with mandatory attribution, strictly prohibiting unreferenced recreation or plagiarism.
- **2026-11-06**: Fixed GitHub Mermaid flowchart render parse error and finalized comprehensive Section 4 methodology documentation.
