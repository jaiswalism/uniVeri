/**
 * Fault C2: Log Alpha Outage / Omission Controller
 * Injects faults into Log Alpha (Port 9002) while Beta (9003) & Gamma (9004) maintain 2-of-3 quorum.
 */
export async function setC2AlphaFault(fault: {
  unavailable?: boolean;
  acknowledgeButOmit?: boolean;
  readOmitProof?: boolean;
  readOmitStatus?: boolean;
}, alphaUrl: string = "http://127.0.0.1:9002") {
  console.log(`[Fault C2] Sending fault configuration to Log Alpha (${alphaUrl}/v1/admin/fault)...`, fault);
  const res = await fetch(`${alphaUrl}/v1/admin/fault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fault),
  });
  const data = await res.json();
  console.log(`[Fault C2] Alpha response:`, data);
  return data;
}

export async function resetC2Cluster(urls = [
  "http://127.0.0.1:9002",
  "http://127.0.0.1:9003",
  "http://127.0.0.1:9004",
]) {
  for (const url of urls) {
    await fetch(`${url}/v1/admin/reset`, { method: "POST" });
    await fetch(`${url}/v1/admin/fault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }
  console.log(`[Fault C2] Cluster reset completed.`);
}

if (process.argv[1]?.includes("fault-c2-quorum-failure")) {
  setC2AlphaFault({ unavailable: true }).catch(console.error);
}

