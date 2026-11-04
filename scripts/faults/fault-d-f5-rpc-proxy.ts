import http from "http";
import net from "net";

/**
 * Fault D-F5: RPC Proxy Outage / Network Drop
 * A high-performance intercepting proxy running between the client and Besu.
 * Supports programmable faults:
 *  - connectionDrop: immediately destroys client socket (ECONNRESET)
 *  - connectionRefusal: refuses HTTP connections (503 / socket close)
 *  - latencyJitter: injects configurable latency before forwarding
 */
export class BesuRpcProxy {
  private server: http.Server | null = null;
  public faultState = {
    dropConnections: false,
    refuseConnections: false,
    latencyMs: 0,
  };

  constructor(
    public readonly proxyPort: number = 8547,
    public readonly targetHost: string = "127.0.0.1",
    public readonly targetPort: number = 8545
  ) {}

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (this.faultState.refuseConnections) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "RPC proxy: service unavailable (controlled fault D-F5)" }));
          return;
        }

        if (this.faultState.dropConnections) {
          req.socket.destroy();
          return;
        }

        const forward = () => {
          const proxyReq = http.request(
            {
              host: this.targetHost,
              port: this.targetPort,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
              proxyRes.pipe(res, { end: true });
            }
          );

          proxyReq.on("error", (err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Proxy forwarding error: " + err.message }));
          });

          req.pipe(proxyReq, { end: true });
        };

        if (this.faultState.latencyMs > 0) {
          setTimeout(forward, this.faultState.latencyMs);
        } else {
          forward();
        }
      });

      this.server.listen(this.proxyPort, "0.0.0.0", () => {
        console.log(`[Fault D-F5 Proxy] Listening on port ${this.proxyPort} -> Target ${this.targetHost}:${this.targetPort}`);
        resolve();
      });
    });
  }

  public setFault(fault: Partial<typeof this.faultState>) {
    Object.assign(this.faultState, fault);
    console.log(`[Fault D-F5 Proxy] Updated fault state:`, this.faultState);
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

if (process.argv[1]?.includes("fault-d-f5-rpc-proxy")) {
  const proxy = new BesuRpcProxy();
  proxy.start().then(() => {
    console.log("Press Ctrl+C to terminate proxy.");
  });
}

