// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AcademicCertificateRegistry
 * @notice Architecture D: Blockchain registry with permissionless batch-registration semantics.
 * Stores batch commitments, verifies institutional signatures on-chain, and manages batch lifecycle.
 */
contract AcademicCertificateRegistry {
    enum BatchStatus {
        NONE,
        ACTIVE,
        REVOKED
    }

    struct BatchRecord {
        bytes32 logicalBatchId;
        bytes32 batchContentId;
        bytes32 merkleRoot;
        address issuerAddress;
        uint16 issuerKeyVersion;
        uint32 credentialCount;
        uint64 issuedAt;
        uint64 registeredAt;
        uint64 registeredBlockNumber;
        BatchStatus status;
    }

    struct IssuerInfo {
        string issuerId;
        address signingAddress;
        bool isActive;
        uint64 registeredAt;
    }

    // Registry owner / governance
    address public owner;

    // Registered institutions: issuer address => info
    mapping(address => IssuerInfo) public issuers;
    mapping(string => address) public issuerIdToAddress;

    // Batch storage: batchContentId => BatchRecord
    mapping(bytes32 => BatchRecord) public batchesByContentId;

    // Mapping to track canonical batch for logicalBatchId
    mapping(bytes32 => bytes32) public logicalBatchToContentId;

    // Total counts for metrics and inspection
    uint256 public totalBatchesRegistered;
    uint256 public totalCredentialsRegistered;

    // Events
    event IssuerRegistered(string indexed issuerId, address indexed signingAddress);
    event IssuerStatusUpdated(address indexed signingAddress, bool isActive);
    event BatchRegistered(
        bytes32 indexed logicalBatchId,
        bytes32 indexed batchContentId,
        bytes32 merkleRoot,
        address indexed issuerAddress,
        uint32 credentialCount,
        uint64 registeredBlockNumber
    );
    event BatchConflictDetected(
        bytes32 indexed logicalBatchId,
        bytes32 existingContentId,
        bytes32 conflictingContentId,
        address indexed submitter
    );
    event BatchRevoked(
        bytes32 indexed logicalBatchId,
        bytes32 indexed batchContentId,
        address indexed issuerAddress,
        string reason,
        uint64 revokedAt
    );

    error Unauthorized();
    error IssuerNotRegisteredOrInactive();
    error InvalidSignature();
    error BatchAlreadyRegistered();
    error LogicalBatchConflict();
    error BatchNotFound();
    error BatchAlreadyRevoked();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Registers an authorized academic institution
     */
    function registerIssuer(string calldata issuerId, address signingAddress) external onlyOwner {
        require(signingAddress != address(0), "Invalid address");
        issuers[signingAddress] = IssuerInfo({
            issuerId: issuerId,
            signingAddress: signingAddress,
            isActive: true,
            registeredAt: uint64(block.timestamp)
        });
        issuerIdToAddress[issuerId] = signingAddress;
        emit IssuerRegistered(issuerId, signingAddress);
    }

    /**
     * @notice Updates active status of an issuer
     */
    function setIssuerActive(address signingAddress, bool isActive) external onlyOwner {
        require(issuers[signingAddress].signingAddress != address(0), "Issuer not found");
        issuers[signingAddress].isActive = isActive;
        emit IssuerStatusUpdated(signingAddress, isActive);
    }

    /**
     * @notice Computes standard Ethereum Signed Message Hash
     */
    function toEthSignedMessageHash(bytes32 hash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /**
     * @notice Permissionless batch registration with scoped on-chain admission control.
     * Anyone (independent publisher) can submit, provided the manifest payload passes admission checks.
     *
     * ADMISSION-CONTROL SCOPE & SYSTEM BOUNDARY:
     * - The common publisher validates the complete manifest predicate (including full off-chain
     *   logicalBatchId and batchContentId derivation) prior to submission.
     * - The contract independently verifies:
     *     1. Issuer registration and active status (`issuers[issuerAddress].isActive`);
     *     2. No duplicate content IDs (`batchesByContentId[batchContentId].status == NONE`);
     *     3. No conflicting batch for this logicalBatchId (`logicalBatchToContentId`);
     *     4. ECDSA cryptographic authorization signed by the registered issuer over supplied fields.
     * - Fields omitted from calldata (issuerId string, schemaVersion, institutionBatchNumber) are
     *   validated off-chain by the publisher and downstream verifier; the contract does not recompute
     *   off-chain derivation formulas for omitted string/schema fields.
     * - Local Hardhat EVM execution benchmarks gas and state transitions; it does not prove
     *   production blockchain properties (e.g. MEV, reorgs, censorship, or P2P propagation).
     */
    function registerBatch(
        bytes32 logicalBatchId,
        bytes32 batchContentId,
        bytes32 merkleRoot,
        address issuerAddress,
        uint16 issuerKeyVersion,
        uint32 credentialCount,
        uint64 issuedAt,
        bytes calldata institutionSignature
    ) external {
        // 1. Verify issuer is active
        IssuerInfo memory issuer = issuers[issuerAddress];
        if (!issuer.isActive) revert IssuerNotRegisteredOrInactive();

        // 2. Check duplicate registration
        if (batchesByContentId[batchContentId].status != BatchStatus.NONE) {
            revert BatchAlreadyRegistered();
        }

        // 3. Check for conflicting content with same logicalBatchId
        bytes32 existingContentId = logicalBatchToContentId[logicalBatchId];
        if (existingContentId != bytes32(0) && existingContentId != batchContentId) {
            emit BatchConflictDetected(logicalBatchId, existingContentId, batchContentId, msg.sender);
            revert LogicalBatchConflict();
        }

        // 4. Verify Institutional Signature over Manifest hash
        // Construct canonical message hash
        bytes32 manifestHash = keccak256(
            abi.encode(
                logicalBatchId,
                batchContentId,
                merkleRoot,
                issuerAddress,
                issuerKeyVersion,
                credentialCount,
                issuedAt
            )
        );

        bytes32 ethSignedHash = toEthSignedMessageHash(manifestHash);
        address recovered = recoverSigner(ethSignedHash, institutionSignature);
        if (recovered != issuerAddress) {
            revert InvalidSignature();
        }

        // 5. Store batch record
        batchesByContentId[batchContentId] = BatchRecord({
            logicalBatchId: logicalBatchId,
            batchContentId: batchContentId,
            merkleRoot: merkleRoot,
            issuerAddress: issuerAddress,
            issuerKeyVersion: issuerKeyVersion,
            credentialCount: credentialCount,
            issuedAt: issuedAt,
            registeredAt: uint64(block.timestamp),
            registeredBlockNumber: uint64(block.number),
            status: BatchStatus.ACTIVE
        });

        logicalBatchToContentId[logicalBatchId] = batchContentId;
        totalBatchesRegistered += 1;
        totalCredentialsRegistered += credentialCount;

        emit BatchRegistered(
            logicalBatchId,
            batchContentId,
            merkleRoot,
            issuerAddress,
            credentialCount,
            uint64(block.number)
        );
    }

    /**
     * @notice Direct registration without signature when caller is the registered issuer directly
     */
    function registerBatchDirect(
        bytes32 logicalBatchId,
        bytes32 batchContentId,
        bytes32 merkleRoot,
        uint16 issuerKeyVersion,
        uint32 credentialCount,
        uint64 issuedAt
    ) external {
        address issuerAddress = msg.sender;
        IssuerInfo memory issuer = issuers[issuerAddress];
        if (!issuer.isActive) revert IssuerNotRegisteredOrInactive();

        if (batchesByContentId[batchContentId].status != BatchStatus.NONE) {
            revert BatchAlreadyRegistered();
        }

        bytes32 existingContentId = logicalBatchToContentId[logicalBatchId];
        if (existingContentId != bytes32(0) && existingContentId != batchContentId) {
            emit BatchConflictDetected(logicalBatchId, existingContentId, batchContentId, msg.sender);
            revert LogicalBatchConflict();
        }

        batchesByContentId[batchContentId] = BatchRecord({
            logicalBatchId: logicalBatchId,
            batchContentId: batchContentId,
            merkleRoot: merkleRoot,
            issuerAddress: issuerAddress,
            issuerKeyVersion: issuerKeyVersion,
            credentialCount: credentialCount,
            issuedAt: issuedAt,
            registeredAt: uint64(block.timestamp),
            registeredBlockNumber: uint64(block.number),
            status: BatchStatus.ACTIVE
        });

        logicalBatchToContentId[logicalBatchId] = batchContentId;
        totalBatchesRegistered += 1;
        totalCredentialsRegistered += credentialCount;

        emit BatchRegistered(
            logicalBatchId,
            batchContentId,
            merkleRoot,
            issuerAddress,
            credentialCount,
            uint64(block.number)
        );
    }

    /**
     * @notice Revoke a batch (only callable by the issuing institution or contract owner)
     */
    function revokeBatch(
        bytes32 batchContentId,
        string calldata reason
    ) external {
        BatchRecord storage record = batchesByContentId[batchContentId];
        if (record.status == BatchStatus.NONE) revert BatchNotFound();
        if (record.status == BatchStatus.REVOKED) revert BatchAlreadyRevoked();

        if (msg.sender != record.issuerAddress && msg.sender != owner) {
            revert Unauthorized();
        }

        record.status = BatchStatus.REVOKED;

        emit BatchRevoked(
            record.logicalBatchId,
            batchContentId,
            record.issuerAddress,
            reason,
            uint64(block.timestamp)
        );
    }

    /**
     * @notice View function to get batch record by content ID
     */
    function getBatch(bytes32 batchContentId) external view returns (BatchRecord memory) {
        return batchesByContentId[batchContentId];
    }

    /**
     * @notice View function to get batch record by logical batch ID
     */
    function getBatchByLogicalId(bytes32 logicalBatchId) external view returns (BatchRecord memory) {
        bytes32 contentId = logicalBatchToContentId[logicalBatchId];
        return batchesByContentId[contentId];
    }

    /**
     * @notice Verification query: checks if a batch root is active on-chain
     */
    function isBatchActive(bytes32 batchContentId) external view returns (bool, bytes32, uint64) {
        BatchRecord memory record = batchesByContentId[batchContentId];
        if (record.status == BatchStatus.ACTIVE) {
            return (true, record.merkleRoot, record.registeredBlockNumber);
        }
        return (false, bytes32(0), 0);
    }

    /**
     * @dev Internal helper to recover signer from signature
     */
    function recoverSigner(bytes32 ethSignedMessageHash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) {
            return address(0);
        }
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        // Common signature format: v in {27, 28} and canonical (low) s, identical to the off-chain verifier.
        if (v != 27 && v != 28) {
            return address(0);
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(ethSignedMessageHash, v, r, s);
    }
}
