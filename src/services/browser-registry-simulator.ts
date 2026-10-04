import { ethers, keccak256, toUtf8Bytes, AbiCoder } from "ethers";
import { DEvidence, DRegistryStatus } from "../core/types";

export interface BrowserSimulatorConfig {
  endpointUnavailable?: boolean;
  delayMs?: number;
}

export class BrowserRegistrySimulator {
  private batches = new Map<string, any>();
  private logicalToContent = new Map<string, string>();
  private receipts = new Map<string, any>();
  private currentBlock = 1000;
  public config: BrowserSimulatorConfig = {};
  public readonly contractAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  public readonly chainId = 31337n;

  constructor(config: BrowserSimulatorConfig = {}) {
    this.config = { ...config };
  }

  public reset(): void {
    this.batches.clear();
    this.logicalToContent.clear();
    this.receipts.clear();
    this.currentBlock = 1000;
  }

  public getContract(): any {
    return {
      getAddress: async () => this.contractAddress,
      registerBatch: async (
        logicalBatchId: string,
        batchContentId: string,
        merkleRoot: string,
        issuerAddress: string,
        issuerKeyVersion: number,
        credentialCount: number,
        issuedAt: number,
        institutionSignature: string
      ) => {
        if (this.config.endpointUnavailable) {
          throw new Error("RPC node endpoint UNAVAILABLE (503 Service Unavailable) [Simulated Fault]");
        }
        if (this.config.delayMs && this.config.delayMs > 0) {
          await new Promise((r) => setTimeout(r, this.config.delayMs));
        }

        if (this.batches.has(batchContentId)) {
          throw new Error("BatchAlreadyRegistered");
        }
        const existing = this.logicalToContent.get(logicalBatchId);
        if (existing && existing !== batchContentId) {
          throw new Error("LogicalBatchConflict");
        }

        this.currentBlock++;
        const txHash = "0x" + keccak256(toUtf8Bytes(`${batchContentId}-${this.currentBlock}-${Date.now()}`)).slice(2);
        const blockHash = "0x" + keccak256(toUtf8Bytes(`block-${this.currentBlock}`)).slice(2);
        const registeredAt = Math.floor(Date.now() / 1000);

        const record = {
          logicalBatchId,
          batchContentId,
          merkleRoot,
          issuerAddress,
          issuerKeyVersion,
          credentialCount,
          issuedAt,
          registeredAt,
          registeredBlockNumber: this.currentBlock,
          status: 1, // 1 = ACTIVE
        };

        this.batches.set(batchContentId, record);
        this.logicalToContent.set(logicalBatchId, batchContentId);

        // BatchRegistered event: 4 topics (128 bytes) + 96 bytes data = 224 bytes receipt log
        const eventSignature = keccak256(toUtf8Bytes("BatchRegistered(bytes32,bytes32,bytes32,address)"));
        const issuerTopic = ethers.zeroPadValue(issuerAddress, 32);
        const dataPayload = AbiCoder.defaultAbiCoder().encode(
          ["uint32", "uint32", "uint256"],
          [issuerKeyVersion, credentialCount, registeredAt]
        );

        const receipt = {
          hash: txHash,
          blockNumber: this.currentBlock,
          blockHash,
          gasUsed: 183624n, // Measured transaction-level allocation from benchmark traces
          status: 1,
          logs: [
            {
              address: this.contractAddress,
              topics: [eventSignature, logicalBatchId, batchContentId, issuerTopic],
              data: dataPayload,
            },
          ],
        };

        this.receipts.set(txHash, receipt);

        // Calldata hex string (~289 bytes)
        const mockCalldata = "0x" + "aa".repeat(289);
        return {
          hash: txHash,
          data: mockCalldata,
        };
      },

      getBatch: async (batchContentId: string, opts?: { blockTag?: number }) => {
        if (this.config.endpointUnavailable) {
          throw new Error("RPC read endpoint UNAVAILABLE [Simulated Fault]");
        }
        const record = this.batches.get(batchContentId);
        if (!record) {
          throw new Error("BatchNotFound");
        }
        return record;
      },
    };
  }

  public getProvider(): any {
    return {
      getNetwork: async () => ({ chainId: this.chainId }),
      getBlockNumber: async () => this.currentBlock,
      getBlock: async (blockNumber: number) => ({
        number: blockNumber,
        hash: "0x" + keccak256(toUtf8Bytes(`block-${blockNumber}`)).slice(2),
        timestamp: Math.floor(Date.now() / 1000),
      }),
      getTransactionReceipt: async (txHash: string) => {
        if (this.config.endpointUnavailable) {
          throw new Error("RPC node endpoint UNAVAILABLE [Simulated Fault]");
        }
        return this.receipts.get(txHash) || null;
      },
    };
  }

  public getAdapter(): any {
    const contract = this.getContract();
    const provider = this.getProvider();
    return {
      getConfirmationDepth: () => 1,
      getContractAddress: async () => this.contractAddress,
      getChainId: async () => Number(this.chainId),
      readEvidence: async (batchContentId: string, opts: { blockNumber?: number } = {}): Promise<DEvidence> => {
        const head = await provider.getBlockNumber();
        const block = opts.blockNumber ?? head;
        const [rec, blockObj, chainId, address] = await Promise.all([
          contract.getBatch(batchContentId, { blockTag: block }),
          provider.getBlock(block),
          provider.getNetwork().then((n: any) => Number(n.chainId)),
          contract.getAddress(),
        ]);
        const statusNum = Number(rec.status);
        const status: DRegistryStatus = statusNum === 1 ? "ACTIVE" : statusNum === 2 ? "REVOKED" : "NONE";
        return {
          architecture: "D",
          chainId,
          contractAddress: address,
          record: {
            logicalBatchId: rec.logicalBatchId,
            batchContentId: rec.batchContentId,
            merkleRoot: rec.merkleRoot,
            issuerAddress: rec.issuerAddress,
            issuerKeyVersion: Number(rec.issuerKeyVersion),
            credentialCount: Number(rec.credentialCount),
            issuedAt: Number(rec.issuedAt),
          },
          status,
          registeredBlockNumber: Number(rec.registeredBlockNumber),
          observedBlockNumber: block,
          observedBlockHash: blockObj.hash,
          observedBlockTimestamp: blockObj.timestamp,
          headBlockNumberAtRead: head,
          retrievedAt: Math.floor(Date.now() / 1000),
        };
      },
    };
  }
}

