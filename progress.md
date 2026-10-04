# Project Progress — Academic Certificate Verification Research Prototype

> **Goal:** Build and experimentally evaluate a common academic certificate-verification prototype comparing three publication architectures (**C1**: Single Log, **C2**: 3-Log 2-of-3 Quorum Evidence, **D**: Blockchain Registry) strictly adhering to `Academic_Certificate_Verification_Frozen_Research_Plan.md` and `05-experiment-results-specification.md`.

---

## Milestone Tracker

- [x] **Milestone 0: Project Setup & Progress Tracking**
  - [x] Analyze research plan and frozen constraints
  - [x] Create and maintain `progress.md`
  - [x] Setup repository structure, package management, and TypeScript toolchain

- [x] **Milestone 1: Common Cryptographic Core & Data Models**
  - [x] Canonical JSON serialization & deterministic hashing (RFC 8785 standard)
  - [x] Certificate model & high-entropy commitment generation (privacy boundary)
  - [x] Binary Merkle Tree implementation (leaf hashing, root derivation, inclusion proof generation & verification)
  - [x] Logical Batch ID vs. Content ID derivation formulas
  - [x] Signed Batch Manifest model & ECDSA (secp256k1) institution signing/verification matching Solidity ABI encoding
  - [x] Comprehensive unit test suite for cryptographic core (100% pass)

- [x] **Milestone 2: Transparency Log Architecture (C1 & C2 Services)**
  - [x] Append-only Transparency Log engine with signed tree checkpoints (STH)
  - [x] Merkle audit/inclusion proof generation for log entries
  - [x] In-memory & HTTP-ready log endpoints for submission, inclusion proofs, checkpoints
  - [x] Configurable Failure Injection Layer (unavailability 503, delay, omission/censorship, corrupted proofs)
  - [x] Multi-log cluster manager orchestrating Log Alpha, Log Beta, Log Gamma (for C2) and Log Primary (for C1)

- [x] **Milestone 3: Blockchain Registry Architecture (D — Smart Contracts)**
  - [x] Solidity Smart Contract: `AcademicCertificateRegistry.sol`
    - [x] Issuer registration and public key management
    - [x] Permissionless batch registration with institutional signature verification (`ecrecover`)
    - [x] Content ID vs Logical Batch ID conflict and duplicate handling
    - [x] Batch status & revocation tracking
    - [x] Gas-optimized storage & event emissions
  - [x] Hardhat / ethers test suite verifying contract correctness, gas metrics, and edge cases (5/5 tests passing)
  - [x] Direct live EVM contract deployment & execution harness via Hardhat EVM (Solidity 0.8.24 viaIR)

- [x] **Milestone 4: Common Independent Publisher & Verifier**
  - [x] Common Independent Publisher client (unified retry policy, timeout, batch submission directly to EVM & Logs)
  - [x] Publisher adapters for C1, C2, and D
  - [x] Common Verifier engine implementing research-valid verification vocabulary (`AUTHENTIC`, `NOT_AUTHENTIC`, `PUBLISHED`, `REVOKED_AS_OF_EVIDENCE`, `STATUS_UNKNOWN`, safe uncertainty)
  - [x] Multi-architecture evidence evaluator (C1 single-log, C2 2-of-3 quorum, D block finality)

- [x] **Milestone 5: 05-Specification Simulation & Experiment Engine on Live EVM**
  - [x] Implemented exact Workload Matrix W1–W6 ($N \in \{1k, 10k, 50k\}$, $K \in \{100, 1k, 10k\}$, $B = \lceil N/K \rceil$)
  - [x] Implemented all 6 Failure Interventions on W4 (C1 Log Outage, C1 Omission, C2 Single Log Outage, C2 Single Log Omission, D RPC Outage, D Delayed Processing)
  - [x] Implemented Section 5 Correctness & Safe Uncertainty Suite (8 targeted tests) with live EVM contract verification and on-chain revocation
  - [x] **Live EVM Execution for Architecture D:** Every single batch registration is executed as a real transaction on the compiled Solidity contract deployed to Hardhat EVM (recovering signatures via `ecrecover`, writing state slots, measuring exact gas consumption, and querying state from EVM blocks).
  - [x] Complete reconciliation: Exactly **20,850 publication trials** and **420 verification queries** across 240 workload runs.
  - [x] Generated all 5 Section 6 Raw Output Artifacts:
    1. `results/run_config.json`
    2. `results/publication_trials.csv` (20,850 trial rows with real block numbers and mined latencies)
    3. `results/verification_queries.csv` (420 query rows covering fresh network and cached modes)
    4. `results/resource_measurements.csv` (306 resource metrics with real EVM gas: ~183k-217k gas/batch)
    5. `results/correctness_tests.csv` (8/8 passing tests)
  - [x] Automated artifact completeness and validation script: `src/benchmark/validate-artifacts.ts` (100% verified)

