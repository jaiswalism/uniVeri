import express, { Request, Response } from "express";
import cors from "cors";
import { TransparencyLogEngine, LogFailureOptions } from "../../src/services/transparency-log/log-engine.js";
import { SignedBatchManifest } from "../../src/core/types.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const LOG_ID = process.env.LOG_ID || "LOG_STANDALONE";
const PORT = parseInt(process.env.PORT || "9000", 10);
const OPERATOR_KEY = process.env.OPERATOR_KEY || undefined;

const engine = new TransparencyLogEngine(LOG_ID, OPERATOR_KEY);

console.log(`[Log Daemon] Initializing ${LOG_ID} with operator address: ${engine.getOperatorAddress()}`);

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    logId: engine.logId,
    operatorAddress: engine.getOperatorAddress(),
  });
});

// POST /v1/manifests
app.post("/v1/manifests", async (req: Request, res: Response) => {
  try {
    const signedManifest: SignedBatchManifest = req.body.signedManifest || req.body;
    if (!signedManifest || !signedManifest.manifest) {
      return res.status(400).json({ error: "Invalid payload: missing signedManifest" });
    }
    const receipt = await engine.submitManifest(signedManifest);
    return res.status(200).json(receipt);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      return res.status(503).json({ error: msg });
    }
    return res.status(400).json({ error: msg });
  }
});

// GET /v1/proofs/:batchContentId
app.get("/v1/proofs/:batchContentId", async (req: Request, res: Response) => {
  try {
    const { batchContentId } = req.params;
    const proof = await engine.getInclusionProof(batchContentId);
    if (!proof) {
      return res.status(404).json({ error: `Inclusion proof not found or omitted for ${batchContentId}` });
    }
    return res.status(200).json(proof);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      return res.status(503).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

// GET /v1/checkpoint
app.get("/v1/checkpoint", async (_req: Request, res: Response) => {
  try {
    const checkpoint = await engine.getLatestCheckpoint();
    return res.status(200).json(checkpoint);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      return res.status(503).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

// GET /v1/status/:batchContentId
app.get("/v1/status/:batchContentId", async (req: Request, res: Response) => {
  try {
    const { batchContentId } = req.params;
    const status = await engine.getStatusObservation(batchContentId);
    return res.status(200).json(status);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      return res.status(503).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
});

// POST /v1/admin/fault
app.post("/v1/admin/fault", (req: Request, res: Response) => {
  const options: LogFailureOptions = req.body;
  engine.setFailureOptions(options);
  console.log(`[Log Daemon ${LOG_ID}] Updated failure options:`, options);
  return res.status(200).json({ status: "ok", activeFaults: engine.getFailureOptions() });
});

// POST /v1/admin/reset
app.post("/v1/admin/reset", (_req: Request, res: Response) => {
  engine.reset();
  console.log(`[Log Daemon ${LOG_ID}] State reset.`);
  return res.status(200).json({ status: "ok", message: "Log state cleared" });
});

// GET /v1/metrics
app.get("/v1/metrics", (_req: Request, res: Response) => {
  const accounting = engine.getStorageAccounting();
  return res.status(200).json(accounting);
});

// Start listening
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Log Daemon ${LOG_ID}] Listening on http://0.0.0.0:${PORT}`);
  });
}

export default app;

