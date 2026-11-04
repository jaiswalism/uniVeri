import {
  LogInclusionProof,
  LogStatusObservation,
  SignedBatchManifest,
  SignedTreeCheckpoint,
} from "../../core/types.js";
import { LogFailureOptions, LogStorageAccounting } from "./log-engine.js";

/**
 * HttpLogEngineClient: Communicates with standalone Log Daemon over genuine HTTP REST.
 * Matches the TransparencyLogEngine interface so it can be passed to Publisher and Verifier.
 */
export class HttpLogEngineClient {
  public readonly logId: string;
  public readonly baseUrl: string;
  private operatorAddressCache: string | null = null;

  constructor(logId: string, baseUrl: string, operatorAddress?: string) {
    this.logId = logId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    if (operatorAddress) this.operatorAddressCache = operatorAddress;
  }

  public getOperatorAddress(): string {
    return this.operatorAddressCache || "0x0000000000000000000000000000000000000000";
  }

  public setOperatorAddress(address: string): void {
    this.operatorAddressCache = address;
  }

  public async init(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.operatorAddress) {
          this.operatorAddressCache = data.operatorAddress;
        }
      }
    } catch {}
  }

  public async submitManifest(signedManifest: SignedBatchManifest): Promise<{
    entryIndex: number;
    acknowledgedAtMs: number;
    omitted: boolean;
  }> {
    const res = await fetch(`${this.baseUrl}/v1/manifests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedManifest),
    });

    if (res.status === 503) {
      throw new Error(`Log ${this.logId} is currently UNAVAILABLE (HTTP 503) [write path]`);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    return await res.json();
  }

  public async getInclusionProof(batchContentId: string): Promise<LogInclusionProof | null> {
    const res = await fetch(`${this.baseUrl}/v1/proofs/${batchContentId}`);
    if (res.status === 503) {
      throw new Error(`Log ${this.logId} is UNAVAILABLE (HTTP 503) [read path]`);
    }
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  }

  public async getLatestCheckpoint(): Promise<SignedTreeCheckpoint> {
    const res = await fetch(`${this.baseUrl}/v1/checkpoint`);
    if (res.status === 503) {
      throw new Error(`Log ${this.logId} is UNAVAILABLE (HTTP 503) [read path]`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  }

  public async getStatusObservation(batchContentId: string): Promise<LogStatusObservation> {
    const res = await fetch(`${this.baseUrl}/v1/status/${batchContentId}`);
    if (res.status === 503) {
      throw new Error(`Log ${this.logId} is UNAVAILABLE (HTTP 503) [read path]`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  }

  public async setFailureOptions(options: LogFailureOptions): Promise<void> {
    await fetch(`${this.baseUrl}/v1/admin/fault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
  }

  public async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/v1/admin/reset`, { method: "POST" });
  }

  public async getStorageAccounting(): Promise<LogStorageAccounting> {
    const res = await fetch(`${this.baseUrl}/v1/metrics`);
    if (!res.ok) {
      return {
        entryCount: 0,
        checkpointCount: 0,
        entriesSerializedBytes: 0,
        checkpointsSerializedBytes: 0,
        totalSerializedBytes: 0,
      };
    }
    return await res.json();
  }
}

