import { ethers } from "ethers";
import { execSync } from "child_process";

/**
 * Fault D-F2b: QBFT Active Proposer Stop / View-Change Failover
 * Calculates the current QBFT proposer: ProposerIndex = (blockNumber + round) % N
 * and stops / pauses that validator container to force a consensus round-change.
 */
export async function triggerProposerStop(opts: {
  rpcUrl?: string;
  validatorCount?: number;
  action?: "stop" | "pause";
  resumeAfterMs?: number;
} = {}) {
  const rpcUrl = opts.rpcUrl || "http://127.0.0.1:8545";
  const N = opts.validatorCount || 4;
  const action = opts.action || "pause";
  const resumeAfterMs = opts.resumeAfterMs || 5000;

  console.log(`[Fault D-F2b] Connecting to Besu RPC at ${rpcUrl}...`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const blockNumber = await provider.getBlockNumber();
  const targetIndex = (blockNumber + 1) % N; // Proposer for next block/round (0-indexed)
  const containerName = `besu-node-${targetIndex + 1}`;

  console.log(`[Fault D-F2b] Current block: ${blockNumber}`);
  console.log(`[Fault D-F2b] Calculated upcoming QBFT proposer: Index ${targetIndex} -> Container: ${containerName}`);
  console.log(`[Fault D-F2b] Executing docker ${action} on ${containerName}...`);

  try {
    execSync(`docker ${action} ${containerName}`, { stdio: "inherit" });
    console.log(`[Fault D-F2b] Proposer ${containerName} is now ${action}d. Consensus round-change induced.`);

    if (resumeAfterMs > 0) {
      console.log(`[Fault D-F2b] Waiting ${resumeAfterMs}ms before restoring proposer...`);
      await new Promise((r) => setTimeout(r, resumeAfterMs));
      const restoreCmd = action === "pause" ? "unpause" : "start";
      execSync(`docker ${restoreCmd} ${containerName}`, { stdio: "inherit" });
      console.log(`[Fault D-F2b] Proposer ${containerName} restored.`);
    }
  } catch (err: any) {
    console.error(`[Fault D-F2b] Docker command failed:`, err?.message || err);
  }

  return { blockNumber, targetIndex, containerName, action };
}

if (process.argv[1]?.includes("fault-d-f2b-stop-proposer")) {
  triggerProposerStop().catch(console.error);
}

