import Link from "next/link";
import { listAnalyses } from "@/lib/db";
import { HistoryItem } from "./history-item";

export function Rail({ userId }: { userId: string }) {
  const rows = listAnalyses(userId);
  return (
    <>
      <Link
        href="/app"
        className="label"
        style={{ textDecoration: "none", color: "var(--qai-accent)" }}
      >
        qAI
      </Link>
      <p className="label">History · {rows.length}</p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gap: "var(--qai-space-s)",
        }}
      >
        {rows.map((r) => (
          <HistoryItem key={r.id} row={r} />
        ))}
      </ul>
      <p className="label" style={{ marginTop: "auto" }}>
        <Link href="/settings" style={{ color: "var(--qai-ink-muted)" }}>
          Settings
        </Link>
      </p>
    </>
  );
}
