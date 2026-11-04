/**
 * Fault C1: Sole Log Omission & Unavailability Controller
 * Invokes the administrative endpoints on Log C1 Primary (Port 9001).
 */
export async function setC1Fault(fault: {
  unavailable?: boolean;
  acknowledgeButOmit?: boolean;
  staleCheckpointAgeSec?: number;
  readUnavailable?: boolean;
}, logUrl: string = "http://127.0.0.1:9001") {
  console.log(`[Fault C1] Sending fault configuration to ${logUrl}/v1/admin/fault...`, fault);
  const res = await fetch(`${logUrl}/v1/admin/fault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fault),
  });
  const data = await res.json();
  console.log(`[Fault C1] Response:`, data);
  return data;
}

export async function resetC1(logUrl: string = "http://127.0.0.1:9001") {
  await fetch(`${logUrl}/v1/admin/reset`, { method: "POST" });
  await fetch(`${logUrl}/v1/admin/fault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`[Fault C1] Reset completed.`);
}

if (process.argv[1]?.includes("fault-c1-omission")) {
  setC1Fault({ acknowledgeButOmit: true, staleCheckpointAgeSec: 600 }).catch(console.error);
}

