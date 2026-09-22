"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HistoryItem } from "./history-item";
import { Icon } from "./icons";
import { signOut } from "@/lib/actions";
import gsap from "gsap";
const subscribeTheme = (callback: () => void) => {
  window.addEventListener("qai-theme", callback);
  return () => window.removeEventListener("qai-theme", callback);
};
export type HistoryRow = {
  id: string;
  title: string;
  status: string;
  created_at: number;
};
export function Workspace({
  rows,
  children,
}: {
  rows: HistoryRow[];
  children: React.ReactNode;
}) {
  const path = usePathname();
  const [openPath, setOpenPath] = useState<string | null>(null),
    [collapsed, setCollapsed] = useState(false),
    [search, setSearch] = useState("");
  const open = openPath === path;
  const setOpen = (value: boolean) => setOpenPath(value ? path : null);
  const dark = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );
  const drawer = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const stored = localStorage.getItem("qai-theme");
    const value = stored
      ? stored === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = value ? "dark" : "light";
    window.dispatchEvent(new Event("qai-theme"));
  }, []);
  useEffect(() => {
    if (!open) return;
    const el = drawer.current;
    const previous = document.activeElement as HTMLElement;
    const focus = el?.querySelector<HTMLElement>("button,a,input");
    focus?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenPath(null);
        toggle.current?.focus();
      }
      if (e.key === "Tab" && el) {
        const items = [
          ...el.querySelectorAll<HTMLElement>("button,a,input"),
        ].filter((x) => x.offsetParent !== null);
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [open]);
  function theme() {
    const next = !dark;
    document.documentElement.dataset.theme = next ? "dark" : "light";
    localStorage.setItem("qai-theme", next ? "dark" : "light");
    window.dispatchEvent(new Event("qai-theme"));
  }
  function collapse() {
    setCollapsed(!collapsed);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
      gsap.fromTo(
        ".workspace-main",
        { opacity: 0.65 },
        { opacity: 1, duration: 0.2 },
      );
  }
  const filtered = rows.filter((r) =>
    r.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div
      className={`shell ${collapsed ? "is-collapsed" : ""} ${open ? "drawer-open" : ""}`}
    >
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      {open && (
        <button
          className="drawer-scrim"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={drawer}
        className="rail no-print"
        aria-label="Previous analyses"
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
      >
        <div className="rail-brand">
          <Link href="/app" className="brand">
            <span className="logo-mark">
              <Image src="/brand/logo.png" alt="" width={74} height={74} />
            </span>
            <span>
              Query<span className="brand-ai">AI</span>
              <small>SQL SERVER WORKSPACE</small>
            </span>
          </Link>
          <button
            className="icon-btn mobile-only"
            aria-label="Close sidebar"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <Link
          className="new-analysis"
          href="/app"
          onClick={() => window.dispatchEvent(new Event("qai-new-analysis"))}
        >
          <Icon name="plus" />
          New analysis<kbd>＋</kbd>
        </Link>
        <label className="history-search">
          <Icon name="search" size={17} />
          <input
            aria-label="Search history"
            placeholder="Search analyses"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="history-heading">
          Your analyses<span>{rows.length}</span>
        </div>
        <ul className="history-list">
          {filtered.map((row) => (
            <HistoryItem key={row.id} row={row} />
          ))}
          {!filtered.length && (
            <li className="history-empty">
              {search
                ? "No matching analyses."
                : "Your saved analyses will appear here."}
            </li>
          )}
        </ul>
        <div className="rail-footer">
          <Link
            href="/settings"
            className={`nav-row ${path === "/settings" ? "active" : ""}`}
          >
            <Icon name="settings" />
            Settings
          </Link>
          <button className="nav-row" onClick={theme}>
            <Icon name={dark ? "sun" : "moon"} />
            {dark ? "Light appearance" : "Dark appearance"}
          </button>
          <form action={signOut}>
            <button className="nav-row">
              <Icon name="logout" />
              Sign out
            </button>
          </form>
          <div className="account-line">
            <span className="avatar">Q</span>
            <div>
              Personal workspace<small>Powered by your models</small>
            </div>
            <span className="connection-dot" />
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header no-print">
          <div className="header-left">
            <button
              ref={toggle}
              className="icon-btn mobile-only"
              aria-label="Open sidebar"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <Icon name="panel" />
            </button>
            <button
              className="icon-btn desktop-only"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={collapse}
            >
              <Icon name="panel" />
            </button>
            <span>SQL Server Query AI</span>
            <span className="header-divider">/</span>
            <span className="muted">
              {path === "/settings" ? "Settings" : "Plan analysis"}
            </span>
          </div>
          <span className="model-badge">
            <span className="connection-dot" />
            Jev decision engine
          </span>
        </header>
        <main id="workspace-content" className="main">
          {children}
        </main>
        <footer className="workspace-footer no-print">
          Evidence from your plan. Options from your model. Decisions by Jev.
        </footer>
      </div>
    </div>
  );
}
