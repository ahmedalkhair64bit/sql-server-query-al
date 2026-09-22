"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { rename, remove } from "@/lib/actions";
import type { HistoryRow } from "./workspace";
import { Icon } from "./icons";
export function HistoryItem({ row }: { row: HistoryRow }) {
  const path = usePathname(),
    router = useRouter();
  return (
    <li className={`history-item ${path === `/app/${row.id}` ? "active" : ""}`}>
      <Link
        href={`/app/${row.id}`}
        className="history-link"
        aria-current={path === `/app/${row.id}` ? "page" : undefined}
      >
        <Icon name="file" size={17} />
        <span>{row.title}</span>
        {row.status !== "done" && (
          <span className="status-dot" title={row.status} />
        )}
      </Link>
      <details className="history-actions">
        <summary aria-label={`Manage ${row.title}`}>···</summary>
        <div className="history-menu">
          <form
            action={async (fd) => {
              await rename(null, fd);
              router.refresh();
            }}
          >
            <input type="hidden" name="id" value={row.id} />
            <label>
              Analysis name
              <input
                className="field"
                name="title"
                aria-label="New name"
                defaultValue={row.title}
                maxLength={120}
              />
            </label>
            <button className="btn">Save</button>
          </form>
          <form
            action={async (fd) => {
              await remove(null, fd);
              if (path === `/app/${row.id}`) router.push("/app");
              router.refresh();
            }}
            onSubmit={(e) => {
              if (!confirm("Delete this analysis?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={row.id} />
            <button className="btn danger-text">Delete</button>
          </form>
        </div>
      </details>
    </li>
  );
}
