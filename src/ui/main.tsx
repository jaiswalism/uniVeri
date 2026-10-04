if (typeof window !== "undefined") {
  (window as any).global = window;
  if (!(window as any).process) {
    (window as any).process = { env: {} };
  }
  if (!(window as any).Buffer) {
    (window as any).Buffer = {
      byteLength: (str: string) => new TextEncoder().encode(str).length,
      from: (data: any) => new Uint8Array(data),
      isBuffer: () => false,
    };
  }
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
