import { Contract, Provider } from "ethers";
import { DEvidence, DRegistryStatus } from "../core/types.js";

/**
 * Faults injectable into the READ path of the trusted retrieval adapter.
 * (Submission-path faults are injected on the signer/runner used for transactions, see FaultInjectingRunner.)
 */
export interface RegistryReadFaults {
  /** The read RPC endpoint is unreachable. */
  readUnavailable?: boolean;
  /** The endpoint serves state from N blocks behind its head (stale response). */
  staleLagBlocks?: number;
}

/**
 * Trusted retrieval adapter for Architecture D. It performs a read of the CONFIGURED registry contract at an
 * EXPLICIT block (blockTag) and reports chain id, block number/hash, head at read time and the on-chain record.
 * Transport: in-process ethers provider talking to the in-process Hardhat network (no HTTP hop).
 */
export class RegistryRetrievalAdapter {
  public faults: RegistryReadFaults = {};

  constructor(
    private readonly contract: Contract,
    private readonly provider: Provider,
    private readonly confirmationDepth = 1
  ) {}

  public getConfirmationDepth(): number {
    return this.confirmationDepth;
  }

  public async getContractAddress(): Promise<string> {
    return this.contract.getAddress();
  }

  public async getChainId(): Promise<number> {
    return Number((await this.provider.getNetwork()).chainId);
  }

  /**
   * Reads the registry record for batchContentId at `blockNumber` (default: the deepest block that satisfies
   * the confirmation rule, i.e. head - (confirmationDepth - 1)).
   */
  public async readEvidence(
    batchContentId: string,
    opts: { blockNumber?: number } = {}
  ): Promise<DEvidence> {
    if (this.faults.readUnavailable) {
      throw new Error("RPC read endpoint UNAVAILABLE (ECONNREFUSED) [injected read-path outage]");
    }
    const head = await this.provider.getBlockNumber();
    let block = opts.blockNumber ?? head - (this.confirmationDepth - 1);
    if (this.faults.staleLagBlocks && this.faults.staleLagBlocks > 0) {
      block = Math.max(0, head - this.faults.staleLagBlocks);
    }
    const [rec, blockObj, chainId, address] = await Promise.all([
      this.contract.getBatch(batchContentId, { blockTag: block }),
      this.provider.getBlock(block),
      this.getChainId(),
      this.contract.getAddress(),
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
      observedBlockHash: blockObj?.hash ?? "",
      observedBlockTimestamp: blockObj ? Number(blockObj.timestamp) : 0,
      headBlockNumberAtRead: head,
      retrievedAt: Math.floor(Date.now() / 1000),
    };
  }
}

/**
 * Wraps a signer so that the transaction-submission path can be made unreachable while the read path stays up.
 * It does NOT model production-chain censorship; it measures dependence on the submission endpoint only.
 */
export function createFaultInjectingRunner<T extends object>(signer: T, state: { submitUnavailable: boolean }): T {
  return new Proxy(signer, {
    get(target: any, prop: string | symbol) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      if (state.submitUnavailable && (prop === "sendTransaction" || prop === "sendUncheckedTransaction")) {
        return async () => {
          throw new Error("RPC submission endpoint UNAVAILABLE (ECONNREFUSED) [injected write-path outage]");
        };
      }
      return value.bind(target);
    },
  });
}