- [x] **Milestone 6: Interactive Dashboard & UI**
  - [x] Interactive visual pipeline & comparative architecture diagram
  - [x] Certificate generation, batching, and Merkle tree visualizer
  - [x] Live multi-architecture publication inspector for C1, C2, and D
  - [x] Multi-architecture Certificate Verification Portal with tampering simulations
  - [x] Experiment Runner & Real-time Benchmark Analysis Charts

---

## Evidence-Based Audit & Experimental Results

### 1. Verification Correctness (Priority 1)
| Component | Audit Standard | Implementation Evidence | Status |
|---|---|---|---|
| **Invalid Signature Semantics** | With a configured issuer key, failed signature MUST produce `NOT_AUTHENTIC`, not `UNKNOWN`. | [src/verifier/common-verifier.ts](file:///e:/Smart%20Contracts/uniVeriImplementation/src/verifier/common-verifier.ts#L55-L68) | **VERIFIED** |
| **Tamper vs Publication** | Tampered certificate under authentic published batch must fail overall verification (`isVerified=false`). | [test/verifier/verification-regression.test.ts](file:///e:/Smart%20Contracts/uniVeriImplementation/test/verifier/verification-regression.test.ts#L170-L195) | **VERIFIED** |
| **C2 Quorum Distinction** | Duplicate proofs from the same log cannot satisfy 2-of-3 quorum. | [src/verifier/common-verifier.ts](file:///e:/Smart%20Contracts/uniVeriImplementation/src/verifier/common-verifier.ts#L88-L105) (`Set<string>()`) | **VERIFIED** |
| **Safe Uncertainty** | 2 of 3 C2 proofs with 1 log down produces `NO_REVOCATION_OBSERVED` (not `NOT_REVOKED`). | [src/verifier/common-verifier.ts](file:///e:/Smart%20Contracts/uniVeriImplementation/src/verifier/common-verifier.ts#L104-L110) | **VERIFIED** |
| **On-Chain Revocation** | Revocation executed on EVM (`revokeBatch`) produces `REVOKED_AS_OF_EVIDENCE`. | [src/benchmark/experiment-spec.ts](file:///e:/Smart%20Contracts/uniVeriImplementation/src/benchmark/experiment-spec.ts#L305-L330) | **VERIFIED** |

### 2. Experimental Completeness & Reconciled Matrix (Priority 2)
- **Normal Operation Runs:** 6 Workloads (W1–W6) $\times$ 3 Architectures $\times$ 10 Repetitions = **180 runs**.
- **Failure Runs:** 6 Interventions on W4 $\times$ 10 Repetitions = **60 runs**.
- **Total Workload Runs:** **240 runs**.
- **Reconciled Publication Batch Trials:**
  - Workload batches: $B \in [10, 100, 500, 10, 50, 5] \implies 675$ batches.
  - Normal trials: $675 \times 3 \times 10 = 20,250$ trials.
  - Failure trials: $10 \times 6 \times 10 = 600$ trials.
  - Total publication trials recorded: **20,850 rows** (0 missing, 0 duplicates).
- **Verification Queries:**
  - Normal runs: 180 Fresh Network + 180 Cached Mode = 360 queries.
  - Failure runs: 60 Fresh Network queries = 60 queries.
  - Total verification queries recorded: **420 rows**.

### 3. Architecture Performance & Resilience Summary (Post-Audit Verified)
| Architecture | Total Trials | Successes | Timeouts | Failures | Success Rate | Median Evidence Latency | p95 Evidence Latency | Gas / Batch (D) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **C1 (Single Log)** | 6,950 | 6,750 | 0 | 200 | 97.12% | 55.10 ms | 71.43 ms | N/A |
| **C2 (3-Log Quorum)** | 6,950 | 6,950 | 0 | 0 | **100.00%** | 70.08 ms | 104.18 ms | N/A |
| **D (EVM Registry)** | 6,950 | 6,750 | 100 | 100 | 97.12% | 21.52 ms | 26.22 ms | 183,624 – 217,910 gas |

### 4. EVM Gas & Storage Mechanics
- **First batch allocation (`SSTORE` from 0 to non-zero):** `217,848 – 217,910 gas` directly derived from `publication_traces.json` receipts, explained by transaction-level storage/write allocation for `totalBatchesRegistered`, `totalCredentialsRegistered`, and mapping slots.
- **Subsequent batch registrations:** `183,624 – 183,636 gas` per batch, reflecting transaction-level storage write behaviour when cumulative counter slots already hold non-zero values. (Persistent cross-transaction "warm slot" explanations are discarded per audit requirements).
- **Measured Calldata bytes:** Exactly **388 bytes** measured directly from transaction payload (`tx.data`), distinguished from the 160-byte analytical on-chain record layout estimate.
- **Measured Event/Receipt Log bytes:** Exported under `MEASURED_RECEIPT_LOGS_INCLUDING_TOPICS` (strictly **224 bytes** per successful BatchRegistered event: 4 32-byte topics = 128 bytes, plus 96 bytes data payload). The earlier 160-byte figure was an analytical estimate of data-only payload that omitted receipt topic words.
- **Batching efficiency:** W6 ($K=10,000$) achieves a **99% gas reduction** over W3 ($K=100$) for the same $N=50,000$ credentials ($500 \to 5$ transactions).
- **Delayed Mining Intervention:** 100% of delayed mining trials in `D_PROCESSING_DELAYED` tripped the 1000ms global batch deadline and were accurately recorded as `TIMEOUT`, with the mined late blocks successfully observed and indexed by the background watcher.

### 5. Section 5 Correctness & Uncertainty Test Results (8/8 PASS)
- **TC-1 (`PASS`):** Unmodified certificate $\to$ `AUTHENTIC`, `PUBLISHED`, `NO_REVOCATION_OBSERVED`
- **TC-2 (`PASS`):** Tampered claim $\to$ `NOT_AUTHENTIC`, `PUBLISHED`, `NO_REVOCATION_OBSERVED`
- **TC-3 (`PASS`):** Invalid Merkle proof $\to$ `NOT_AUTHENTIC`, `PUBLISHED`, `NO_REVOCATION_OBSERVED`
- **TC-4 (`PASS`):** Invalid institution signature $\to$ `NOT_AUTHENTIC`, `INSUFFICIENT_EVIDENCE`, `STATUS_UNKNOWN`
- **TC-5 (`PASS`):** Unavailable publication evidence $\to$ `AUTHENTIC`, `INSUFFICIENT_EVIDENCE`, `STATUS_UNKNOWN`
- **TC-6 (`PASS`):** Genuinely signed stale checkpoint (>300s) $\to$ `AUTHENTIC`, `STALE_EVIDENCE`, `STATUS_UNKNOWN`
- **TC-7 (`PASS`):** Institution-authorized revocation executed on live EVM contract via funded issuer signer $\to$ `AUTHENTIC`, `PUBLISHED`, `REVOKED_AS_OF_EVIDENCE` (unauthorized third-party revocation confirmed rejected)
- **TC-8 (`PASS`):** C2 issuance with 1 log down $\to$ `AUTHENTIC`, `PUBLISHED`, `STATUS_UNKNOWN` (safe uncertainty: quorum met 2/3, missing Alpha disclosed in status coverage)

---

## Research Validity Categorization & System Boundaries

Per audit requirements, prototype capabilities and limitations are explicitly partitioned into four verified categories:

### 1. Implemented
- **RFC 8785 Strict Subset Canonicalization:** Deterministic JSON serialization supporting UTF-16 code unit key sorting, negative zero normalization (`-0` $\to$ `0`), integer/decimal formatting, exponent notation, and explicit rejection of non-finite numbers (`NaN`, `Infinity`, `-Infinity` throw `TypeError`).
- **Cryptographic Manifest Predicate:** Pre-submission publication predicate validating complete off-chain identity derivation (`logicalBatchId`, `batchContentId`), Merkle root integrity, credential count, and institution ECDSA signatures prior to write dispatch across C1, C2, and D.
- **Transparency Log Engines (C1 & C2):** Append-only verifiable Merkle logs with signed tree checkpoints, inclusion proof generation, independent status queries, and isolated failure injection controls.
- **Genuine Read-Path Omission:** Explicit `readOmitProof` and `readOmitStatus` failure modes decoupled from write-path omission (`acknowledgeButOmit`), accurately simulating logs that store entries but omit evidence upon read retrieval.
- **Tampered Revocation Defense:** Complete evaluation of revocation entries against batch binding, leaf hash binding, operator checkpoint inclusion, and issuer signature. Any tampered revocation entry transitions status to `STATUS_UNKNOWN` / `INCONCLUSIVE` and records diagnostic reasons.
- **Common Verifier:** Multi-architecture verification engine implementing frozen research vocabulary (`AUTHENTIC`, `NOT_AUTHENTIC`, `PUBLISHED`, `STALE_EVIDENCE`, `INSUFFICIENT_EVIDENCE`, `REVOKED_AS_OF_EVIDENCE`, `NO_REVOCATION_OBSERVED`, `STATUS_UNKNOWN`, `ACCEPTED_AS_OF_EVIDENCE_BOUNDARY`, `REJECTED`, `INCONCLUSIVE`).

### 2. Unit-Tested
- **Cryptographic Conformance Suite (`test/core/cryptography.test.ts`):** 8 test suites verifying RFC 8785 canonical JSON, non-finite number rejection, negative zero normalization, leaf commitments, Merkle proofs, ID separation, and ECDSA verification.
- **Verification Regression Suite (`test/verifier/verification-regression.test.ts`):** 22 test suites covering pinned issuer policy enforcement, tampered revocation entry handling (removal, altered reason, altered batch IDs, altered issuer, foreign events, valid signed empty list), C2 read-path omission, and single-log quorum drop.
- **Smart Contract Suite (`test/contracts/AcademicCertificateRegistry.test.ts`):** 5 Hardhat suites testing issuer registration, permissionless batch registration, duplicate content ID rejection, logical batch conflict detection, and institution-authorized revocation with unauthorized third-party rejection.
- **Artifact Negative Fixture Suite (`test/benchmark/validate-artifacts.test.ts`):** 5 fixture suites proving automated rejection of corrupted artifacts (TC-4 mismatch, timestamp inversion, latency arithmetic mismatch, duplicate rows, invalid run configuration).

### 3. Measured and Artifact-Validated
- **Publication Trials (`results/publication_trials.csv`):** 20,850 rows across 240 runs with monotonic timestamp ordering and no duplicate submissions.
- **Verification Queries (`results/verification_queries.csv`):** 420 query rows validating fresh network and cached verification latencies, including genuine C2 read omission verification.
- **Resource Measurements (`results/resource_measurements.csv`):** 554 rows validating:
  - EVM gas consumption: `183,624 – 217,910 gas` (measured from receipt provenance);
  - Calldata: `388 bytes` (measured directly from `tx.data`);
  - Receipt log bytes: `224 bytes` per batch registration (`EVENT_BYTES` including topics);
  - Serialized log state: C1 Primary, C2 Alpha, C2 Beta, C2 Gamma, and C2 Aggregate with mathematical validation (`LOG_C2_ALPHA + LOG_C2_BETA + LOG_C2_GAMMA == LOG_C2_AGGREGATE`);
  - Off-chain preprocessing package bytes.
- **Statistical Summary (`results/statistical_summary.json`):** Strict normal-operation filtering (`scenario === "NORMAL_OPERATION"`), producing undiluted workload metrics (W4 success rate = 100% across all architectures) alongside isolated failure scenario statistics.
- **Reproducibility Metadata (`results/run_config.json`):** Complete execution configuration including warmup specifications, Latin-square execution order schedule, fixed 50k dataset hash, late-observation window, statistical t-distribution parameters, contract deployment addresses, and companion artifact SHA-256 hashes.

### 4. Unmeasured or Limited
- **On-Chain Admission Control Scope:** The Solidity contract receives no `issuerId` string, `schemaVersion`, or `institutionBatchNumber` in calldata. The contract validates active issuer registration, ECDSA authorization, duplicate content IDs, and logical-batch conflicts over the supplied fields; it does not independently recompute off-chain string/schema derivation formulas.
- **Local EVM Execution vs. Production Blockchain:** Benchmarks execute on Hardhat EVM (Solidity 0.8.24 viaIR). Local execution measures deterministic execution gas and state transitions; it does not model P2P mempool dynamics, MEV reordering, network propagation jitter, or chain reorganizations.
- **Explicitly Unmeasured Resource Metrics:**
  - Publisher CPU utilization (`PUBLISHER_CPU`)
  - Publisher memory utilization (`PUBLISHER_MEMORY`)
  - Publisher network byte transfer (`PUBLISHER_NETWORK_BYTES`)
  - Standalone cryptographic proof size (`PROOF_SIZE`)
  - Standalone manifest payload size (`MANIFEST_SIZE`)
  - Standalone evidence bundle size (`EVIDENCE_SIZE`)
  - Dedicated preprocessing duration (`PREPROCESSING_DURATION`)
  - Infrastructure component count (`INFRASTRUCTURE_COMPONENT_COUNT`)
  These items are explicitly marked as `UNAVAILABLE_OR_UNMEASURED` in `resource_measurements.csv` and are excluded from completed empirical claims.

---

## Activity Log
- **2026-10-04**: Initialized repository structure and progress tracker.
- **2026-10-04**: Implemented canonical serialization, binary Merkle tree, and signed manifest models.
- **2026-10-04**: Built transparency log engine, cluster manager, and signed checkpoints with failure injection.
- **2026-10-04**: Developed `AcademicCertificateRegistry.sol` smart contract with institutional signature recovery and conflict handling; verified with Hardhat test suite.
- **2026-10-04**: Created `IndependentPublisher` client and `CommonVerifier` supporting frozen verification vocabulary.
- **2026-10-04**: Connected live Hardhat EVM contract deployment and direct on-chain execution to the specification benchmark suite.
- **2026-10-04**: Completed full research-validity correction pass:
  1. **Tampered Revocation Defense:** Evaluated every revocation entry for batch binding, leaf hash binding, operator inclusion proof, and issuer signature. Disallowing empty revocation inference upon tampering; returning `STATUS_UNKNOWN`, `INCONCLUSIVE`, `isVerified: false`. Added 6 regression tests.
  2. **Genuine C2 Read-Path Omission:** Implemented `readOmitProof` and `readOmitStatus` in `TransparencyLogEngine` and `LogClusterManager`. Proved Alpha omission on read path while Beta and Gamma maintain 2/3 quorum with `STATUS_UNKNOWN` safe uncertainty.
  3. **Workload Filtering in Statistical Summary:** Filtered workloads strictly by `scenario === "NORMAL_OPERATION"`. Corrected W4 trials to 100 per architecture and 100% normal success rate, isolating the 6 failure interventions into `failureScenarios`.
  4. **Event-Byte & Gas Reporting:** Standardized event reporting as `RECEIPT_LOG_BYTES` / `EVENT_BYTES` at 224 bytes per batch (128 bytes topics + 96 bytes data payload). Derived exact empirical gas range (`183,624 – 217,910 gas`) from `publication_traces.json`. Added validator checks ensuring exact trace agreement for gas, calldata, and event bytes.
  5. **TC-7 Authorization Semantics:** Executed TC-7 revocation through a funded institution issuer signer (`issuerWallet.connect(provider)`), verified stored issuer matches caller, and proved unauthorized third-party revocation is rejected on-chain.
  6. **C2 Per-Log Storage Accounting:** Exported `LOG_C2_ALPHA`, `LOG_C2_BETA`, `LOG_C2_GAMMA`, and `LOG_C2_AGGREGATE` with automated validator check verifying $\text{Alpha} + \text{Beta} + \text{Gamma} == \text{Aggregate}$.
  7. **Resource Limitations & Provenance:** Explicitly categorized measured vs analytical vs unmeasured resources in `resource_measurements.csv` and documented limitations.
  8. **Reproducibility Metadata:** Added warmup details, Latin-square execution schedule, fixed 50k dataset hash, transport descriptions, and companion artifact SHA-256 checksums to `run_config.json`.
  9. **RFC 8785 Conformance:** Hardened `canonicalizeJson` with negative zero normalization (`-0` $\to$ `0`), UTF-16 code unit key sorting, and strict rejection of non-finite numbers (`NaN`, `Infinity`). Added 4 conformance suites in `cryptography.test.ts`.
  10. **Scoped Admission Control:** Narrowed contract docstrings and documentation regarding on-chain admission control over supplied calldata fields.
  11. **Verification Sequence:** All checks passing (`npx tsc --noEmit` = 0 errors; `hardhat test` = 5/5 pass; `vitest run` = 39/39 pass; `npm run validate:artifacts` = 13/13 PASS).

