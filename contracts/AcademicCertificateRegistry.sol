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
        uint256 issuerKeyVersion;
        uint256 credentialCount;
        uint256 issuedAt;
        uint256 registeredAt;
        uint256 registeredBlockNumber;
        BatchStatus status;
    }

    struct IssuerInfo {
        string issuerId;
        address signingAddress;
        bool isActive;
        uint256 registeredAt;
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
        uint256 credentialCount,
        uint256 issuedAt
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
        uint256 revokedAt
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
            registeredAt: block.timestamp
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
     * @notice Permissionless batch registration with on-chain admission control.
     * Anyone (independent publisher) can submit, provided the manifest payload passes admission checks.
     */
    function registerBatch(
        bytes32 logicalBatchId,
        bytes32 batchContentId,
        bytes32 merkleRoot,
        address issuerAddress,
        uint256 issuerKeyVersion,
        uint256 credentialCount,
        uint256 issuedAt,
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
            registeredAt: block.timestamp,
            registeredBlockNumber: block.number,
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
            issuedAt
        );
    }

    /**
     * @notice Direct registration without signature when caller is the registered issuer directly
     */
    function registerBatchDirect(
        bytes32 logicalBatchId,
        bytes32 batchContentId,
        bytes32 merkleRoot,
        uint256 issuerKeyVersion,
        uint256 credentialCount,
        uint256 issuedAt
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
            registeredAt: block.timestamp,
            registeredBlockNumber: block.number,
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
            issuedAt
        );
    }

    /**
     * @notice Revoke a batch via institutional signature or direct authorized caller
     */
    function revokeBatch(
        bytes32 logicalBatchId,
        bytes32 batchContentId,
        bytes calldata revocationSignature
    ) external {
        BatchRecord storage record = batchesByContentId[batchContentId];
        if (record.status == BatchStatus.NONE) revert BatchNotFound();
        if (record.status == BatchStatus.REVOKED) revert BatchAlreadyRevoked();

        // Verify authorization: caller must be issuer, owner, or provide valid issuer signature
        if (msg.sender != record.issuerAddress && msg.sender != owner) {
            bytes32 revokeHash = toEthSignedMessageHash(
                keccak256(abi.encode("REVOKE", logicalBatchId, batchContentId))
            );
            address recovered = recoverSigner(revokeHash, revocationSignature);
            if (recovered != record.issuerAddress) {
                revert Unauthorized();
            }
        }

        record.status = BatchStatus.REVOKED;

        emit BatchRevoked(
            logicalBatchId,
            batchContentId,
            record.issuerAddress,
            "INSTITUTIONAL_REVOCATION",
            block.timestamp
        );
    }

    /**
     * @notice Direct revocation by issuer or owner with reason string
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
            block.timestamp
        );
    }

    /**
     * @notice View function to get batch record by content ID
     */
    function getBatch(bytes32 batchContentId) external view returns (BatchRecord memory) {
        return batchesByContentId[batchContentId];
    }

    /**
     * @notice Checks whether a batch is active and returns root and block
     */
    function isBatchActive(bytes32 batchContentId) external view returns (
        bool active,
        bytes32 merkleRoot,
        uint256 blockNumber
    ) {
        BatchRecord memory record = batchesByContentId[batchContentId];
        return (
            record.status == BatchStatus.ACTIVE,
            record.merkleRoot,
            record.registeredBlockNumber
        );
    }

    /**
     * @dev Internal helper to recover signer from signature
     */
    function recoverSigner(bytes32 ethSignedHash, bytes memory sig) internal pure returns (address) {
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

        if (v < 27) {
            v += 27;
        }

        if (v != 27 && v != 28) {
            return address(0);
        }

        return ecrecover(ethSignedHash, v, r, s);
    }
}
