"use client";
import { useState } from "react";
import { copyText } from "@/lib/clipboard";
export function ExportButtons({ oul, title }: { oul: string; title: string }) {
  const [message, setMessage] = useState("");
  const copy = async () => {
    try {
      const sql = [...document.querySelectorAll<HTMLElement>("#report pre.sql")]
        .map((p) => p.textContent)
        .join("\n\n");
      await copyText(`${title}\n\n${sql || oul}`);
      setMessage("Copied");
    } catch {
      setMessage("Select the report text and copy it manually.");
    }
  };
  return (
    <div
      className="toolbar no-print"
      style={{ display: "flex", gap: "var(--qai-space-s)" }}
    >
      <button className="btn" onClick={copy}>
        Copy
      </button>
      <button className="btn" onClick={() => window.print()}>
        Export to PDF
      </button>
      <span role="status">{message}</span>
    </div>
  );
}
